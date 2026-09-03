import type { Address } from 'viem'
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
import {
  getProfileProjectionSnapshotDigest,
  ProfileProjection,
  type ProfileProjectionPosition,
  type ProfileProjectionSnapshot,
} from './profile-projection'
import {
  PROFILE_EVENT_PAGE_SIZE,
  PROFILE_EVENT_START_BLOCK,
  assertIssuedProfileProjectionAnchor,
  authenticateIssuedProfileProjectionAnchor,
  type ProfileProjectionAnchor,
  type ProfileStreamStorageOptions,
} from './profile-stream'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { PROFILE_SET_FILTER } from './protocol-events'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

export type ProfileProjectionRunPhase =
  'profiles' | 'authenticate' | 'complete' | 'failed' | 'closed'

export type ProfileProjectionRunSnapshot = {
  chainId: bigint
  profilesRetained: bigint
  head: bigint
  logsProcessed: bigint
  pagesScanned: bigint
  phase: ProfileProjectionRunPhase
  safeHead?: bigint
}

export type OpenProfileProjectionRunOptions = ProfileStreamStorageOptions & {
  pageSize?: number
  resume?: ProfileProjectionResumeState
}

export type ProfileProjectionResumeState = {
  baseline: EventCacheScanBaseline
  binding: EventCacheDerivedStateBinding
  projection: ProfileProjectionSnapshot
}

type NormalizedProjectionAnchor = {
  chainId: bigint
  profiles: EventCachePosition
  head: bigint
  issued: ProfileProjectionAnchor
  safeHead?: bigint
}

type NormalizedProjectionResume = {
  baseline: EventCacheScanBaseline
  binding: EventCacheDerivedStateBinding
  projection: ProfileProjection
}

function projectionRunError(message: string) {
  return new Error(`Invalid profile projection run ${message}.`)
}

function asError(value: unknown) {
  return value instanceof Error
    ? value
    : new Error('The profile projection run failed.')
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

function sameAccounts(first: readonly Address[], second: readonly Address[]) {
  return (
    first.length === second.length &&
    first.every(
      (account, index) =>
        account.toLowerCase() === second[index]?.toLowerCase(),
    )
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
) {
  if (!isRecord(value)) throw projectionRunError('anchor position')
  let cursor: EventCursor
  try {
    cursor = validateEventCursor(value.cursor)
  } catch {
    throw projectionRunError('anchor cursor')
  }
  if (
    !sameCursorScope(cursor, seed) ||
    cursor.nextBlock !== expectedNextBlock
  ) {
    throw projectionRunError('anchor boundary')
  }
  if (
    typeof value.generation !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.generation)
  ) {
    throw projectionRunError('anchor generation')
  }
  if (typeof value.revision !== 'bigint' || value.revision < 1n) {
    throw projectionRunError('anchor revision')
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
  const safeHead =
    value.head >= POST_FEED_CONFIRMATION_DEPTH
      ? value.head - POST_FEED_CONFIRMATION_DEPTH
      : undefined
  if (value.safeHead !== safeHead) {
    throw projectionRunError('anchor safe head')
  }
  const expectedNextBlock =
    safeHead === undefined ? PROFILE_EVENT_START_BLOCK : safeHead + 1n
  const seed = createEventCursor({
    chainId: value.chainId,
    filter: PROFILE_SET_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: PROFILE_EVENT_START_BLOCK,
  })
  const profiles = normalizeCachePosition(
    value.profiles,
    seed,
    expectedNextBlock,
  )
  if (safeHead !== undefined) {
    const checkpoint = profiles.cursor.checkpoints.at(-1)
    if (!checkpoint || checkpoint.blockNumber !== safeHead) {
      throw projectionRunError('anchor safe-head checkpoint')
    }
  }
  assertIssuedProfileProjectionAnchor(value)
  return {
    chainId: value.chainId,
    profiles,
    head: value.head,
    issued: value,
    safeHead,
  }
}

function getSeed(position: EventCachePosition): EventCursor {
  return {
    ...copyCursor(position.cursor),
    checkpoints: [],
    nextBlock: position.cursor.startBlock,
  }
}

function normalizeResume(
  value: unknown,
  anchor: NormalizedProjectionAnchor,
  requested: ProfileProjection,
): NormalizedProjectionResume | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw projectionRunError('resume state')
  let projection: ProfileProjection
  let baseline: EventCacheScanBaseline
  try {
    projection = ProfileProjection.fromSnapshot(value.projection)
    baseline = validateEventCacheScanBaseline(
      value.baseline,
      getSeed(anchor.profiles),
    )
  } catch {
    throw projectionRunError('resume state')
  }
  if (!sameAccounts(requested.trackedAccounts, projection.trackedAccounts)) {
    throw projectionRunError('resume accounts')
  }
  if (!isRecord(value.binding)) {
    throw projectionRunError('resume binding')
  }
  const { digest, proof } = value.binding
  if (
    typeof digest !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(digest) ||
    typeof proof !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(proof)
  ) {
    throw projectionRunError('resume binding')
  }
  const binding = { digest, proof } as EventCacheDerivedStateBinding
  if (getProfileProjectionSnapshotDigest(projection.snapshot) !== digest) {
    throw projectionRunError('resume projection digest')
  }
  if (
    baseline.generation !== anchor.profiles.generation ||
    baseline.revision > anchor.profiles.revision ||
    baseline.cursor.nextBlock > anchor.profiles.cursor.nextBlock ||
    (baseline.revision === anchor.profiles.revision &&
      !sameCursor(baseline.cursor, anchor.profiles.cursor))
  ) {
    throw projectionRunError('resume baseline')
  }
  const checkpoint = baseline.cursor.checkpoints.at(-1)
  if (
    baseline.cursor.nextBlock === baseline.cursor.startBlock
      ? checkpoint !== undefined || projection.confirmedThrough !== undefined
      : checkpoint === undefined ||
        checkpoint.blockNumber !== baseline.cursor.nextBlock - 1n ||
        !sameCheckpoint(checkpoint, projection.confirmedThrough) ||
        !anchor.profiles.cursor.checkpoints.some((current) =>
          sameCheckpoint(current, checkpoint),
        )
  ) {
    throw projectionRunError('resume confirmation')
  }
  const progress = projection.progress
  if (
    baseline.last === undefined
      ? progress !== undefined || baseline.logCount !== 0
      : progress === undefined ||
        baseline.last.blockNumber !== progress.blockNumber ||
        baseline.last.logIndex !== progress.logIndex
  ) {
    throw projectionRunError('resume tail')
  }
  return { baseline, binding, projection }
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

export class ProfileProjectionRun {
  readonly #anchor: NormalizedProjectionAnchor
  readonly #pageSize: number
  readonly #projection: ProfileProjection
  readonly #initialLogCount: number
  #advancing = false
  #baseline?: EventCacheScanBaseline
  #binding?: EventCacheDerivedStateBinding
  #cache?: BrowserEventCache
  #continuation?: EventCacheScanCursor
  #failure?: Error
  readonly #interruption = new AbortController()
  #logsProcessed = 0n
  #pagesScanned = 0n
  #phase: ProfileProjectionRunPhase = 'profiles'
  #scanBaseline?: EventCacheScanBaseline

  private constructor(
    anchor: NormalizedProjectionAnchor,
    pageSize: number,
    projection: ProfileProjection,
    cache: BrowserEventCache,
    resume?: NormalizedProjectionResume,
  ) {
    this.#anchor = anchor
    this.#pageSize = pageSize
    this.#projection = projection
    this.#cache = cache
    this.#initialLogCount = resume?.baseline.logCount ?? 0
    this.#scanBaseline = resume ? copyBaseline(resume.baseline) : undefined
  }

  static async open(
    anchorValue: unknown,
    accountsValue: unknown,
    optionsValue: OpenProfileProjectionRunOptions = {},
  ) {
    const anchor = normalizeAnchor(anchorValue)
    if (!isRecord(optionsValue)) throw projectionRunError('options')
    const pageSize = optionsValue.pageSize ?? PROFILE_EVENT_PAGE_SIZE
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > PROFILE_EVENT_PAGE_SIZE
    ) {
      throw projectionRunError('page size')
    }
    const requested = new ProfileProjection(accountsValue)
    const resume = normalizeResume(optionsValue.resume, anchor, requested)
    const projection = resume?.projection ?? requested
    const cache = await openEventCache({
      databaseName: optionsValue.databaseName,
      factory: optionsValue.factory,
      filter: PROFILE_SET_FILTER,
      keyRange: optionsValue.keyRange,
    })
    try {
      if (resume) {
        await cache.authenticateDerivedState(resume.baseline, resume.binding)
      }
      return new ProfileProjectionRun(
        anchor,
        pageSize,
        projection,
        cache,
        resume,
      )
    } catch (error) {
      cache.close()
      throw error
    }
  }

  get snapshot(): ProfileProjectionRunSnapshot {
    return {
      chainId: this.#anchor.chainId,
      profilesRetained: BigInt(this.#projection.snapshot.profiles.length),
      head: this.#anchor.head,
      logsProcessed: this.#logsProcessed,
      pagesScanned: this.#pagesScanned,
      phase: this.#phase,
      safeHead: this.#anchor.safeHead,
    }
  }

  get baseline() {
    if (this.#phase !== 'complete' || !this.#baseline) {
      throw new Error('The profile projection is not complete.')
    }
    return copyBaseline(this.#baseline)
  }

  get progress(): ProfileProjectionPosition | undefined {
    if (this.#phase !== 'complete') {
      throw new Error('The profile projection is not complete.')
    }
    return this.#projection.progress
  }

  get projectionSnapshot(): ProfileProjectionSnapshot {
    if (this.#phase !== 'complete') {
      throw new Error('The profile projection is not complete.')
    }
    return this.#projection.snapshot
  }

  get resumeState(): ProfileProjectionResumeState {
    if (this.#phase !== 'complete' || !this.#baseline || !this.#binding) {
      throw new Error('The profile projection is not complete.')
    }
    return {
      baseline: copyBaseline(this.#baseline),
      binding: copyBinding(this.#binding),
      projection: this.#projection.snapshot,
    }
  }

  get trackedAccounts() {
    return this.#projection.trackedAccounts
  }

  getProfile(account: unknown) {
    if (this.#phase !== 'complete') {
      throw new Error('The profile projection is not complete.')
    }
    return this.#projection.getProfile(account)
  }

  async advance(): Promise<ProfileProjectionRunSnapshot> {
    if (this.#advancing) {
      throw new Error('The profile projection is already advancing.')
    }
    if (this.#phase === 'complete') return this.snapshot
    if (this.#phase === 'failed') throw this.#failure
    if (this.#phase === 'closed') {
      throw new Error('The profile projection run is closed.')
    }
    if (this.#phase === 'authenticate') {
      this.#advancing = true
      try {
        await this.#authenticateBaseline()
        return this.snapshot
      } catch (error) {
        const failure = asError(error)
        if (this.#readPhase() !== 'closed') this.#fail(failure)
        throw failure
      } finally {
        this.#advancing = false
      }
    }
    const cache = this.#cache
    if (!cache) throw projectionRunError('cache state')
    this.#advancing = true
    try {
      const page = await cache.scan(getSeed(this.#anchor.profiles), {
        baseline: this.#continuation ? undefined : this.#scanBaseline,
        continuation: this.#continuation,
        limit: this.#pageSize,
        resetOnCorruption: false,
      })
      const currentPhase = this.#readPhase()
      if (currentPhase === 'closed') {
        throw new Error('The profile projection run is closed.')
      }
      if (currentPhase !== 'profiles') throw projectionRunError('phase')
      this.#applyPage(page)
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
      this.#closeCache()
      return
    }
    this.#phase = 'closed'
    this.#interruption.abort()
    this.#projection.reset()
    this.#baseline = undefined
    this.#binding = undefined
    this.#continuation = undefined
    this.#scanBaseline = undefined
    this.#closeCache()
  }

  #applyPage(page: EventCacheScanPage) {
    assertPageShape(page)
    if (!sameCachePosition(page, this.#anchor.profiles)) {
      throw projectionRunError('cache anchor')
    }
    this.#projection.applyLogs(page.logs)
    this.#scanBaseline = undefined
    this.#logsProcessed += BigInt(page.logs.length)
    this.#pagesScanned += 1n
    if (!page.complete) {
      this.#continuation = page.next
      return
    }
    const baseline = page.baseline!
    const progress = this.#projection.progress
    if (
      !sameCachePosition(baseline, this.#anchor.profiles) ||
      BigInt(baseline.logCount) !==
        BigInt(this.#initialLogCount) + this.#logsProcessed
    ) {
      throw projectionRunError('completed baseline')
    }
    if (
      baseline.last === undefined
        ? progress !== undefined
        : progress === undefined ||
          baseline.last.blockNumber !== progress.blockNumber ||
          baseline.last.logIndex !== progress.logIndex
    ) {
      throw projectionRunError('completed tail')
    }
    this.#baseline = copyBaseline(baseline)
    this.#continuation = undefined
    this.#phase = 'authenticate'
  }

  async #authenticateBaseline() {
    const cache = this.#cache
    const baseline = this.#baseline
    if (!cache || !baseline) {
      throw projectionRunError('baseline authentication state')
    }
    await cache.authenticateBaselines([
      {
        baseline,
        filter: PROFILE_SET_FILTER,
        seed: getSeed(this.#anchor.profiles),
      },
    ])
    let currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The profile projection run is closed.')
    }
    if (currentPhase !== 'authenticate') throw projectionRunError('phase')
    if (this.#anchor.safeHead !== undefined) {
      const checkpoint = this.#anchor.profiles.cursor.checkpoints.at(-1)
      if (!checkpoint || checkpoint.blockNumber !== this.#anchor.safeHead) {
        throw projectionRunError('confirmed projection boundary')
      }
      this.#projection.confirmThrough(checkpoint)
    }
    const digest = getProfileProjectionSnapshotDigest(this.#projection.snapshot)
    let binding: EventCacheDerivedStateBinding | undefined
    await authenticateIssuedProfileProjectionAnchor(
      this.#anchor.issued,
      async () => {
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The profile projection run is closed.')
        }
        binding = await cache.bindDerivedState(baseline, digest)
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The profile projection run is closed.')
        }
      },
      this.#interruption.signal,
    )
    currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The profile projection run is closed.')
    }
    if (currentPhase !== 'authenticate') throw projectionRunError('phase')
    if (!binding) throw projectionRunError('derived state binding')
    this.#binding = copyBinding(binding)
    this.#closeCache()
    this.#phase = 'complete'
  }

  #fail(error: Error) {
    this.#failure = error
    this.#phase = 'failed'
    this.#interruption.abort()
    this.#projection.reset()
    this.#baseline = undefined
    this.#binding = undefined
    this.#continuation = undefined
    this.#scanBaseline = undefined
    this.#closeCache()
  }

  #closeCache() {
    this.#cache?.close()
    this.#cache = undefined
  }

  #readPhase(): ProfileProjectionRunPhase {
    return this.#phase
  }
}

export function openProfileProjectionRun(
  anchor: ProfileProjectionAnchor,
  accounts: readonly Address[],
  options?: OpenProfileProjectionRunOptions,
) {
  return ProfileProjectionRun.open(anchor, accounts, options)
}
