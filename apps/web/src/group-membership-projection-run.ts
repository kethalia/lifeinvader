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
import {
  GroupMembershipProjection,
  type GroupMembershipProjectionProgress,
  type GroupMembershipProjectionReadOptions,
} from './group-membership-projection'
import {
  GROUP_MEMBERSHIP_EVENT_PAGE_SIZE,
  assertIssuedGroupMembershipProjectionAnchor,
  authenticateIssuedGroupMembershipProjectionAnchor,
  type GroupMembershipProjectionAnchor,
  type GroupMembershipStreamStorageOptions,
} from './group-membership-stream'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { getGroupMembershipFilter } from './protocol-events'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

export type GroupMembershipProjectionRunPhase =
  'memberships' | 'authenticate' | 'complete' | 'failed' | 'closed'

export type GroupMembershipProjectionRunSnapshot = {
  chainId: bigint
  groupId: bigint
  head: bigint
  logsProcessed: bigint
  membersRetained: bigint
  pagesScanned: bigint
  phase: GroupMembershipProjectionRunPhase
  safeHead?: bigint
  startBlock: bigint
}

export type OpenGroupMembershipProjectionRunOptions =
  GroupMembershipStreamStorageOptions & {
    pageSize?: number
  }

type NormalizedProjectionAnchor = {
  chainId: bigint
  groupId: bigint
  head: bigint
  issued: GroupMembershipProjectionAnchor
  memberships: EventCachePosition
  safeHead?: bigint
}

function projectionRunError(message: string) {
  return new Error(`Invalid group membership projection run ${message}.`)
}

function asError(value: unknown) {
  return value instanceof Error
    ? value
    : new Error('The group membership projection run failed.')
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

function assertGroupId(value: unknown): asserts value is bigint {
  assertQuantity(value, 'anchor group identifier')
  if (value === 0n) throw projectionRunError('anchor group identifier')
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
  assertGroupId(value.groupId)
  assertQuantity(value.head, 'anchor head')
  const safeHead =
    value.head >= POST_FEED_CONFIRMATION_DEPTH
      ? value.head - POST_FEED_CONFIRMATION_DEPTH
      : undefined
  if (value.safeHead !== safeHead) {
    throw projectionRunError('anchor safe head')
  }
  if (!isRecord(value.memberships)) {
    throw projectionRunError('anchor position')
  }
  let membershipCursor: EventCursor
  try {
    membershipCursor = validateEventCursor(value.memberships.cursor)
  } catch {
    throw projectionRunError('anchor cursor')
  }
  const startBlock = membershipCursor.startBlock
  const expectedNextBlock = safeHead === undefined ? startBlock : safeHead + 1n
  const seed = createEventCursor({
    chainId: value.chainId,
    filter: getGroupMembershipFilter(value.groupId),
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock,
  })
  const memberships = normalizeCachePosition(
    value.memberships,
    seed,
    expectedNextBlock,
  )
  if (safeHead !== undefined) {
    const checkpoint = memberships.cursor.checkpoints.at(-1)
    if (!checkpoint || checkpoint.blockNumber !== safeHead) {
      throw projectionRunError('anchor safe-head checkpoint')
    }
  }
  assertIssuedGroupMembershipProjectionAnchor(value)
  return {
    chainId: value.chainId,
    groupId: value.groupId,
    head: value.head,
    issued: value,
    memberships,
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

export class GroupMembershipProjectionRun {
  readonly #anchor: NormalizedProjectionAnchor
  readonly #pageSize: number
  readonly #projection: GroupMembershipProjection
  #advancing = false
  #baseline?: EventCacheScanBaseline
  #cache?: BrowserEventCache
  #continuation?: EventCacheScanCursor
  #failure?: Error
  readonly #interruption = new AbortController()
  #logsProcessed = 0n
  #pagesScanned = 0n
  #phase: GroupMembershipProjectionRunPhase = 'memberships'

  private constructor(
    anchor: NormalizedProjectionAnchor,
    pageSize: number,
    projection: GroupMembershipProjection,
    cache: BrowserEventCache,
  ) {
    this.#anchor = anchor
    this.#pageSize = pageSize
    this.#projection = projection
    this.#cache = cache
  }

  static async open(
    anchorValue: unknown,
    optionsValue: OpenGroupMembershipProjectionRunOptions = {},
  ) {
    const anchor = normalizeAnchor(anchorValue)
    if (!isRecord(optionsValue)) throw projectionRunError('options')
    const pageSize = optionsValue.pageSize ?? GROUP_MEMBERSHIP_EVENT_PAGE_SIZE
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > GROUP_MEMBERSHIP_EVENT_PAGE_SIZE
    ) {
      throw projectionRunError('page size')
    }
    const projection = new GroupMembershipProjection(anchor.groupId)
    const cache = await openEventCache({
      databaseName: optionsValue.databaseName,
      factory: optionsValue.factory,
      filter: getGroupMembershipFilter(anchor.groupId),
      keyRange: optionsValue.keyRange,
    })
    return new GroupMembershipProjectionRun(anchor, pageSize, projection, cache)
  }

  get snapshot(): GroupMembershipProjectionRunSnapshot {
    return {
      chainId: this.#anchor.chainId,
      groupId: this.#anchor.groupId,
      head: this.#anchor.head,
      logsProcessed: this.#logsProcessed,
      membersRetained: this.#projection.progress.memberCount,
      pagesScanned: this.#pagesScanned,
      phase: this.#phase,
      safeHead: this.#anchor.safeHead,
      startBlock: this.#anchor.memberships.cursor.startBlock,
    }
  }

  get baseline() {
    if (this.#phase !== 'complete' || !this.#baseline) {
      throw new Error('The group membership projection is not complete.')
    }
    return copyBaseline(this.#baseline)
  }

  get groupId() {
    return this.#projection.groupId
  }

  get startBlock() {
    return this.#anchor.memberships.cursor.startBlock
  }

  get progress(): GroupMembershipProjectionProgress {
    if (this.#phase !== 'complete') {
      throw new Error('The group membership projection is not complete.')
    }
    return this.#projection.progress
  }

  getMember(account: unknown) {
    if (this.#phase !== 'complete') {
      throw new Error('The group membership projection is not complete.')
    }
    return this.#projection.getMember(account)
  }

  isMember(account: unknown) {
    if (this.#phase !== 'complete') {
      throw new Error('The group membership projection is not complete.')
    }
    return this.#projection.isMember(account)
  }

  readMembers(options?: GroupMembershipProjectionReadOptions) {
    if (this.#phase !== 'complete') {
      throw new Error('The group membership projection is not complete.')
    }
    return this.#projection.readMembers(options)
  }

  async advance(): Promise<GroupMembershipProjectionRunSnapshot> {
    if (this.#advancing) {
      throw new Error('The group membership projection is already advancing.')
    }
    if (this.#phase === 'complete') return this.snapshot
    if (this.#phase === 'failed') throw this.#failure
    if (this.#phase === 'closed') {
      throw new Error('The group membership projection run is closed.')
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
      const page = await cache.scan(getSeed(this.#anchor.memberships), {
        continuation: this.#continuation,
        limit: this.#pageSize,
        resetOnCorruption: false,
      })
      const currentPhase = this.#readPhase()
      if (currentPhase === 'closed') {
        throw new Error('The group membership projection run is closed.')
      }
      if (currentPhase !== 'memberships') throw projectionRunError('phase')
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
    this.#continuation = undefined
    this.#closeCache()
  }

  #applyPage(page: EventCacheScanPage) {
    assertPageShape(page)
    if (!sameCachePosition(page, this.#anchor.memberships)) {
      throw projectionRunError('cache anchor')
    }
    this.#projection.applyLogs(page.logs)
    this.#logsProcessed += BigInt(page.logs.length)
    this.#pagesScanned += 1n
    if (!page.complete) {
      this.#continuation = page.next
      return
    }
    const baseline = page.baseline!
    const progress = this.#projection.progress
    if (
      !sameCachePosition(baseline, this.#anchor.memberships) ||
      BigInt(baseline.logCount) !== this.#logsProcessed ||
      progress.signalCount !== this.#logsProcessed
    ) {
      throw projectionRunError('completed baseline')
    }
    if (
      baseline.last === undefined
        ? progress.last !== undefined
        : progress.last === undefined ||
          baseline.last.blockNumber !== progress.last.blockNumber ||
          baseline.last.logIndex !== progress.last.logIndex
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
    const filter = getGroupMembershipFilter(this.#anchor.groupId)
    await cache.authenticateBaselines([
      {
        baseline,
        filter,
        seed: getSeed(this.#anchor.memberships),
      },
    ])
    let currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The group membership projection run is closed.')
    }
    if (currentPhase !== 'authenticate') throw projectionRunError('phase')
    await authenticateIssuedGroupMembershipProjectionAnchor(
      this.#anchor.issued,
      async () => {
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The group membership projection run is closed.')
        }
        await cache.authenticateBaselines([
          {
            baseline,
            filter,
            seed: getSeed(this.#anchor.memberships),
          },
        ])
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The group membership projection run is closed.')
        }
      },
      this.#interruption.signal,
    )
    currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The group membership projection run is closed.')
    }
    if (currentPhase !== 'authenticate') throw projectionRunError('phase')
    if (this.#anchor.safeHead !== undefined) {
      const checkpoint = this.#anchor.memberships.cursor.checkpoints.at(-1)
      if (!checkpoint || checkpoint.blockNumber !== this.#anchor.safeHead) {
        throw projectionRunError('confirmed projection boundary')
      }
      this.#projection.confirmThrough(checkpoint)
    }
    this.#closeCache()
    this.#phase = 'complete'
  }

  #fail(error: Error) {
    this.#failure = error
    this.#phase = 'failed'
    this.#interruption.abort()
    this.#projection.reset()
    this.#baseline = undefined
    this.#continuation = undefined
    this.#closeCache()
  }

  #closeCache() {
    this.#cache?.close()
    this.#cache = undefined
  }

  #readPhase(): GroupMembershipProjectionRunPhase {
    return this.#phase
  }
}

export function openGroupMembershipProjectionRun(
  anchor: GroupMembershipProjectionAnchor,
  options?: OpenGroupMembershipProjectionRunOptions,
) {
  return GroupMembershipProjectionRun.open(anchor, options)
}
