import { openEventCache, type OpenEventCacheOptions } from './event-cache'
import {
  createEventCursor,
  syncEventLogs,
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

async function assertSelectedChain(
  provider: Eip1193Provider,
  chainId: bigint,
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
      () =>
        Promise.race([
          provider.request({ method: 'eth_chainId' }),
          interrupted,
        ]),
      Date.now() + WALLET_READ_TIMEOUT_MS,
      () => new Error('Post feed chain inspection timed out.'),
    )
    if (signal.aborted) throw contextCancelledError()
    if (parseChainId(value) !== chainId) {
      throw new Error('The post feed belongs to a different wallet chain.')
    }
  } finally {
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
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
      return {
        cacheReset: cacheReset || after.reset,
        caughtUp: result.caughtUp,
        head: result.head,
        indexedThrough:
          after.cursor.nextBlock > after.cursor.startBlock
            ? after.cursor.nextBlock - 1n
            : undefined,
        posts,
        safeHead: result.safeHead,
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
