import {
  openEventCache,
  type BrowserEventCache,
  type EventCachePosition,
  type EventCacheScanBaseline,
  type EventCacheScanCursor,
  type EventCacheScanPage,
} from './event-cache'
import {
  createEventCursor,
  validateEventCursor,
  type EventCursor,
} from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import {
  PostReactionProjection,
  type PostReactionSummary,
} from './post-reaction-projection'
import {
  POST_REACTION_EVENT_PAGE_SIZE,
  POST_REACTION_EVENT_START_BLOCK,
  type PostReactionProjectionAnchor,
  type PostReactionStreamStorageOptions,
} from './post-reaction-stream'
import {
  POST_LIKE_SET_FILTER,
  PUBLISHED_REPOST_FILTER,
} from './protocol-events'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

type ProjectionStream = 'likes' | 'reposts'
type ActiveProjectionRunPhase = ProjectionStream | 'authenticate-likes'

export type PostReactionProjectionRunPhase =
  ActiveProjectionRunPhase | 'complete' | 'failed' | 'closed'

export type PostReactionProjectionRunStreamProgress = {
  complete: boolean
  logsProcessed: bigint
  pagesScanned: bigint
}

export type PostReactionProjectionRunSnapshot = {
  chainId: bigint
  head: bigint
  likes: PostReactionProjectionRunStreamProgress
  phase: PostReactionProjectionRunPhase
  reposts: PostReactionProjectionRunStreamProgress
  safeHead?: bigint
}

export type PostReactionProjectionBaselines = {
  likes: EventCacheScanBaseline
  reposts: EventCacheScanBaseline
}

export type OpenPostReactionProjectionRunOptions =
  PostReactionStreamStorageOptions & {
    pageSize?: number
  }

type NormalizedProjectionAnchor = {
  chainId: bigint
  head: bigint
  likes: EventCachePosition
  reposts: EventCachePosition
  safeHead?: bigint
}

type MutableStreamProgress = {
  complete: boolean
  logsProcessed: bigint
  pagesScanned: bigint
}

function projectionRunError(message: string) {
  return new Error(`Invalid post reaction projection run ${message}.`)
}

function asError(value: unknown) {
  return value instanceof Error
    ? value
    : new Error('The post reaction projection run failed.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertQuantity(
  value: unknown,
  label: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_EVM_QUANTITY) {
    throw projectionRunError(label)
  }
}

function copyCursor(cursor: EventCursor): EventCursor {
  return {
    ...cursor,
    checkpoints: cursor.checkpoints.map((checkpoint) => ({ ...checkpoint })),
  }
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

function sameCursorScope(first: EventCursor, second: EventCursor) {
  return (
    first.chainId === second.chainId &&
    first.finalityDepth === second.finalityDepth &&
    first.filterId === second.filterId &&
    first.startBlock === second.startBlock
  )
}

function sameCachePosition(
  first: EventCachePosition,
  second: EventCachePosition,
) {
  return (
    first.generation === second.generation &&
    first.revision === second.revision &&
    sameCursor(first.cursor, second.cursor)
  )
}

function normalizeCachePosition(
  value: unknown,
  seed: EventCursor,
  expectedNextBlock: bigint,
  label: string,
): EventCachePosition {
  if (!isRecord(value)) throw projectionRunError(`${label} anchor`)
  let cursor: EventCursor
  try {
    cursor = validateEventCursor(value.cursor)
  } catch {
    throw projectionRunError(`${label} anchor cursor`)
  }
  if (
    !sameCursorScope(cursor, seed) ||
    cursor.nextBlock !== expectedNextBlock
  ) {
    throw projectionRunError(`${label} anchor boundary`)
  }
  if (
    typeof value.generation !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.generation)
  ) {
    throw projectionRunError(`${label} anchor generation`)
  }
  if (typeof value.revision !== 'bigint' || value.revision < 1n) {
    throw projectionRunError(`${label} anchor revision`)
  }
  return {
    cursor,
    generation: value.generation,
    revision: value.revision,
  }
}

function normalizeAnchor(value: unknown): NormalizedProjectionAnchor {
  if (!isRecord(value)) throw projectionRunError('anchor')
  assertQuantity(value.chainId, 'anchor chain identifier')
  assertQuantity(value.head, 'anchor head')
  const expectedSafeHead =
    value.head >= POST_FEED_CONFIRMATION_DEPTH
      ? value.head - POST_FEED_CONFIRMATION_DEPTH
      : undefined
  if (value.safeHead !== expectedSafeHead) {
    throw projectionRunError('anchor safe head')
  }
  const expectedNextBlock =
    expectedSafeHead === undefined
      ? POST_REACTION_EVENT_START_BLOCK
      : expectedSafeHead + 1n
  const likeSeed = createEventCursor({
    chainId: value.chainId,
    filter: POST_LIKE_SET_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: POST_REACTION_EVENT_START_BLOCK,
  })
  const repostSeed = createEventCursor({
    chainId: value.chainId,
    filter: PUBLISHED_REPOST_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: POST_REACTION_EVENT_START_BLOCK,
  })
  return {
    chainId: value.chainId,
    head: value.head,
    likes: normalizeCachePosition(
      value.likes,
      likeSeed,
      expectedNextBlock,
      'like',
    ),
    reposts: normalizeCachePosition(
      value.reposts,
      repostSeed,
      expectedNextBlock,
      'repost',
    ),
    safeHead: expectedSafeHead,
  }
}

function getSeed(position: EventCachePosition): EventCursor {
  return {
    ...copyCursor(position.cursor),
    checkpoints: [],
    nextBlock: position.cursor.startBlock,
  }
}

function copyBaseline(baseline: EventCacheScanBaseline) {
  return {
    ...baseline,
    cursor: copyCursor(baseline.cursor),
    last: baseline.last ? { ...baseline.last } : undefined,
  }
}

function sameLogPosition(
  first: EventCacheScanBaseline['last'],
  second: EventCacheScanBaseline['last'],
) {
  return first === undefined
    ? second === undefined
    : second !== undefined &&
        first.blockNumber === second.blockNumber &&
        first.logIndex === second.logIndex
}

function sameBaseline(
  first: EventCacheScanBaseline,
  second: EventCacheScanBaseline,
) {
  return (
    sameCachePosition(first, second) &&
    first.digest === second.digest &&
    first.logCount === second.logCount &&
    first.proof === second.proof &&
    sameLogPosition(first.last, second.last)
  )
}

function copyProgress(
  progress: MutableStreamProgress,
): PostReactionProjectionRunStreamProgress {
  return { ...progress }
}

function assertPageShape(page: EventCacheScanPage) {
  if (page.reset) throw projectionRunError('cache reset')
  if (page.complete) {
    if (!page.baseline || page.next) {
      throw projectionRunError('completed page boundary')
    }
    return
  }
  if (page.baseline || !page.next || page.logs.length === 0) {
    throw projectionRunError('continuation page boundary')
  }
}

export class PostReactionProjectionRun {
  readonly #anchor: NormalizedProjectionAnchor
  readonly #pageSize: number
  readonly #projection = new PostReactionProjection()
  readonly #progress: Record<ProjectionStream, MutableStreamProgress> = {
    likes: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
    reposts: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
  }
  #advancing = false
  #failure?: Error
  #likeBaseline?: EventCacheScanBaseline
  #likeCache?: BrowserEventCache
  #likeContinuation?: EventCacheScanCursor
  #phase: PostReactionProjectionRunPhase = 'likes'
  #repostBaseline?: EventCacheScanBaseline
  #repostCache?: BrowserEventCache
  #repostContinuation?: EventCacheScanCursor

  private constructor(
    anchor: NormalizedProjectionAnchor,
    pageSize: number,
    likeCache: BrowserEventCache,
    repostCache: BrowserEventCache,
  ) {
    this.#anchor = anchor
    this.#pageSize = pageSize
    this.#likeCache = likeCache
    this.#repostCache = repostCache
  }

  static async open(
    anchorValue: unknown,
    optionsValue: OpenPostReactionProjectionRunOptions = {},
  ) {
    const anchor = normalizeAnchor(anchorValue)
    if (!isRecord(optionsValue)) {
      throw projectionRunError('options')
    }
    const pageSize = optionsValue.pageSize ?? POST_REACTION_EVENT_PAGE_SIZE
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > POST_REACTION_EVENT_PAGE_SIZE
    ) {
      throw projectionRunError('page size')
    }
    const storage = {
      databaseName: optionsValue.databaseName,
      factory: optionsValue.factory,
      keyRange: optionsValue.keyRange,
    }
    const likeCache = await openEventCache({
      ...storage,
      filter: POST_LIKE_SET_FILTER,
    })
    try {
      const repostCache = await openEventCache({
        ...storage,
        filter: PUBLISHED_REPOST_FILTER,
      })
      return new PostReactionProjectionRun(
        anchor,
        pageSize,
        likeCache,
        repostCache,
      )
    } catch (error) {
      likeCache.close()
      throw error
    }
  }

  get snapshot(): PostReactionProjectionRunSnapshot {
    return {
      chainId: this.#anchor.chainId,
      head: this.#anchor.head,
      likes: copyProgress(this.#progress.likes),
      phase: this.#phase,
      reposts: copyProgress(this.#progress.reposts),
      safeHead: this.#anchor.safeHead,
    }
  }

  get baselines(): PostReactionProjectionBaselines {
    if (
      this.#phase !== 'complete' ||
      !this.#likeBaseline ||
      !this.#repostBaseline
    ) {
      throw new Error('The post reaction projection is not complete.')
    }
    return {
      likes: copyBaseline(this.#likeBaseline),
      reposts: copyBaseline(this.#repostBaseline),
    }
  }

  getSummary(postId: unknown, account?: unknown): PostReactionSummary {
    if (this.#phase !== 'complete') {
      throw new Error('The post reaction projection is not complete.')
    }
    return this.#projection.getSummary(postId, account)
  }

  async advance(): Promise<PostReactionProjectionRunSnapshot> {
    if (this.#advancing) {
      throw new Error('The post reaction projection is already advancing.')
    }
    if (this.#phase === 'complete') return this.snapshot
    if (this.#phase === 'failed') throw this.#failure
    if (this.#phase === 'closed') {
      throw new Error('The post reaction projection run is closed.')
    }
    const phase = this.#phase
    if (phase === 'authenticate-likes') {
      this.#advancing = true
      try {
        await this.#authenticateLikes()
        return this.snapshot
      } catch (error) {
        const failure = asError(error)
        if (this.#readPhase() !== 'closed') this.#fail(failure)
        throw failure
      } finally {
        this.#advancing = false
      }
    }
    const stream = phase
    const cache = stream === 'likes' ? this.#likeCache : this.#repostCache
    const continuation =
      stream === 'likes' ? this.#likeContinuation : this.#repostContinuation
    if (!cache) throw projectionRunError(`${stream} cache state`)
    this.#advancing = true
    try {
      const page = await cache.scan(getSeed(this.#anchor[stream]), {
        continuation,
        limit: this.#pageSize,
      })
      const currentPhase = this.#readPhase()
      if (currentPhase === 'closed') {
        throw new Error('The post reaction projection run is closed.')
      }
      if (currentPhase !== stream) {
        throw projectionRunError('phase')
      }
      this.#applyPage(stream, page)
      return this.snapshot
    } catch (error) {
      const failure = asError(error)
      if (this.#readPhase() !== 'closed') this.#fail(failure)
      throw failure
    } finally {
      this.#advancing = false
    }
  }

  close() {
    if (this.#phase === 'complete' || this.#phase === 'failed') {
      this.#closeCaches()
      return
    }
    this.#phase = 'closed'
    this.#projection.reset()
    this.#likeBaseline = undefined
    this.#repostBaseline = undefined
    this.#likeContinuation = undefined
    this.#repostContinuation = undefined
    this.#closeCaches()
  }

  #applyPage(stream: ProjectionStream, page: EventCacheScanPage) {
    assertPageShape(page)
    if (!sameCachePosition(page, this.#anchor[stream])) {
      throw projectionRunError(`${stream} cache anchor`)
    }
    if (stream === 'likes') this.#projection.applyLikeLogs(page.logs)
    else this.#projection.applyRepostLogs(page.logs)
    const progress = this.#progress[stream]
    const logsProcessed = progress.logsProcessed + BigInt(page.logs.length)
    progress.logsProcessed = logsProcessed
    progress.pagesScanned += 1n
    if (!page.complete) {
      if (stream === 'likes') this.#likeContinuation = page.next
      else this.#repostContinuation = page.next
      return
    }
    const baseline = page.baseline!
    if (
      !sameCachePosition(baseline, this.#anchor[stream]) ||
      BigInt(baseline.logCount) !== logsProcessed
    ) {
      throw projectionRunError(`${stream} completed baseline`)
    }
    const projectionPosition = this.#projection.progress[stream]
    if (
      baseline.last === undefined
        ? projectionPosition !== undefined
        : projectionPosition === undefined ||
          baseline.last.blockNumber !== projectionPosition.blockNumber ||
          baseline.last.logIndex !== projectionPosition.logIndex
    ) {
      throw projectionRunError(`${stream} completed tail`)
    }
    progress.complete = true
    if (stream === 'likes') {
      this.#likeBaseline = copyBaseline(baseline)
      this.#likeContinuation = undefined
      this.#phase = 'reposts'
      return
    }
    this.#repostBaseline = copyBaseline(baseline)
    this.#repostContinuation = undefined
    this.#repostCache?.close()
    this.#repostCache = undefined
    this.#phase = 'authenticate-likes'
  }

  async #authenticateLikes() {
    const cache = this.#likeCache
    const baseline = this.#likeBaseline
    if (!cache || !baseline || !this.#repostBaseline) {
      throw projectionRunError('like authentication state')
    }
    const page = await cache.scan(getSeed(this.#anchor.likes), {
      baseline,
      limit: this.#pageSize,
    })
    const currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The post reaction projection run is closed.')
    }
    if (currentPhase !== 'authenticate-likes') {
      throw projectionRunError('phase')
    }
    if (
      page.reset ||
      !page.complete ||
      page.logs.length !== 0 ||
      page.next ||
      !page.baseline ||
      !sameCachePosition(page, this.#anchor.likes) ||
      !sameBaseline(page.baseline, baseline)
    ) {
      throw projectionRunError('like baseline changed')
    }
    cache.close()
    this.#likeCache = undefined
    this.#phase = 'complete'
  }

  #fail(error: Error) {
    this.#failure = error
    this.#phase = 'failed'
    this.#projection.reset()
    this.#likeBaseline = undefined
    this.#repostBaseline = undefined
    this.#likeContinuation = undefined
    this.#repostContinuation = undefined
    this.#closeCaches()
  }

  #closeCaches() {
    this.#likeCache?.close()
    this.#likeCache = undefined
    this.#repostCache?.close()
    this.#repostCache = undefined
  }

  #readPhase(): PostReactionProjectionRunPhase {
    return this.#phase
  }
}

export function openPostReactionProjectionRun(
  anchor: PostReactionProjectionAnchor,
  options?: OpenPostReactionProjectionRunOptions,
) {
  return PostReactionProjectionRun.open(anchor, options)
}
