import { openEventCache, type OpenEventCacheOptions } from './event-cache'
import {
  createEventCursor,
  syncEventLogs,
  type EventCheckpoint,
  type EventCursor,
  type IndexedEventLog,
} from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import {
  decodePublishedPost,
  PUBLISHED_POST_FILTER,
  type PublishedPost,
} from './protocol-events'
import { inspectProtocol } from './protocol'
import {
  beforeDeadline,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

const POST_FEED_PAGE_SIZE = 50
const POST_FEED_START_BLOCK = 0n

export type PostFeedSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  head: bigint
  indexedThrough?: bigint
  posts: readonly PublishedPost[]
  safeHead?: bigint
  scannedRanges: number
}

export type PostFeedStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizePostFeedOptions = {
  signal?: AbortSignal
  storage?: PostFeedStorageOptions
}

export type PostFeedSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  options?: SynchronizePostFeedOptions,
) => Promise<PostFeedSnapshot>

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new Error('Post feed synchronization was cancelled.')
}

function contextCancelledError() {
  return new Error('Post feed synchronization was cancelled.')
}

async function requestInContext(
  provider: Eip1193Provider,
  request: ProviderRequest,
  signal: AbortSignal,
) {
  if (signal.aborted) throw contextCancelledError()
  let handleAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(contextCancelledError())
    signal.addEventListener('abort', handleAbort, { once: true })
  })
  try {
    const value = await beforeDeadline(
      () => Promise.race([provider.request(request), interrupted]),
      Date.now() + WALLET_READ_TIMEOUT_MS,
      () => new Error('Post feed context read timed out.'),
    )
    if (signal.aborted) throw contextCancelledError()
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
    throw new Error('The post feed belongs to a different wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid post feed head.')
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
    throw new Error('The post feed belongs to a different wallet chain.')
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
    throw new Error('The wallet returned invalid post feed checkpoint data.')
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
      'The confirmed post feed checkpoint changed. Retry the bounded range.',
    )
  }
}

function decodePostLogs(logs: readonly IndexedEventLog[]) {
  return logs.map((log) => {
    const post = decodePublishedPost(log)
    if (!post) throw new Error('The post feed cache contained another event.')
    return post
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

export const synchronizePostFeed: PostFeedSynchronizer = async (
  provider,
  chainId,
  options = {},
) => {
  const seed = createEventCursor({
    chainId,
    filter: PUBLISHED_POST_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: POST_FEED_START_BLOCK,
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
      throw new Error('The wallet chain changed during feed verification.')
    }
  }
  try {
    await assertSelectedChain(provider, chainId, interruption.signal)
    assertContextActive()
    const inspection = await inspectProtocol(provider)
    assertContextActive()
    await assertSelectedChain(provider, chainId, interruption.signal)
    assertContextActive()
    if (inspection.kind !== 'ready') {
      throw new Error(
        'Verified Lifeinvader v1 is required before this chain can provide a feed.',
      )
    }
    const cache = await openEventCache({
      ...options.storage,
      filter: PUBLISHED_POST_FILTER,
    })
    try {
      assertContextActive()
      let before = await cache.readLatest(seed, POST_FEED_PAGE_SIZE)
      let cacheReset = before.reset
      try {
        decodePostLogs(before.logs)
      } catch {
        await cache.clear(seed)
        before = await cache.readLatest(seed, POST_FEED_PAGE_SIZE)
        cacheReset = true
      }
      const result = await syncEventLogs(
        provider,
        PUBLISHED_POST_FILTER,
        before.cursor,
        {
          maxRanges: 1,
          signal: interruption.signal,
        },
      )
      assertContextActive()
      decodePostLogs(result.logs)
      await cache.apply(before, result)
      assertContextActive()
      const after = await cache.readLatest(seed, POST_FEED_PAGE_SIZE)
      if (
        after.generation !== before.generation ||
        after.revision !== before.revision + 1n ||
        !sameCursor(after.cursor, result.cursor)
      ) {
        throw new Error(
          'The post feed cache changed after synchronization. Retry the bounded range.',
        )
      }
      let posts: readonly PublishedPost[]
      try {
        posts = decodePostLogs(after.logs)
      } catch (error) {
        await cache.clear(seed)
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
          'The wallet head moved behind the confirmed post feed. Retry after the chain stabilizes.',
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
      const safeHead =
        finalHead >= POST_FEED_CONFIRMATION_DEPTH
          ? finalHead - POST_FEED_CONFIRMATION_DEPTH
          : undefined
      return {
        cacheReset: cacheReset || after.reset,
        caughtUp: safeHead === undefined || after.cursor.nextBlock > safeHead,
        head: finalHead,
        indexedThrough,
        posts,
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
