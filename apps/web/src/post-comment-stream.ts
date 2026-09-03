import {
  openEventCache,
  type EventCachePosition,
  type OpenEventCacheOptions,
} from './event-cache'
import {
  createEventCursor,
  syncEventLogs,
  type EventCheckpoint,
  type EventCursor,
  type IndexedEventLog,
} from './event-indexer'
import {
  decodePublishedComment,
  PUBLISHED_COMMENT_FILTER,
  type PublishedComment,
} from './protocol-events'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { inspectProtocol } from './protocol'
import {
  beforeDeadline,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

export const POST_COMMENT_EVENT_PAGE_SIZE = 200
export const POST_COMMENT_EVENT_START_BLOCK = 0n

export type PostCommentProjectionAnchor = {
  chainId: bigint
  comments: EventCachePosition
  head: bigint
  safeHead?: bigint
}

export type PostCommentStreamSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  head: bigint
  indexedThrough?: bigint
  projectionAnchor?: PostCommentProjectionAnchor
  recentComments: readonly PublishedComment[]
  safeHead?: bigint
  scannedRanges: number
}

export type PostCommentStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizePostCommentStreamOptions = {
  signal?: AbortSignal
  storage?: PostCommentStreamStorageOptions
}

export type PostCommentStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  options?: SynchronizePostCommentStreamOptions,
) => Promise<PostCommentStreamSnapshot>

function cancelledError() {
  return new Error('Post comment synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

async function requestInContext(
  provider: Eip1193Provider,
  request: ProviderRequest,
  signal: AbortSignal,
) {
  if (signal.aborted) throw cancelledError()
  let handleAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(cancelledError())
    signal.addEventListener('abort', handleAbort, { once: true })
  })
  try {
    const value = await beforeDeadline(
      () => Promise.race([provider.request(request), interrupted]),
      Date.now() + WALLET_READ_TIMEOUT_MS,
      () => new Error('Post comment context read timed out.'),
    )
    if (signal.aborted) throw cancelledError()
    return value
  } finally {
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
  }
}

async function assertSelectedChain(
  provider: Eip1193Provider,
  chainId: bigint,
  signal: AbortSignal,
) {
  const value = await requestInContext(
    provider,
    { method: 'eth_chainId' },
    signal,
  )
  if (parseChainId(value) !== chainId) {
    throw new Error('The post comments belong to a different wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid post comment head.')
  }
  return BigInt(value)
}

async function readSelectedHead(
  provider: Eip1193Provider,
  chainId: bigint,
  signal: AbortSignal,
) {
  const [chainValue, headValue] = await Promise.all([
    requestInContext(provider, { method: 'eth_chainId' }, signal),
    requestInContext(provider, { method: 'eth_blockNumber' }, signal),
  ])
  if (parseChainId(chainValue) !== chainId) {
    throw new Error('The post comments belong to a different wallet chain.')
  }
  return parseHead(headValue)
}

async function assertCanonicalCheckpoint(
  provider: Eip1193Provider,
  checkpoint: EventCheckpoint,
  signal: AbortSignal,
) {
  const value = await requestInContext(
    provider,
    {
      method: 'eth_getBlockByNumber',
      params: [`0x${checkpoint.blockNumber.toString(16)}`, false],
    },
    signal,
  )
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The wallet returned invalid post comment checkpoint data.')
  }
  const block = value as Record<string, unknown>
  const hash = block.hash
  if (
    parseHead(block.number) !== checkpoint.blockNumber ||
    typeof hash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(hash) ||
    hash.toLowerCase() !== checkpoint.blockHash
  ) {
    throw new Error(
      'The confirmed post comment checkpoint changed. Retry the bounded range.',
    )
  }
}

function decodeCommentLogs(logs: readonly IndexedEventLog[]) {
  return logs.map((log) => {
    const comment = decodePublishedComment(log)
    if (!comment) {
      throw new Error('The post comment cache contained another event.')
    }
    return comment
  })
}

function sameCursor(first: EventCursor, second: EventCursor) {
  return (
    first.chainId === second.chainId &&
    first.finalityDepth === second.finalityDepth &&
    first.filterId === second.filterId &&
    first.nextBlock === second.nextBlock &&
    first.rangeSize === second.rangeSize &&
    first.startBlock === second.startBlock &&
    first.checkpoints.length === second.checkpoints.length &&
    first.checkpoints.every(
      (checkpoint, index) =>
        checkpoint.blockHash === second.checkpoints[index]?.blockHash &&
        checkpoint.blockNumber === second.checkpoints[index]?.blockNumber,
    )
  )
}

export const synchronizePostCommentStream: PostCommentStreamSynchronizer =
  async (provider, chainId, options = {}) => {
    const seed = createEventCursor({
      chainId,
      filter: PUBLISHED_COMMENT_FILTER,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: POST_COMMENT_EVENT_START_BLOCK,
    })
    assertActive(options.signal)
    const interruption = new AbortController()
    let contextChanged = false
    const interruptContext = () => {
      contextChanged = true
      interruption.abort()
    }
    const interruptRequest = () => interruption.abort()
    provider.on?.('chainChanged', interruptContext)
    provider.on?.('disconnect', interruptContext)
    options.signal?.addEventListener('abort', interruptRequest, { once: true })
    const assertContextActive = () => {
      assertActive(options.signal)
      if (contextChanged) {
        throw new Error(
          'The wallet chain changed during post comment verification.',
        )
      }
    }
    try {
      await assertSelectedChain(provider, chainId, interruption.signal)
      assertContextActive()
      const inspection = await inspectProtocol(
        provider,
        WALLET_READ_TIMEOUT_MS,
        interruption.signal,
      )
      assertContextActive()
      await assertSelectedChain(provider, chainId, interruption.signal)
      assertContextActive()
      if (inspection.kind !== 'ready') {
        throw new Error(
          'Verified Lifeinvader v1 is required before this chain can provide post comments.',
        )
      }
      const cache = await openEventCache({
        ...options.storage,
        filter: PUBLISHED_COMMENT_FILTER,
      })
      try {
        assertContextActive()
        let before = await cache.readLatest(seed, POST_COMMENT_EVENT_PAGE_SIZE)
        assertContextActive()
        let cacheReset = before.reset
        try {
          decodeCommentLogs(before.logs)
        } catch {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          before = await cache.readLatest(seed, POST_COMMENT_EVENT_PAGE_SIZE)
          assertContextActive()
          cacheReset = true
        }
        const result = await syncEventLogs(
          provider,
          PUBLISHED_COMMENT_FILTER,
          before.cursor,
          { maxRanges: 1, signal: interruption.signal },
        )
        assertContextActive()
        decodeCommentLogs(result.logs)
        await cache.apply(before, result)
        assertContextActive()
        const after = await cache.readLatest(seed, POST_COMMENT_EVENT_PAGE_SIZE)
        assertContextActive()
        if (
          after.generation !== before.generation ||
          after.revision !== before.revision + 1n ||
          !sameCursor(after.cursor, result.cursor)
        ) {
          throw new Error(
            'The post comment cache changed after synchronization. Retry the bounded range.',
          )
        }
        let recentComments: readonly PublishedComment[]
        try {
          recentComments = decodeCommentLogs(after.logs)
        } catch (error) {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          throw error
        }
        const indexedThrough =
          after.cursor.nextBlock > after.cursor.startBlock
            ? after.cursor.nextBlock - 1n
            : undefined
        const finalCheckpoint = after.cursor.checkpoints.at(-1)
        if (finalCheckpoint) {
          await assertCanonicalCheckpoint(
            provider,
            finalCheckpoint,
            interruption.signal,
          )
          assertContextActive()
        }
        const finalHead = await readSelectedHead(
          provider,
          chainId,
          interruption.signal,
        )
        assertContextActive()
        if (
          indexedThrough !== undefined &&
          (finalHead < indexedThrough ||
            finalHead - indexedThrough < POST_FEED_CONFIRMATION_DEPTH)
        ) {
          throw new Error(
            'The wallet head moved behind the confirmed post comments. Retry after the chain stabilizes.',
          )
        }
        if (finalCheckpoint) {
          await assertCanonicalCheckpoint(
            provider,
            finalCheckpoint,
            interruption.signal,
          )
          assertContextActive()
        }
        await assertSelectedChain(provider, chainId, interruption.signal)
        assertContextActive()
        const safeHead =
          finalHead >= POST_FEED_CONFIRMATION_DEPTH
            ? finalHead - POST_FEED_CONFIRMATION_DEPTH
            : undefined
        const caughtUp =
          safeHead === undefined || after.cursor.nextBlock > safeHead
        if (
          caughtUp &&
          safeHead !== undefined &&
          finalCheckpoint?.blockNumber !== safeHead
        ) {
          throw new Error(
            'The post comment stream did not anchor at the confirmed safe head.',
          )
        }
        const position = {
          cursor: after.cursor,
          generation: after.generation,
          revision: after.revision,
        }
        return {
          cacheReset: cacheReset || after.reset,
          caughtUp,
          head: finalHead,
          indexedThrough,
          projectionAnchor: caughtUp
            ? { chainId, comments: position, head: finalHead, safeHead }
            : undefined,
          recentComments,
          safeHead,
          scannedRanges: result.scannedRanges,
        }
      } finally {
        cache.close()
      }
    } catch (error) {
      assertContextActive()
      throw error
    } finally {
      interruption.abort()
      options.signal?.removeEventListener('abort', interruptRequest)
      provider.removeListener?.('chainChanged', interruptContext)
      provider.removeListener?.('disconnect', interruptContext)
    }
  }
