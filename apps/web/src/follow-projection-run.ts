import { getAddress, isAddress, type Address } from 'viem'
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
  FollowProjection,
  type FollowDirection,
  type FollowProjectionProgress,
  type FollowProjectionReadOptions,
} from './follow-projection'
import {
  FOLLOW_EVENT_PAGE_SIZE,
  assertIssuedFollowProjectionAnchor,
  authenticateIssuedFollowProjectionAnchor,
  type FollowProjectionAnchor,
  type FollowStreamStorageOptions,
} from './follow-stream'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { getFollowersFilter, getFollowingFilter } from './protocol-events'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type FollowProjectionRunPhase =
  'follows' | 'authenticate' | 'complete' | 'failed' | 'closed'

export type FollowProjectionRunSnapshot = {
  account: Address
  chainId: bigint
  direction: FollowDirection
  head: bigint
  logsProcessed: bigint
  relationshipsRetained: bigint
  pagesScanned: bigint
  phase: FollowProjectionRunPhase
  safeHead?: bigint
  startBlock: bigint
}

export type OpenFollowProjectionRunOptions = FollowStreamStorageOptions & {
  pageSize?: number
}

type NormalizedProjectionAnchor = {
  account: Address
  chainId: bigint
  direction: FollowDirection
  head: bigint
  issued: FollowProjectionAnchor
  follows: EventCachePosition
  safeHead?: bigint
}

function projectionRunError(message: string) {
  return new Error(`Invalid follow projection run ${message}.`)
}

function asError(value: unknown) {
  return value instanceof Error
    ? value
    : new Error('The follow projection run failed.')
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

function normalizeAccount(value: unknown) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw projectionRunError('anchor account')
  }
  const account = getAddress(value)
  if (account.toLowerCase() === ZERO_ADDRESS) {
    throw projectionRunError('anchor account')
  }
  return account
}

function normalizeDirection(value: unknown): FollowDirection {
  if (value !== 'followers' && value !== 'following') {
    throw projectionRunError('anchor direction')
  }
  return value
}

function getFollowFilter(account: Address, direction: FollowDirection) {
  return direction === 'followers'
    ? getFollowersFilter(account)
    : getFollowingFilter(account)
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
  chainId: bigint,
  filter: ReturnType<typeof getFollowFilter>,
  safeHead: bigint | undefined,
) {
  if (!isRecord(value)) throw projectionRunError('anchor position')
  let cursor: EventCursor
  try {
    cursor = validateEventCursor(value.cursor)
  } catch {
    throw projectionRunError('anchor cursor')
  }
  const seed = createEventCursor({
    chainId,
    filter,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: cursor.startBlock,
  })
  const expectedNextBlock =
    safeHead === undefined ? cursor.startBlock : safeHead + 1n
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
  const account = normalizeAccount(value.account)
  const direction = normalizeDirection(value.direction)
  assertQuantity(value.chainId, 'anchor chain identifier')
  assertQuantity(value.head, 'anchor head')
  const safeHead =
    value.head >= POST_FEED_CONFIRMATION_DEPTH
      ? value.head - POST_FEED_CONFIRMATION_DEPTH
      : undefined
  if (value.safeHead !== safeHead) {
    throw projectionRunError('anchor safe head')
  }
  const follows = normalizeCachePosition(
    value.follows,
    value.chainId,
    getFollowFilter(account, direction),
    safeHead,
  )
  if (safeHead !== undefined) {
    const checkpoint = follows.cursor.checkpoints.at(-1)
    if (!checkpoint || checkpoint.blockNumber !== safeHead) {
      throw projectionRunError('anchor safe-head checkpoint')
    }
  }
  assertIssuedFollowProjectionAnchor(value)
  return {
    account,
    chainId: value.chainId,
    direction,
    head: value.head,
    issued: value,
    follows,
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

export class FollowProjectionRun {
  readonly #anchor: NormalizedProjectionAnchor
  readonly #pageSize: number
  readonly #projection: FollowProjection
  #advancing = false
  #baseline?: EventCacheScanBaseline
  #cache?: BrowserEventCache
  #continuation?: EventCacheScanCursor
  #failure?: Error
  readonly #interruption = new AbortController()
  #logsProcessed = 0n
  #pagesScanned = 0n
  #phase: FollowProjectionRunPhase = 'follows'

  private constructor(
    anchor: NormalizedProjectionAnchor,
    pageSize: number,
    projection: FollowProjection,
    cache: BrowserEventCache,
  ) {
    this.#anchor = anchor
    this.#pageSize = pageSize
    this.#projection = projection
    this.#cache = cache
  }

  static async open(
    anchorValue: unknown,
    optionsValue: OpenFollowProjectionRunOptions = {},
  ) {
    const anchor = normalizeAnchor(anchorValue)
    if (!isRecord(optionsValue)) throw projectionRunError('options')
    const pageSize = optionsValue.pageSize ?? FOLLOW_EVENT_PAGE_SIZE
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > FOLLOW_EVENT_PAGE_SIZE
    ) {
      throw projectionRunError('page size')
    }
    const projection = new FollowProjection(anchor.account, anchor.direction)
    const cache = await openEventCache({
      databaseName: optionsValue.databaseName,
      factory: optionsValue.factory,
      filter: getFollowFilter(anchor.account, anchor.direction),
      keyRange: optionsValue.keyRange,
    })
    return new FollowProjectionRun(anchor, pageSize, projection, cache)
  }

  get snapshot(): FollowProjectionRunSnapshot {
    return {
      account: this.#anchor.account,
      chainId: this.#anchor.chainId,
      direction: this.#anchor.direction,
      head: this.#anchor.head,
      logsProcessed: this.#logsProcessed,
      relationshipsRetained: this.#projection.progress.relationshipCount,
      pagesScanned: this.#pagesScanned,
      phase: this.#phase,
      safeHead: this.#anchor.safeHead,
      startBlock: this.#anchor.follows.cursor.startBlock,
    }
  }

  get baseline() {
    if (this.#phase !== 'complete' || !this.#baseline) {
      throw new Error('The follow projection is not complete.')
    }
    return copyBaseline(this.#baseline)
  }

  get account() {
    return this.#projection.account
  }

  get direction() {
    return this.#projection.direction
  }

  get startBlock() {
    return this.#anchor.follows.cursor.startBlock
  }

  get progress(): FollowProjectionProgress {
    if (this.#phase !== 'complete') {
      throw new Error('The follow projection is not complete.')
    }
    return this.#projection.progress
  }

  getRelationship(account: unknown) {
    if (this.#phase !== 'complete') {
      throw new Error('The follow projection is not complete.')
    }
    return this.#projection.getRelationship(account)
  }

  hasRelationship(account: unknown) {
    if (this.#phase !== 'complete') {
      throw new Error('The follow projection is not complete.')
    }
    return this.#projection.hasRelationship(account)
  }

  readRelationships(options?: FollowProjectionReadOptions) {
    if (this.#phase !== 'complete') {
      throw new Error('The follow projection is not complete.')
    }
    return this.#projection.readRelationships(options)
  }

  async advance(): Promise<FollowProjectionRunSnapshot> {
    if (this.#advancing) {
      throw new Error('The follow projection is already advancing.')
    }
    if (this.#phase === 'complete') return this.snapshot
    if (this.#phase === 'failed') throw this.#failure
    if (this.#phase === 'closed') {
      throw new Error('The follow projection run is closed.')
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
      const page = await cache.scan(getSeed(this.#anchor.follows), {
        continuation: this.#continuation,
        limit: this.#pageSize,
        resetOnCorruption: false,
      })
      const currentPhase = this.#readPhase()
      if (currentPhase === 'closed') {
        throw new Error('The follow projection run is closed.')
      }
      if (currentPhase !== 'follows') throw projectionRunError('phase')
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
    if (!sameCachePosition(page, this.#anchor.follows)) {
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
      !sameCachePosition(baseline, this.#anchor.follows) ||
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
    const filter = getFollowFilter(this.#anchor.account, this.#anchor.direction)
    await cache.authenticateBaselines([
      {
        baseline,
        filter,
        seed: getSeed(this.#anchor.follows),
      },
    ])
    let currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The follow projection run is closed.')
    }
    if (currentPhase !== 'authenticate') throw projectionRunError('phase')
    await authenticateIssuedFollowProjectionAnchor(
      this.#anchor.issued,
      async () => {
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The follow projection run is closed.')
        }
        await cache.authenticateBaselines([
          {
            baseline,
            filter,
            seed: getSeed(this.#anchor.follows),
          },
        ])
        if (this.#readPhase() !== 'authenticate') {
          throw new Error('The follow projection run is closed.')
        }
      },
      this.#interruption.signal,
    )
    currentPhase = this.#readPhase()
    if (currentPhase === 'closed') {
      throw new Error('The follow projection run is closed.')
    }
    if (currentPhase !== 'authenticate') throw projectionRunError('phase')
    if (this.#anchor.safeHead !== undefined) {
      const checkpoint = this.#anchor.follows.cursor.checkpoints.at(-1)
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

  #readPhase(): FollowProjectionRunPhase {
    return this.#phase
  }
}

export function openFollowProjectionRun(
  anchor: FollowProjectionAnchor,
  options?: OpenFollowProjectionRunOptions,
) {
  return FollowProjectionRun.open(anchor, options)
}
