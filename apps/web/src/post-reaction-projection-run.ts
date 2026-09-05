import {
  openEventCache,
  validateEventCacheScanBaseline,
  type BrowserEventCache,
  type EventCacheDerivedStateBinding,
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
  getPostReactionProjectionSnapshotDigest,
  PostReactionProjection,
  type PostReactionProjectionSnapshot,
  type PostReactionSummary,
} from './post-reaction-projection'
import {
  POST_REACTION_EVENT_PAGE_SIZE,
  assertIssuedPostReactionProjectionAnchor,
  authenticateIssuedPostReactionProjectionAnchor,
  type PostReactionProjectionAnchor,
  type PostReactionStreamStorageOptions,
} from './post-reaction-stream'
import {
  POST_LIKE_SET_FILTER,
  PUBLISHED_REPOST_FILTER,
} from './protocol-events'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

type ProjectionStream = 'likes' | 'reposts'
type ActiveProjectionRunPhase = ProjectionStream | 'authenticate'

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
  startBlock: bigint
}

export type PostReactionProjectionBaselines = {
  likes: EventCacheScanBaseline
  reposts: EventCacheScanBaseline
}

export type PostReactionProjectionBindings = {
  likes: EventCacheDerivedStateBinding
  reposts: EventCacheDerivedStateBinding
}

export type PostReactionProjectionResumeState = {
  baselines: PostReactionProjectionBaselines
  bindings: PostReactionProjectionBindings
  projection: PostReactionProjectionSnapshot
}

export type OpenPostReactionProjectionRunOptions =
  PostReactionStreamStorageOptions & {
    pageSize?: number
    resume?: PostReactionProjectionResumeState
  }

type NormalizedProjectionAnchor = {
  chainId: bigint
  head: bigint
  issued: PostReactionProjectionAnchor
  likes: EventCachePosition
  reposts: EventCachePosition
  safeHead?: bigint
  startBlock: bigint
}

type MutableStreamProgress = {
  complete: boolean
  logsProcessed: bigint
  pagesScanned: bigint
}

type NormalizedProjectionResume = {
  baselines: PostReactionProjectionBaselines
  bindings: PostReactionProjectionBindings
  projection: PostReactionProjection
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

function sameCheckpoint(
  first: { blockHash: string; blockNumber: bigint } | undefined,
  second: { blockHash: string; blockNumber: bigint } | undefined,
) {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.blockHash === second.blockHash &&
      first.blockNumber === second.blockNumber)
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
  assertQuantity(value.startBlock, 'anchor start block')
  const expectedSafeHead =
    value.head >= POST_FEED_CONFIRMATION_DEPTH
      ? value.head - POST_FEED_CONFIRMATION_DEPTH
      : undefined
  if (value.safeHead !== expectedSafeHead) {
    throw projectionRunError('anchor safe head')
  }
  const expectedNextBlock =
    expectedSafeHead === undefined ? value.startBlock : expectedSafeHead + 1n
  const likeSeed = createEventCursor({
    chainId: value.chainId,
    filter: POST_LIKE_SET_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: value.startBlock,
  })
  const repostSeed = createEventCursor({
    chainId: value.chainId,
    filter: PUBLISHED_REPOST_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: value.startBlock,
  })
  const likes = normalizeCachePosition(
    value.likes,
    likeSeed,
    expectedNextBlock,
    'like',
  )
  const reposts = normalizeCachePosition(
    value.reposts,
    repostSeed,
    expectedNextBlock,
    'repost',
  )
  if (expectedSafeHead !== undefined) {
    const likeCheckpoint = likes.cursor.checkpoints.at(-1)
    const repostCheckpoint = reposts.cursor.checkpoints.at(-1)
    if (
      !likeCheckpoint ||
      !repostCheckpoint ||
      likeCheckpoint.blockNumber !== expectedSafeHead ||
      repostCheckpoint.blockNumber !== expectedSafeHead ||
      likeCheckpoint.blockHash !== repostCheckpoint.blockHash
    ) {
      throw projectionRunError('anchor shared safe-head checkpoint')
    }
  }
  assertIssuedPostReactionProjectionAnchor(value)
  return {
    chainId: value.chainId,
    head: value.head,
    issued: value,
    likes,
    reposts,
    safeHead: expectedSafeHead,
    startBlock: value.startBlock,
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

function copyBinding(binding: EventCacheDerivedStateBinding) {
  return { ...binding }
}

function copyBaselines(
  baselines: PostReactionProjectionBaselines,
): PostReactionProjectionBaselines {
  return {
    likes: copyBaseline(baselines.likes),
    reposts: copyBaseline(baselines.reposts),
  }
}

function copyBindings(
  bindings: PostReactionProjectionBindings,
): PostReactionProjectionBindings {
  return {
    likes: copyBinding(bindings.likes),
    reposts: copyBinding(bindings.reposts),
  }
}

function normalizeBinding(value: unknown, label: string) {
  if (!isRecord(value)) throw projectionRunError(`${label} resume binding`)
  const { digest, proof } = value
  if (
    typeof digest !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(digest) ||
    typeof proof !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(proof)
  ) {
    throw projectionRunError(`${label} resume binding`)
  }
  return { digest, proof } as EventCacheDerivedStateBinding
}

function normalizeResumeBaseline(
  value: unknown,
  anchor: EventCachePosition,
  label: string,
) {
  let baseline: EventCacheScanBaseline
  try {
    baseline = validateEventCacheScanBaseline(value, getSeed(anchor))
  } catch {
    throw projectionRunError(`${label} resume baseline`)
  }
  if (
    baseline.generation !== anchor.generation ||
    baseline.revision > anchor.revision ||
    baseline.cursor.nextBlock > anchor.cursor.nextBlock ||
    (baseline.revision === anchor.revision &&
      !sameCursor(baseline.cursor, anchor.cursor))
  ) {
    throw projectionRunError(`${label} resume baseline`)
  }
  return baseline
}

function assertResumeTail(
  baseline: EventCacheScanBaseline,
  position: { blockNumber: bigint; logIndex: number } | undefined,
  label: string,
) {
  if (
    baseline.last === undefined
      ? position !== undefined
      : position === undefined ||
        baseline.last.blockNumber !== position.blockNumber ||
        baseline.last.logIndex !== position.logIndex
  ) {
    throw projectionRunError(`${label} resume tail`)
  }
}

function normalizeResume(
  value: unknown,
  anchor: NormalizedProjectionAnchor,
): NormalizedProjectionResume | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    !isRecord(value.baselines) ||
    !isRecord(value.bindings)
  ) {
    throw projectionRunError('resume state')
  }
  let projection: PostReactionProjection
  try {
    projection = PostReactionProjection.fromSnapshot(value.projection)
  } catch {
    throw projectionRunError('resume projection')
  }
  const baselines = {
    likes: normalizeResumeBaseline(value.baselines.likes, anchor.likes, 'like'),
    reposts: normalizeResumeBaseline(
      value.baselines.reposts,
      anchor.reposts,
      'repost',
    ),
  }
  const bindings = {
    likes: normalizeBinding(value.bindings.likes, 'like'),
    reposts: normalizeBinding(value.bindings.reposts, 'repost'),
  }
  const projectionSnapshot = projection.snapshot
  const digest = getPostReactionProjectionSnapshotDigest(projectionSnapshot)
  if (bindings.likes.digest !== digest || bindings.reposts.digest !== digest) {
    throw projectionRunError('resume projection digest')
  }
  if (baselines.likes.cursor.nextBlock !== baselines.reposts.cursor.nextBlock) {
    throw projectionRunError('resume shared boundary')
  }
  const atStart =
    baselines.likes.cursor.nextBlock === baselines.likes.cursor.startBlock
  const likeCheckpoint = baselines.likes.cursor.checkpoints.at(-1)
  const repostCheckpoint = baselines.reposts.cursor.checkpoints.at(-1)
  const confirmedThrough = projectionSnapshot.confirmedThrough
  if (
    atStart
      ? likeCheckpoint !== undefined ||
        repostCheckpoint !== undefined ||
        confirmedThrough !== undefined
      : !likeCheckpoint ||
        !repostCheckpoint ||
        likeCheckpoint.blockNumber !== baselines.likes.cursor.nextBlock - 1n ||
        !sameCheckpoint(likeCheckpoint, repostCheckpoint) ||
        !sameCheckpoint(likeCheckpoint, confirmedThrough) ||
        !anchor.likes.cursor.checkpoints.some((checkpoint) =>
          sameCheckpoint(checkpoint, likeCheckpoint),
        ) ||
        !anchor.reposts.cursor.checkpoints.some((checkpoint) =>
          sameCheckpoint(checkpoint, repostCheckpoint),
        )
  ) {
    throw projectionRunError('resume confirmation')
  }
  const progress = projection.progress
  assertResumeTail(baselines.likes, progress.likes, 'like')
  assertResumeTail(baselines.reposts, progress.reposts, 'repost')
  return { baselines, bindings, projection }
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
  readonly #initialLogCounts: Record<ProjectionStream, number>
  readonly #pageSize: number
  readonly #projection: PostReactionProjection
  readonly #progress: Record<ProjectionStream, MutableStreamProgress> = {
    likes: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
    reposts: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
  }
  #advancing = false
  #bindings?: PostReactionProjectionBindings
  #failure?: Error
  readonly #interruption = new AbortController()
  #likeBaseline?: EventCacheScanBaseline
  #likeCache?: BrowserEventCache
  #likeContinuation?: EventCacheScanCursor
  #phase: PostReactionProjectionRunPhase = 'likes'
  #repostBaseline?: EventCacheScanBaseline
  #repostCache?: BrowserEventCache
  #repostContinuation?: EventCacheScanCursor
  readonly #scanBaselines: Partial<
    Record<ProjectionStream, EventCacheScanBaseline>
  >

  private constructor(
    anchor: NormalizedProjectionAnchor,
    pageSize: number,
    likeCache: BrowserEventCache,
    repostCache: BrowserEventCache,
    resume?: NormalizedProjectionResume,
  ) {
    this.#anchor = anchor
    this.#initialLogCounts = {
      likes: resume?.baselines.likes.logCount ?? 0,
      reposts: resume?.baselines.reposts.logCount ?? 0,
    }
    this.#pageSize = pageSize
    this.#projection = resume?.projection ?? new PostReactionProjection()
    this.#likeCache = likeCache
    this.#repostCache = repostCache
    this.#scanBaselines = resume ? copyBaselines(resume.baselines) : {}
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
    const resume = normalizeResume(optionsValue.resume, anchor)
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
      try {
        if (resume) {
          await likeCache.authenticateDerivedState(
            resume.baselines.likes,
            resume.bindings.likes,
          )
          await repostCache.authenticateDerivedState(
            resume.baselines.reposts,
            resume.bindings.reposts,
          )
        }
        return new PostReactionProjectionRun(
          anchor,
          pageSize,
          likeCache,
          repostCache,
          resume,
        )
      } catch (error) {
        repostCache.close()
        throw error
      }
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
      startBlock: this.#anchor.startBlock,
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

  get projectionSnapshot(): PostReactionProjectionSnapshot {
    if (this.#phase !== 'complete') {
      throw new Error('The post reaction projection is not complete.')
    }
    return this.#projection.snapshot
  }

  get resumeState(): PostReactionProjectionResumeState {
    if (
      this.#phase !== 'complete' ||
      !this.#likeBaseline ||
      !this.#repostBaseline ||
      !this.#bindings
    ) {
      throw new Error('The post reaction projection is not complete.')
    }
    return {
      baselines: {
        likes: copyBaseline(this.#likeBaseline),
        reposts: copyBaseline(this.#repostBaseline),
      },
      bindings: copyBindings(this.#bindings),
      projection: this.#projection.snapshot,
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
    if (phase === 'authenticate') {
      this.#advancing = true
      try {
        await this.#authenticateBaselines()
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
        baseline: continuation ? undefined : this.#scanBaselines[stream],
        continuation,
        limit: this.#pageSize,
        resetOnCorruption: false,
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
    this.#interruption.abort()
    this.#projection.reset()
    this.#bindings = undefined
    this.#likeBaseline = undefined
    this.#repostBaseline = undefined
    this.#likeContinuation = undefined
    this.#repostContinuation = undefined
    delete this.#scanBaselines.likes
    delete this.#scanBaselines.reposts
    this.#closeCaches()
  }

  #applyPage(stream: ProjectionStream, page: EventCacheScanPage) {
    assertPageShape(page)
    if (!sameCachePosition(page, this.#anchor[stream])) {
      throw projectionRunError(`${stream} cache anchor`)
    }
    if (stream === 'likes') this.#projection.applyLikeLogs(page.logs)
    else this.#projection.applyRepostLogs(page.logs)
    delete this.#scanBaselines[stream]
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
      BigInt(baseline.logCount) !==
        BigInt(this.#initialLogCounts[stream]) + logsProcessed
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
    this.#phase = 'authenticate'
  }

  async #authenticateBaselines() {
    const likeCache = this.#likeCache
    const repostCache = this.#repostCache
    const likeBaseline = this.#likeBaseline
    const repostBaseline = this.#repostBaseline
    if (!likeCache || !repostCache || !likeBaseline || !repostBaseline) {
      throw projectionRunError('baseline authentication state')
    }
    const authenticateCache = () =>
      likeCache.authenticateBaselines([
        {
          baseline: likeBaseline,
          filter: POST_LIKE_SET_FILTER,
          seed: getSeed(this.#anchor.likes),
        },
        {
          baseline: repostBaseline,
          filter: PUBLISHED_REPOST_FILTER,
          seed: getSeed(this.#anchor.reposts),
        },
      ])
    await authenticateCache()
    if (this.#anchor.safeHead !== undefined) {
      const checkpoint = this.#anchor.likes.cursor.checkpoints.at(-1)
      if (!checkpoint || checkpoint.blockNumber !== this.#anchor.safeHead) {
        throw projectionRunError('confirmed projection boundary')
      }
      this.#projection.confirmThrough(checkpoint)
    }
    const digest = getPostReactionProjectionSnapshotDigest(
      this.#projection.snapshot,
    )
    let bindings: PostReactionProjectionBindings | undefined
    await authenticateIssuedPostReactionProjectionAnchor(
      this.#anchor.issued,
      async () => {
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The post reaction projection run is closed.')
        }
        const likes = await likeCache.bindDerivedState(likeBaseline, digest)
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The post reaction projection run is closed.')
        }
        const reposts = await repostCache.bindDerivedState(
          repostBaseline,
          digest,
        )
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The post reaction projection run is closed.')
        }
        await authenticateCache()
        bindings = { likes, reposts }
      },
      this.#interruption.signal,
    )
    const currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The post reaction projection run is closed.')
    }
    if (currentPhase !== 'authenticate') {
      throw projectionRunError('phase')
    }
    if (!bindings) throw projectionRunError('derived state bindings')
    this.#bindings = copyBindings(bindings)
    this.#closeCaches()
    this.#phase = 'complete'
  }

  #fail(error: Error) {
    this.#failure = error
    this.#phase = 'failed'
    this.#interruption.abort()
    this.#projection.reset()
    this.#bindings = undefined
    this.#likeBaseline = undefined
    this.#repostBaseline = undefined
    this.#likeContinuation = undefined
    this.#repostContinuation = undefined
    delete this.#scanBaselines.likes
    delete this.#scanBaselines.reposts
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
