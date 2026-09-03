import { openEventCache, type OpenEventCacheOptions } from './event-cache'
import {
  createEventCursor,
  DEFAULT_FINALITY_DEPTH,
  syncEventLogs,
  type IndexedEventLog,
} from './event-indexer'
import {
  decodePublishedPost,
  PUBLISHED_POST_FILTER,
  type PublishedPost,
} from './protocol-events'
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

export const synchronizePostFeed: PostFeedSynchronizer = async (
  provider,
  chainId,
  options = {},
) => {
  const seed = createEventCursor({
    chainId,
    filter: PUBLISHED_POST_FILTER,
    finalityDepth: DEFAULT_FINALITY_DEPTH,
    startBlock: POST_FEED_START_BLOCK,
  })
  assertActive(options.signal)
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
