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
import type { Eip1193Provider } from './ethereum'

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
  const inspection = await inspectProtocol(provider)
  assertActive(options.signal)
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
    assertActive(options.signal)
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
        signal: options.signal,
      },
    )
    assertActive(options.signal)
    decodePostLogs(result.logs)
    await cache.apply(before, result)
    assertActive(options.signal)
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
}
