import { keccak256, stringToHex, type Hash } from 'viem'
import {
  eventTransactionsAreConsistent,
  indexedEventLogMatchesFilter,
  normalizeEventLogFilter,
  validateEventCursor,
  validateIndexedEventLog,
  type EventCursor,
  type EventLogFilter,
  type EventSyncResult,
  type IndexedEventLog,
  type NormalizedEventLogFilter,
} from './event-indexer'

const CACHE_SCHEMA_VERSION = 7
const DEFAULT_DATABASE_NAME = 'lifeinvader-event-cache'
const SCOPE_STORE = 'scopes'
const CURSOR_STORE = 'cursors'
const LOG_STORE = 'logs'
const LOG_IDENTITY_INDEX = 'identity'
const LOG_SCOPE_INDEX = 'scope'
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_BATCH_LOGS = 5_000
const MAX_SCAN_LOGS = MAX_BATCH_LOGS + MAX_PAGE_SIZE
const MAX_MAINTENANCE_LOGS = MAX_BATCH_LOGS
const MAX_SCAN_SESSIONS = 16
const MAX_BASELINE_AUTHENTICATIONS = 16
const MAX_EVM_QUANTITY = (1n << 256n) - 1n

type CursorRecord = {
  cursor: unknown
  schemaVersion: number
  scope: string
}
type ScopeRecord = {
  baselineKey: string
  filter: unknown
  generation: string
  lastLog?: unknown
  logCount: number
  logDigest: unknown
  revision: bigint
  schemaVersion: number
  scope: string
}
type ScopeState = {
  baselineKey: string
  filter: NormalizedEventLogFilter
  generation: string
  lastLog?: EventCacheLogPosition
  logCount: number
  logDigest: Hash
  revision: bigint
}
type LogRecord = {
  digest: Hash
  identity: string
  log: unknown
  ordinal: number
  position: string
  schemaVersion: number
  scope: string
}
type StoredLogRecord = {
  digest: Hash
  log: IndexedEventLog
  ordinal: number
}
type LogIntegrity = {
  digest: Hash
  lastLog?: EventCacheLogPosition
  logCount: number
}
export type EventCachePosition = {
  cursor: EventCursor
  generation: string
  revision: bigint
}
export type EventCachePage = EventCachePosition & {
  logs: readonly IndexedEventLog[]
  reset: boolean
}
export type EventCacheLogPosition = {
  blockNumber: bigint
  logIndex: number
}
export type EventCacheScanCursor = EventCachePosition & {
  after: EventCacheLogPosition
  digest: Hash
  fromBlock: bigint
  logCount: number
  session: string
}
export type EventCacheScanBaseline = EventCachePosition & {
  digest: Hash
  last?: EventCacheLogPosition
  logCount: number
  proof: Hash
}
export type EventCacheDerivedStateBinding = {
  digest: Hash
  proof: Hash
}
export type EventCacheScanPage = EventCachePosition & {
  baseline?: EventCacheScanBaseline
  complete: boolean
  logs: readonly IndexedEventLog[]
  next?: EventCacheScanCursor
  reset: boolean
}
export type EventCacheScanOptions = {
  baseline?: EventCacheScanBaseline
  continuation?: EventCacheScanCursor
  limit?: number
  resetOnCorruption?: boolean
}
export type EventCacheBaselineAuthentication = {
  baseline: EventCacheScanBaseline
  filter: EventLogFilter
  seed: EventCursor
}
export type OpenEventCacheOptions = {
  databaseName?: string
  factory?: IDBFactory
  filter: EventLogFilter
  keyRange?: typeof IDBKeyRange
  maintenanceLogLimit?: number
}

type NormalizedBaselineAuthentication = {
  baseline: EventCacheScanBaseline
  filter: NormalizedEventLogFilter
  scope: string
  seed: EventCursor
}
type BaselineAuthenticationRead = {
  cursorRecord?: unknown
  firstLogRecord?: unknown
  lastLogRecord?: unknown
  scopeRecord?: unknown
}

class EventCacheCorruptionError extends Error {}

export class DeferredEventCacheCorruptionError extends Error {
  constructor() {
    super(
      'The browser event cache is corrupt and was not reset. Synchronize again.',
    )
    this.name = 'DeferredEventCacheCorruptionError'
  }
}

export function isDeferredEventCacheCorruptionError(
  error: unknown,
): error is Error {
  return error instanceof DeferredEventCacheCorruptionError
}

const EMPTY_LOG_DIGEST = keccak256(
  stringToHex('lifeinvader.event-cache.log-chain.v1'),
)

function cacheError(message: string) {
  return new Error(message)
}
function defaultCreateGeneration() {
  const crypto = globalThis.crypto
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw cacheError('Secure browser randomness is unavailable.')
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}
function isGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : cacheError(fallback)
}
function isSeedCursor(cursor: EventCursor) {
  return (
    cursor.checkpoints.length === 0 && cursor.nextBlock === cursor.startBlock
  )
}
function getSeedCursor(cursor: EventCursor): EventCursor {
  return {
    ...cursor,
    checkpoints: [],
    nextBlock: cursor.startBlock,
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
function sameCursorIdentity(first: EventCursor, second: EventCursor) {
  return (
    first.chainId === second.chainId &&
    first.finalityDepth === second.finalityDepth &&
    first.filterId === second.filterId &&
    first.startBlock === second.startBlock
  )
}
function fixedHex(value: bigint | number, width: number) {
  const encoded = value.toString(16)
  if (encoded.length > width) throw cacheError('Invalid event cache position.')
  return encoded.padStart(width, '0')
}
function getLogPosition(
  log: Pick<IndexedEventLog, 'blockNumber' | 'logIndex'>,
) {
  return `${fixedHex(log.blockNumber, 64)}:${fixedHex(log.logIndex, 16)}`
}
function getLogIdentity(log: IndexedEventLog) {
  return getLogPosition(log)
}
function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  const firstPosition = getLogPosition(first)
  const secondPosition = getLogPosition(second)
  if (firstPosition === secondPosition) return 0
  return firstPosition < secondPosition ? -1 : 1
}
function getLogStreamProblem(
  logs: readonly IndexedEventLog[],
  cursor: EventCursor,
  filter: NormalizedEventLogFilter,
) {
  const identities = new Set<string>()
  const blockHashes = new Map(
    cursor.checkpoints.map((checkpoint) => [
      checkpoint.blockNumber.toString(),
      checkpoint.blockHash.toLowerCase(),
    ]),
  )
  for (const log of logs) {
    if (!indexedEventLogMatchesFilter(log, filter)) return 'out-of-filter logs'
    const identity = getLogIdentity(log)
    if (identities.has(identity)) return 'duplicate block/log-index pairs'
    identities.add(identity)
    const block = log.blockNumber.toString()
    const blockHash = log.blockHash.toLowerCase()
    const knownHash = blockHashes.get(block)
    if (knownHash !== undefined && knownHash !== blockHash) {
      return 'conflicting block hashes'
    }
    blockHashes.set(block, blockHash)
  }
  if (!eventTransactionsAreConsistent(logs)) {
    return 'inconsistent transaction metadata'
  }
  return undefined
}
function assertPageSize(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw cacheError('Invalid event cache page size.')
  }
}
function normalizeMaintenanceLogLimit(value: unknown) {
  const limit = value ?? MAX_MAINTENANCE_LOGS
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MAINTENANCE_LOGS
  ) {
    throw cacheError('Invalid event cache maintenance log limit.')
  }
  return limit
}
function maintenanceLimitError(
  operation: 'repair' | 'rollback',
  limit: number,
) {
  return cacheError(
    `The browser event cache ${operation} exceeded its ${limit.toString()}-log work limit. Clear this site's stored data before synchronizing again.`,
  )
}
function assertScanBlock(
  value: unknown,
  field: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_EVM_QUANTITY) {
    throw cacheError(`Invalid event cache ${field}.`)
  }
}
function normalizeLogPosition(value: unknown): EventCacheLogPosition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw cacheError('Invalid event cache scan position.')
  }
  const position = value as Partial<EventCacheLogPosition>
  assertScanBlock(position.blockNumber, 'scan block number')
  if (
    typeof position.logIndex !== 'number' ||
    !Number.isSafeInteger(position.logIndex) ||
    position.logIndex < 0
  ) {
    throw cacheError('Invalid event cache scan log index.')
  }
  return {
    blockNumber: position.blockNumber,
    logIndex: position.logIndex,
  }
}
function sameLogPosition(
  first: EventCacheLogPosition,
  second: EventCacheLogPosition,
) {
  return (
    first.blockNumber === second.blockNumber &&
    first.logIndex === second.logIndex
  )
}
function getPublicLogPosition(log: IndexedEventLog): EventCacheLogPosition {
  return { blockNumber: log.blockNumber, logIndex: log.logIndex }
}
function isLogDigest(value: unknown): value is Hash {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
}
function normalizeDerivedStateDigest(value: unknown) {
  if (!isLogDigest(value)) {
    throw cacheError('Invalid event cache derived state digest.')
  }
  return value
}
function normalizeDerivedStateBinding(
  value: unknown,
): EventCacheDerivedStateBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw cacheError('Invalid event cache derived state binding.')
  }
  const binding = value as Partial<EventCacheDerivedStateBinding>
  return {
    digest: normalizeDerivedStateDigest(binding.digest),
    proof: normalizeDerivedStateDigest(binding.proof),
  }
}
function normalizeLogIntegrity(
  value: {
    digest?: unknown
    last?: unknown
    logCount?: unknown
  },
  field: string,
): LogIntegrity {
  if (
    !isLogDigest(value.digest) ||
    typeof value.logCount !== 'number' ||
    !Number.isSafeInteger(value.logCount) ||
    value.logCount < 0
  ) {
    throw cacheError(`Invalid event cache ${field} integrity.`)
  }
  if (value.logCount === 0) {
    if (value.digest !== EMPTY_LOG_DIGEST || value.last !== undefined) {
      throw cacheError(`Invalid event cache ${field} integrity.`)
    }
    return { digest: value.digest, logCount: 0 }
  }
  if (value.last === undefined) {
    throw cacheError(`Invalid event cache ${field} integrity.`)
  }
  return {
    digest: value.digest,
    lastLog: normalizeLogPosition(value.last),
    logCount: value.logCount,
  }
}
function advanceLogIntegrity(
  integrity: LogIntegrity,
  log: IndexedEventLog,
): LogIntegrity {
  if (integrity.logCount === Number.MAX_SAFE_INTEGER) {
    throw new EventCacheCorruptionError()
  }
  const digest = keccak256(
    stringToHex(
      JSON.stringify([
        integrity.digest,
        log.address.toLowerCase(),
        log.blockHash,
        log.blockNumber.toString(16),
        log.data,
        log.logIndex.toString(16),
        log.topics,
        log.transactionHash,
        log.transactionIndex.toString(16),
      ]),
    ),
  )
  return {
    digest,
    lastLog: getPublicLogPosition(log),
    logCount: integrity.logCount + 1,
  }
}
function storedRecordMatchesIntegrity(
  record: StoredLogRecord,
  integrity: LogIntegrity,
) {
  return (
    record.digest === integrity.digest &&
    record.ordinal === integrity.logCount &&
    integrity.lastLog !== undefined &&
    sameLogPosition(getPublicLogPosition(record.log), integrity.lastLog)
  )
}
function stateMatchesIntegrity(state: ScopeState, integrity: LogIntegrity) {
  return (
    state.logDigest === integrity.digest &&
    state.logCount === integrity.logCount &&
    (state.lastLog === undefined
      ? integrity.lastLog === undefined
      : integrity.lastLog !== undefined &&
        sameLogPosition(state.lastLog, integrity.lastLog))
  )
}
function getScanBaselineProof(
  baselineKey: string,
  baseline: Omit<EventCacheScanBaseline, 'proof'>,
) {
  const { cursor } = baseline
  return keccak256(
    stringToHex(
      JSON.stringify([
        'lifeinvader.event-cache.scan-baseline.v1',
        baselineKey,
        baseline.generation,
        baseline.revision.toString(16),
        baseline.digest,
        baseline.logCount.toString(16),
        baseline.last
          ? [
              baseline.last.blockNumber.toString(16),
              baseline.last.logIndex.toString(16),
            ]
          : null,
        cursor.chainId.toString(16),
        cursor.filterId,
        cursor.startBlock.toString(16),
        cursor.finalityDepth.toString(16),
        cursor.nextBlock.toString(16),
        cursor.rangeSize.toString(16),
        cursor.checkpoints.map((checkpoint) => [
          checkpoint.blockNumber.toString(16),
          checkpoint.blockHash,
        ]),
      ]),
    ),
  )
}
function getDerivedStateProof(
  baselineKey: string,
  baselineProof: Hash,
  digest: Hash,
) {
  return keccak256(
    stringToHex(
      JSON.stringify([
        'lifeinvader.event-cache.derived-state.v1',
        baselineKey,
        baselineProof,
        digest,
      ]),
    ),
  )
}
function normalizeScanCursor(
  value: unknown,
  seedCursor: EventCursor,
): EventCacheScanCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw cacheError('Invalid event cache scan cursor.')
  }
  const source = value as Partial<EventCacheScanCursor>
  const position = asCachePosition(value)
  if (!sameCursorIdentity(position.cursor, seedCursor)) {
    throw cacheError('The event cache scan cursor belongs to another scope.')
  }
  assertScanBlock(source.fromBlock, 'scan start block')
  const after = normalizeLogPosition(source.after)
  if (!isGeneration(source.session)) {
    throw cacheError('Invalid event cache scan session.')
  }
  const integrity = normalizeLogIntegrity(
    {
      digest: source.digest,
      last: source.after,
      logCount: source.logCount,
    },
    'scan cursor',
  )
  if (
    integrity.logCount === 0 ||
    source.fromBlock < seedCursor.startBlock ||
    source.fromBlock > position.cursor.nextBlock ||
    after.blockNumber < source.fromBlock ||
    after.blockNumber >= position.cursor.nextBlock
  ) {
    throw cacheError('Invalid event cache scan boundary.')
  }
  return {
    ...position,
    after,
    digest: integrity.digest,
    fromBlock: source.fromBlock,
    logCount: integrity.logCount,
    session: source.session,
  }
}
function sameScanCursor(
  first: EventCacheScanCursor,
  second: EventCacheScanCursor,
) {
  return (
    first.session === second.session &&
    first.generation === second.generation &&
    first.revision === second.revision &&
    first.digest === second.digest &&
    first.fromBlock === second.fromBlock &&
    first.logCount === second.logCount &&
    sameLogPosition(first.after, second.after) &&
    sameCursor(first.cursor, second.cursor)
  )
}
function normalizeScanBaseline(
  value: unknown,
  seedCursor: EventCursor,
): EventCacheScanBaseline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw cacheError('Invalid event cache scan baseline.')
  }
  const source = value as Partial<EventCacheScanBaseline>
  const position = asCachePosition(value)
  if (!sameCursorIdentity(position.cursor, seedCursor)) {
    throw cacheError('The event cache scan baseline belongs to another scope.')
  }
  const integrity = normalizeLogIntegrity(
    {
      digest: source.digest,
      last: source.last,
      logCount: source.logCount,
    },
    'scan baseline',
  )
  if (!isLogDigest(source.proof)) {
    throw cacheError('Invalid event cache scan baseline proof.')
  }
  if (
    integrity.lastLog !== undefined &&
    (integrity.lastLog.blockNumber < seedCursor.startBlock ||
      integrity.lastLog.blockNumber >= position.cursor.nextBlock)
  ) {
    throw cacheError('Invalid event cache scan baseline boundary.')
  }
  if (isSeedCursor(position.cursor) && integrity.logCount !== 0) {
    throw cacheError('Invalid event cache scan baseline boundary.')
  }
  return {
    ...position,
    digest: integrity.digest,
    last: integrity.lastLog,
    logCount: integrity.logCount,
    proof: source.proof,
  }
}
export function validateEventCacheScanBaseline(
  value: unknown,
  seedValue: unknown,
) {
  const seed = validateEventCursor(seedValue)
  if (!isSeedCursor(seed)) {
    throw cacheError('The event cache requires a fresh seed cursor.')
  }
  return normalizeScanBaseline(value, seed)
}
function assertRollbackTo(value: unknown, cursor: EventCursor) {
  if (value === undefined) return undefined
  if (
    typeof value !== 'bigint' ||
    value < cursor.startBlock ||
    value > cursor.nextBlock
  ) {
    throw cacheError('Invalid event cache rollback block.')
  }
  return value
}
function asCachePosition(value: unknown): EventCachePosition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw cacheError('Invalid event cache position.')
  }
  const position = value as Partial<EventCachePosition>
  if (!isGeneration(position.generation)) {
    throw cacheError('Invalid event cache generation.')
  }
  if (typeof position.revision !== 'bigint' || position.revision < 0n) {
    throw cacheError('Invalid event cache revision.')
  }
  return {
    cursor: validateEventCursor(position.cursor),
    generation: position.generation,
    revision: position.revision,
  }
}
function asScopeRecord(
  value: unknown,
  scope: string,
  expectedFilter: NormalizedEventLogFilter,
) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventCacheCorruptionError()
  }
  const record = value as Partial<ScopeRecord>
  if (
    record.schemaVersion !== CACHE_SCHEMA_VERSION ||
    record.scope !== scope ||
    !isGeneration(record.baselineKey) ||
    !isGeneration(record.generation) ||
    typeof record.revision !== 'bigint' ||
    record.revision < 0n ||
    typeof record.logCount !== 'number' ||
    !Number.isSafeInteger(record.logCount) ||
    record.logCount < 0 ||
    !isLogDigest(record.logDigest)
  ) {
    throw new EventCacheCorruptionError()
  }
  try {
    const filter = normalizeEventLogFilter(record.filter)
    if (filter.id !== expectedFilter.id) throw new EventCacheCorruptionError()
    const integrity = normalizeLogIntegrity(
      {
        digest: record.logDigest,
        last: record.lastLog,
        logCount: record.logCount,
      },
      'scope',
    )
    return {
      baselineKey: record.baselineKey,
      filter,
      generation: record.generation,
      lastLog: integrity.lastLog,
      logCount: integrity.logCount,
      logDigest: integrity.digest,
      revision: record.revision,
    }
  } catch {
    throw new EventCacheCorruptionError()
  }
}
function asCursorRecord(value: unknown, scope: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventCacheCorruptionError()
  }
  const record = value as Partial<CursorRecord>
  if (record.schemaVersion !== CACHE_SCHEMA_VERSION || record.scope !== scope) {
    throw new EventCacheCorruptionError()
  }
  try {
    const cursor = validateEventCursor(record.cursor)
    if (getEventCacheScope(cursor) !== scope) {
      throw new EventCacheCorruptionError()
    }
    return cursor
  } catch {
    throw new EventCacheCorruptionError()
  }
}
function asStoredLogRecord(value: unknown, scope: string): StoredLogRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventCacheCorruptionError()
  }
  const record = value as Partial<LogRecord>
  if (
    record.schemaVersion !== CACHE_SCHEMA_VERSION ||
    record.scope !== scope ||
    !isLogDigest(record.digest) ||
    typeof record.identity !== 'string' ||
    typeof record.position !== 'string' ||
    typeof record.ordinal !== 'number' ||
    !Number.isSafeInteger(record.ordinal) ||
    record.ordinal < 1
  ) {
    throw new EventCacheCorruptionError()
  }
  try {
    const log = validateIndexedEventLog(record.log)
    if (
      getLogIdentity(log) !== record.identity ||
      getLogPosition(log) !== record.position
    ) {
      throw new EventCacheCorruptionError()
    }
    return { digest: record.digest, log, ordinal: record.ordinal }
  } catch {
    throw new EventCacheCorruptionError()
  }
}
function asLogRecord(value: unknown, scope: string) {
  return asStoredLogRecord(value, scope).log
}
export function getEventCacheScope(value: unknown) {
  const cursor = validateEventCursor(value)
  return [
    `v${CACHE_SCHEMA_VERSION}`,
    fixedHex(cursor.chainId, 64),
    cursor.filterId.slice(2),
    fixedHex(cursor.startBlock, 64),
    fixedHex(cursor.finalityDepth, 64),
  ].join(':')
}

function normalizeBaselineAuthentications(
  value: unknown,
): readonly NormalizedBaselineAuthentication[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_BASELINE_AUTHENTICATIONS
  ) {
    throw cacheError('Invalid event cache baseline authentications.')
  }
  const scopes = new Set<string>()
  return value.map((entryValue) => {
    if (
      typeof entryValue !== 'object' ||
      entryValue === null ||
      Array.isArray(entryValue)
    ) {
      throw cacheError('Invalid event cache baseline authentication.')
    }
    const entry = entryValue as Partial<EventCacheBaselineAuthentication>
    const filter = normalizeEventLogFilter(entry.filter)
    const seed = validateEventCursor(entry.seed)
    if (seed.filterId !== filter.id || !isSeedCursor(seed)) {
      throw cacheError(
        'The event cache baseline authentication belongs to another scope.',
      )
    }
    const baseline = normalizeScanBaseline(entry.baseline, seed)
    const scope = getEventCacheScope(seed)
    if (scopes.has(scope)) {
      throw cacheError('Duplicate event cache baseline authentication scope.')
    }
    scopes.add(scope)
    return { baseline, filter, scope, seed }
  })
}

function normalizeBaselineForFilter(
  value: unknown,
  filter: NormalizedEventLogFilter,
): NormalizedBaselineAuthentication {
  const position = asCachePosition(value)
  const seed = getSeedCursor(position.cursor)
  if (seed.filterId !== filter.id) {
    throw cacheError(
      'The event cache baseline authentication belongs to another scope.',
    )
  }
  return {
    baseline: normalizeScanBaseline(value, seed),
    filter,
    scope: getEventCacheScope(seed),
    seed,
  }
}

function assertBaselineAuthenticated(
  entry: NormalizedBaselineAuthentication,
  read: BaselineAuthenticationRead,
) {
  try {
    if (read.scopeRecord === undefined) throw new EventCacheCorruptionError()
    const state = asScopeRecord(read.scopeRecord, entry.scope, entry.filter)
    if (
      state.revision === 0n
        ? read.cursorRecord !== undefined
        : read.cursorRecord === undefined
    ) {
      throw new EventCacheCorruptionError()
    }
    const cursor =
      read.cursorRecord === undefined
        ? entry.seed
        : asCursorRecord(read.cursorRecord, entry.scope)
    const { proof, ...baselinePayload } = entry.baseline
    if (
      state.generation !== entry.baseline.generation ||
      state.revision !== entry.baseline.revision ||
      !sameCursor(cursor, entry.baseline.cursor) ||
      getScanBaselineProof(state.baselineKey, baselinePayload) !== proof
    ) {
      throw new EventCacheCorruptionError()
    }
    const integrity: LogIntegrity = {
      digest: entry.baseline.digest,
      lastLog: entry.baseline.last,
      logCount: entry.baseline.logCount,
    }
    if (!stateMatchesIntegrity(state, integrity)) {
      throw new EventCacheCorruptionError()
    }
    const hasLogs = read.firstLogRecord !== undefined
    if (
      hasLogs !== (read.lastLogRecord !== undefined) ||
      hasLogs !== integrity.logCount > 0
    ) {
      throw new EventCacheCorruptionError()
    }
    if (!hasLogs) return state.baselineKey
    const first = asStoredLogRecord(read.firstLogRecord, entry.scope)
    const last = asStoredLogRecord(read.lastLogRecord, entry.scope)
    const firstIntegrity = advanceLogIntegrity(
      { digest: EMPTY_LOG_DIGEST, logCount: 0 },
      first.log,
    )
    if (
      !storedRecordMatchesIntegrity(first, firstIntegrity) ||
      !storedRecordMatchesIntegrity(last, integrity) ||
      (integrity.logCount === 1
        ? compareLogs(first.log, last.log) !== 0
        : compareLogs(first.log, last.log) >= 0)
    ) {
      throw new EventCacheCorruptionError()
    }
    const edgeLogs =
      integrity.logCount === 1 ? [first.log] : [first.log, last.log]
    if (
      first.log.blockNumber < cursor.startBlock ||
      last.log.blockNumber >= cursor.nextBlock ||
      getLogStreamProblem(edgeLogs, cursor, state.filter)
    ) {
      throw new EventCacheCorruptionError()
    }
    return state.baselineKey
  } catch {
    throw cacheError('The event cache baseline snapshot changed or is corrupt.')
  }
}

export class BrowserEventCache {
  readonly #database: IDBDatabase
  readonly #filter: NormalizedEventLogFilter
  readonly #keyRange: typeof IDBKeyRange
  readonly #maintenanceLogLimit: number
  readonly #scanContinuations = new Map<string, EventCacheScanCursor>()

  constructor(
    database: IDBDatabase,
    keyRange: typeof IDBKeyRange,
    filter: NormalizedEventLogFilter,
    maintenanceLogLimit = MAX_MAINTENANCE_LOGS,
  ) {
    this.#database = database
    this.#filter = filter
    this.#keyRange = keyRange
    this.#maintenanceLogLimit =
      normalizeMaintenanceLogLimit(maintenanceLogLimit)
  }

  close() {
    this.#scanContinuations.clear()
    this.#database.close()
  }

  #createScanSession() {
    for (;;) {
      const session = defaultCreateGeneration()
      if (!this.#scanContinuations.has(session)) return session
    }
  }

  #rememberScanContinuation(
    seedCursor: EventCursor,
    continuation: EventCacheScanCursor,
  ) {
    const snapshot = normalizeScanCursor(continuation, seedCursor)
    if (
      !this.#scanContinuations.has(snapshot.session) &&
      this.#scanContinuations.size >= MAX_SCAN_SESSIONS
    ) {
      const oldest = this.#scanContinuations.keys().next().value
      if (oldest !== undefined) this.#scanContinuations.delete(oldest)
    }
    this.#scanContinuations.set(snapshot.session, snapshot)
  }

  async authenticateBaselines(value: unknown): Promise<void> {
    const entries = normalizeBaselineAuthentications(value)
    await this.#authenticateBaselinesTransaction(entries)
  }

  async bindDerivedState(
    baselineValue: unknown,
    digestValue: unknown,
  ): Promise<EventCacheDerivedStateBinding> {
    const entry = normalizeBaselineForFilter(baselineValue, this.#filter)
    const digest = normalizeDerivedStateDigest(digestValue)
    const [baselineKey] = await this.#authenticateBaselinesTransaction([entry])
    if (!baselineKey) {
      throw cacheError('The event cache baseline was not authenticated.')
    }
    return {
      digest,
      proof: getDerivedStateProof(baselineKey, entry.baseline.proof, digest),
    }
  }

  async authenticateDerivedState(
    baselineValue: unknown,
    bindingValue: unknown,
  ): Promise<void> {
    const entry = normalizeBaselineForFilter(baselineValue, this.#filter)
    const binding = normalizeDerivedStateBinding(bindingValue)
    await this.#authenticateDerivedStateTransaction(entry, binding)
  }

  async clear(seedValue: unknown) {
    const seedCursor = validateEventCursor(seedValue)
    if (seedCursor.filterId !== this.#filter.id) {
      throw cacheError('The event cache cursor belongs to another filter.')
    }
    if (!isSeedCursor(seedCursor)) {
      throw cacheError('The event cache requires a fresh seed cursor.')
    }
    const scope = getEventCacheScope(seedCursor)
    await new Promise<void>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [SCOPE_STORE, CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      const scopeStore = transaction.objectStore(SCOPE_STORE)
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logStore = transaction.objectStore(LOG_STORE)
      const fail = (error: unknown) => {
        if (failure) return
        failure = asError(error, 'The browser event cache could not clear.')
        try {
          transaction.abort()
        } catch {
          reject(failure)
        }
      }
      const scopeRequest = scopeStore.get(scope)
      scopeRequest.onsuccess = () => {
        try {
          let state: ScopeState | undefined
          if (scopeRequest.result) {
            try {
              state = asScopeRecord(scopeRequest.result, scope, this.#filter)
            } catch (error) {
              if (!(error instanceof EventCacheCorruptionError)) throw error
            }
          }
          this.#resetScope(
            scopeStore,
            cursorStore,
            logStore,
            scope,
            seedCursor,
            state,
            fail,
          )
        } catch (error) {
          fail(error)
        }
      }
      scopeRequest.onerror = () => fail(scopeRequest.error)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () =>
        reject(
          failure ??
            asError(
              transaction.error,
              'The browser event cache could not clear.',
            ),
        )
      transaction.onerror = () => undefined
    })
  }

  async readLatest(
    seedValue: unknown,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<EventCachePage> {
    const seedCursor = validateEventCursor(seedValue)
    if (seedCursor.filterId !== this.#filter.id) {
      throw cacheError('The event cache cursor belongs to another filter.')
    }
    if (!isSeedCursor(seedCursor)) {
      throw cacheError('The event cache requires a fresh seed cursor.')
    }
    assertPageSize(limit)
    const scope = getEventCacheScope(seedCursor)
    return this.#readLatestTransaction(seedCursor, scope, limit)
  }

  async scan(
    seedValue: unknown,
    optionsValue: EventCacheScanOptions = {},
  ): Promise<EventCacheScanPage> {
    const seedCursor = validateEventCursor(seedValue)
    if (seedCursor.filterId !== this.#filter.id) {
      throw cacheError('The event cache cursor belongs to another filter.')
    }
    if (!isSeedCursor(seedCursor)) {
      throw cacheError('The event cache requires a fresh seed cursor.')
    }
    if (
      typeof optionsValue !== 'object' ||
      optionsValue === null ||
      Array.isArray(optionsValue)
    ) {
      throw cacheError('Invalid event cache scan options.')
    }
    if ('fromBlock' in optionsValue) {
      throw cacheError(
        'An event cache delta scan requires a completed scan baseline.',
      )
    }
    const options = optionsValue as EventCacheScanOptions
    const limit = options.limit ?? DEFAULT_PAGE_SIZE
    assertPageSize(limit)
    const resetOnCorruption = options.resetOnCorruption ?? true
    if (typeof resetOnCorruption !== 'boolean') {
      throw cacheError('Invalid event cache corruption reset option.')
    }
    let continuation: EventCacheScanCursor | undefined
    let baseline: EventCacheScanBaseline | undefined
    let scanSession: string
    if (options.continuation !== undefined) {
      if (options.baseline !== undefined) {
        throw cacheError('The event cache scan has conflicting boundaries.')
      }
      continuation = normalizeScanCursor(options.continuation, seedCursor)
      const expected = this.#scanContinuations.get(continuation.session)
      if (!expected || !sameScanCursor(expected, continuation)) {
        throw cacheError(
          'The event cache scan continuation was not issued for this session.',
        )
      }
      this.#scanContinuations.delete(continuation.session)
      scanSession = continuation.session
    } else if (options.baseline !== undefined) {
      baseline = normalizeScanBaseline(options.baseline, seedCursor)
      scanSession = this.#createScanSession()
    } else {
      scanSession = this.#createScanSession()
    }
    const fromBlock =
      continuation?.fromBlock ??
      baseline?.cursor.nextBlock ??
      seedCursor.startBlock
    const scope = getEventCacheScope(seedCursor)
    const page = await this.#scanTransaction(
      seedCursor,
      scope,
      fromBlock,
      limit,
      continuation,
      baseline,
      scanSession,
      resetOnCorruption,
    )
    if (page.next) this.#rememberScanContinuation(seedCursor, page.next)
    return page
  }

  async apply(
    expectedValue: EventCachePosition,
    result: EventSyncResult,
  ): Promise<void> {
    const expected = asCachePosition(expectedValue)
    const expectedCursor = expected.cursor
    if (expectedCursor.filterId !== this.#filter.id) {
      throw cacheError('The event cache cursor belongs to another filter.')
    }
    const nextCursor = validateEventCursor(result.cursor)
    if (!sameCursorIdentity(expectedCursor, nextCursor)) {
      throw cacheError('The event sync result belongs to another cache.')
    }
    const scope = getEventCacheScope(expectedCursor)
    const rollbackTo = assertRollbackTo(result.rollbackTo, expectedCursor)
    if (result.logs.length > MAX_BATCH_LOGS) {
      throw cacheError('The event sync batch is too large to cache.')
    }
    const logs = result.logs.map(validateIndexedEventLog)
    const minimumBlock = rollbackTo ?? expectedCursor.nextBlock
    if (nextCursor.nextBlock < minimumBlock) {
      throw cacheError(
        'The event sync cursor moved behind its update boundary.',
      )
    }
    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index]!
      if (
        log.blockNumber < minimumBlock ||
        log.blockNumber >= nextCursor.nextBlock
      ) {
        throw cacheError('The event sync batch contains an out-of-range log.')
      }
      if (index > 0) {
        const order = compareLogs(logs[index - 1]!, log)
        if (order === 0) {
          throw cacheError(
            'The event sync batch has duplicate block/log-index pairs.',
          )
        }
        if (order > 0) {
          throw cacheError('The event sync batch is not canonically ordered.')
        }
      }
    }
    const streamProblem = getLogStreamProblem(logs, nextCursor, this.#filter)
    if (streamProblem) {
      throw cacheError(`The event sync batch has ${streamProblem}.`)
    }
    await this.#applyRaw(scope, expected, nextCursor, logs, rollbackTo)
  }

  #resetScope(
    scopeStore: IDBObjectStore,
    cursorStore: IDBObjectStore,
    logStore: IDBObjectStore,
    scope: string,
    seedCursor: EventCursor,
    state: ScopeState | undefined,
    onFailure: (error: unknown) => void,
  ) {
    const nextState = state
      ? {
          ...state,
          lastLog: undefined,
          logCount: 0,
          logDigest: EMPTY_LOG_DIGEST,
          revision: state.revision + 1n,
        }
      : this.#createScopeState(1n)
    this.#deleteScopeLogs(logStore, scope, onFailure)
    cursorStore.put({
      cursor: seedCursor,
      schemaVersion: CACHE_SCHEMA_VERSION,
      scope,
    } satisfies CursorRecord)
    this.#putScopeState(scopeStore, scope, nextState)
    return nextState
  }

  #deleteScopeLogs(
    logStore: IDBObjectStore,
    scope: string,
    onFailure: (error: unknown) => void,
  ) {
    const request = logStore
      .index(LOG_SCOPE_INDEX)
      .openKeyCursor(this.#keyRange.only(scope))
    let deleted = 0
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      if (deleted >= this.#maintenanceLogLimit) {
        onFailure(maintenanceLimitError('repair', this.#maintenanceLogLimit))
        return
      }
      logStore.delete(cursor.primaryKey)
      deleted += 1
      cursor.continue()
    }
    request.onerror = () => onFailure(request.error)
  }

  #authenticateBaselinesTransaction(
    entries: readonly NormalizedBaselineAuthentication[],
  ) {
    return new Promise<readonly string[]>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [SCOPE_STORE, CURSOR_STORE, LOG_STORE],
        'readonly',
      )
      const reads = entries.map(() => ({}) as BaselineAuthenticationRead)
      let failure: Error | undefined
      let pending = entries.length * 4
      let baselineKeys: readonly string[] | undefined
      const scopeStore = transaction.objectStore(SCOPE_STORE)
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logIndex = transaction.objectStore(LOG_STORE).index(LOG_SCOPE_INDEX)
      const fail = (error: unknown) => {
        if (failure) return
        failure = asError(
          error,
          'The event cache baselines could not be authenticated.',
        )
        try {
          transaction.abort()
        } catch {
          reject(failure)
        }
      }
      const requestFinished = () => {
        pending -= 1
        if (pending !== 0 || failure) return
        try {
          baselineKeys = entries.map((entry, index) =>
            assertBaselineAuthenticated(entry, reads[index]!),
          )
        } catch (error) {
          fail(error)
        }
      }
      entries.forEach((entry, index) => {
        const read = reads[index]!
        const scopeRequest = scopeStore.get(entry.scope)
        scopeRequest.onsuccess = () => {
          read.scopeRecord = scopeRequest.result
          requestFinished()
        }
        scopeRequest.onerror = () => fail(scopeRequest.error)
        const cursorRequest = cursorStore.get(entry.scope)
        cursorRequest.onsuccess = () => {
          read.cursorRecord = cursorRequest.result
          requestFinished()
        }
        cursorRequest.onerror = () => fail(cursorRequest.error)
        const firstRequest = logIndex.openCursor(
          this.#keyRange.only(entry.scope),
          'next',
        )
        firstRequest.onsuccess = () => {
          read.firstLogRecord = firstRequest.result?.value
          requestFinished()
        }
        firstRequest.onerror = () => fail(firstRequest.error)
        const lastRequest = logIndex.openCursor(
          this.#keyRange.only(entry.scope),
          'prev',
        )
        lastRequest.onsuccess = () => {
          read.lastLogRecord = lastRequest.result?.value
          requestFinished()
        }
        lastRequest.onerror = () => fail(lastRequest.error)
      })
      transaction.oncomplete = () => {
        if (baselineKeys) resolve(baselineKeys)
        else
          reject(
            failure ??
              cacheError('The event cache baselines were not authenticated.'),
          )
      }
      transaction.onabort = () =>
        reject(
          failure ??
            asError(
              transaction.error,
              'The event cache baselines could not be authenticated.',
            ),
        )
      transaction.onerror = () => undefined
    })
  }

  #authenticateDerivedStateTransaction(
    entry: NormalizedBaselineAuthentication,
    binding: EventCacheDerivedStateBinding,
  ) {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.#database.transaction(SCOPE_STORE, 'readonly')
      let failure: Error | undefined
      let authenticated = false
      const request = transaction.objectStore(SCOPE_STORE).get(entry.scope)
      const fail = (error: unknown) => {
        if (failure) return
        failure = asError(
          error,
          'The event cache derived state could not be authenticated.',
        )
        try {
          transaction.abort()
        } catch {
          reject(failure)
        }
      }
      request.onsuccess = () => {
        try {
          if (request.result === undefined)
            throw new EventCacheCorruptionError()
          const state = asScopeRecord(request.result, entry.scope, entry.filter)
          const { proof, ...baselinePayload } = entry.baseline
          if (
            state.generation !== entry.baseline.generation ||
            entry.baseline.revision > state.revision ||
            getScanBaselineProof(state.baselineKey, baselinePayload) !==
              proof ||
            getDerivedStateProof(state.baselineKey, proof, binding.digest) !==
              binding.proof
          ) {
            throw new EventCacheCorruptionError()
          }
          authenticated = true
        } catch {
          fail(
            cacheError(
              'The event cache derived state binding changed or is corrupt.',
            ),
          )
        }
      }
      request.onerror = () => fail(request.error)
      transaction.oncomplete = () => {
        if (authenticated) resolve()
        else
          reject(
            failure ??
              cacheError(
                'The event cache derived state was not authenticated.',
              ),
          )
      }
      transaction.onabort = () =>
        reject(
          failure ??
            asError(
              transaction.error,
              'The event cache derived state could not be authenticated.',
            ),
        )
      transaction.onerror = () => undefined
    })
  }

  #createScopeState(revision: bigint): ScopeState {
    const generation = defaultCreateGeneration()
    const baselineKey = defaultCreateGeneration()
    if (!isGeneration(generation) || !isGeneration(baselineKey)) {
      throw cacheError('The event cache generated an invalid scope token.')
    }
    return {
      baselineKey,
      filter: this.#filter,
      generation,
      logCount: 0,
      logDigest: EMPTY_LOG_DIGEST,
      revision,
    }
  }

  #putScopeState(scopeStore: IDBObjectStore, scope: string, state: ScopeState) {
    scopeStore.put({
      baselineKey: state.baselineKey,
      filter: {
        address: state.filter.address,
        topics: state.filter.topics,
      },
      generation: state.generation,
      lastLog: state.lastLog,
      logCount: state.logCount,
      logDigest: state.logDigest,
      revision: state.revision,
      schemaVersion: CACHE_SCHEMA_VERSION,
      scope,
    } satisfies ScopeRecord)
  }

  #readLatestTransaction(
    seedCursor: EventCursor,
    scope: string,
    limit: number,
  ) {
    return new Promise<EventCachePage>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [SCOPE_STORE, CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      let page: EventCachePage | undefined
      let scopeRecord: unknown
      let cursorRecord: unknown
      const logRecords: unknown[] = []
      let boundaryBlock: bigint | undefined
      let boundaryLogCount = 0
      let boundaryOverflow = false
      let reachedStart = false
      let scopeDone = false
      let cursorDone = false
      let logsDone = false
      let finalized = false
      const scopeStore = transaction.objectStore(SCOPE_STORE)
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logStore = transaction.objectStore(LOG_STORE)
      const fail = (error: unknown) => {
        if (failure) return
        finalized = true
        failure = asError(error, 'The browser event cache could not read.')
        try {
          transaction.abort()
        } catch {
          reject(failure)
        }
      }
      const finalize = () => {
        if (finalized || !scopeDone || !cursorDone || !logsDone) return
        finalized = true
        let state: ScopeState | undefined
        try {
          if (scopeRecord !== undefined) {
            state = asScopeRecord(scopeRecord, scope, this.#filter)
          } else if (cursorRecord !== undefined || logRecords.length > 0) {
            throw new EventCacheCorruptionError()
          } else {
            state = this.#createScopeState(0n)
            this.#putScopeState(scopeStore, scope, state)
          }
          if (
            state.revision === 0n
              ? cursorRecord !== undefined || logRecords.length > 0
              : cursorRecord === undefined
          ) {
            throw new EventCacheCorruptionError()
          }
          const cursor =
            cursorRecord !== undefined
              ? asCursorRecord(cursorRecord, scope)
              : seedCursor
          if (boundaryOverflow) throw new EventCacheCorruptionError()
          const records = logRecords.map((record) =>
            asStoredLogRecord(record, scope),
          )
          const logs = records.map((record) => record.log)
          for (let index = 0; index < logs.length; index += 1) {
            const log = logs[index]!
            if (
              log.blockNumber < cursor.startBlock ||
              log.blockNumber >= cursor.nextBlock ||
              (index > 0 && compareLogs(logs[index - 1]!, log) <= 0)
            ) {
              throw new EventCacheCorruptionError()
            }
          }
          if (getLogStreamProblem(logs, cursor, state.filter)) {
            throw new EventCacheCorruptionError()
          }
          if (state.logCount === 0) {
            if (records.length > 0) throw new EventCacheCorruptionError()
          } else {
            const newest = records[0]
            if (
              newest === undefined ||
              !storedRecordMatchesIntegrity(newest, {
                digest: state.logDigest,
                lastLog: state.lastLog,
                logCount: state.logCount,
              })
            ) {
              throw new EventCacheCorruptionError()
            }
          }
          for (let index = records.length - 2; index >= 0; index -= 1) {
            const older = records[index + 1]!
            const newer = records[index]!
            const expectedIntegrity = advanceLogIntegrity(
              {
                digest: older.digest,
                lastLog: getPublicLogPosition(older.log),
                logCount: older.ordinal,
              },
              newer.log,
            )
            if (!storedRecordMatchesIntegrity(newer, expectedIntegrity)) {
              throw new EventCacheCorruptionError()
            }
          }
          if (reachedStart) {
            let integrity: LogIntegrity = {
              digest: EMPTY_LOG_DIGEST,
              logCount: 0,
            }
            for (const record of records.toReversed()) {
              integrity = advanceLogIntegrity(integrity, record.log)
              if (!storedRecordMatchesIntegrity(record, integrity)) {
                throw new EventCacheCorruptionError()
              }
            }
            if (!stateMatchesIntegrity(state, integrity)) {
              throw new EventCacheCorruptionError()
            }
          }
          page = {
            cursor,
            generation: state.generation,
            logs: logs.slice(0, limit),
            reset: false,
            revision: state.revision,
          }
        } catch (error) {
          if (!(error instanceof EventCacheCorruptionError)) {
            fail(error)
            return
          }
          try {
            const nextState = this.#resetScope(
              scopeStore,
              cursorStore,
              logStore,
              scope,
              seedCursor,
              state,
              fail,
            )
            page = {
              cursor: seedCursor,
              generation: nextState.generation,
              logs: [],
              reset: true,
              revision: nextState.revision,
            }
          } catch (resetError) {
            fail(resetError)
          }
        }
      }
      const scopeRequest = scopeStore.get(scope)
      scopeRequest.onsuccess = () => {
        scopeRecord = scopeRequest.result
        scopeDone = true
        finalize()
      }
      scopeRequest.onerror = () => fail(scopeRequest.error)
      const cursorRequest = cursorStore.get(scope)
      cursorRequest.onsuccess = () => {
        cursorRecord = cursorRequest.result
        cursorDone = true
        finalize()
      }
      cursorRequest.onerror = () => fail(cursorRequest.error)
      const logRequest = logStore
        .index(LOG_SCOPE_INDEX)
        .openCursor(this.#keyRange.only(scope), 'prev')
      logRequest.onsuccess = () => {
        const cursor = logRequest.result
        if (!cursor) {
          reachedStart = true
          logsDone = true
          finalize()
          return
        }
        logRecords.push(cursor.value)
        let log: IndexedEventLog
        try {
          log = asLogRecord(cursor.value, scope)
        } catch (error) {
          if (!(error instanceof EventCacheCorruptionError)) {
            fail(error)
            return
          }
          logsDone = true
          finalize()
          return
        }
        if (logRecords.length < limit) {
          cursor.continue()
          return
        }
        if (logRecords.length === limit) {
          boundaryBlock = log.blockNumber
          boundaryLogCount = logRecords.reduce<number>((count, record) => {
            return (
              count +
              Number(asLogRecord(record, scope).blockNumber === boundaryBlock)
            )
          }, 0)
          cursor.continue()
          return
        }
        if (log.blockNumber === boundaryBlock) {
          boundaryLogCount += 1
          if (boundaryLogCount <= MAX_BATCH_LOGS) {
            cursor.continue()
            return
          }
          boundaryOverflow = true
        }
        logsDone = true
        finalize()
      }
      logRequest.onerror = () => fail(logRequest.error)
      transaction.oncomplete = () => {
        if (page) resolve(page)
        else reject(cacheError('The browser event cache returned no page.'))
      }
      transaction.onabort = () =>
        reject(
          failure ??
            asError(
              transaction.error,
              'The browser event cache could not read.',
            ),
        )
      transaction.onerror = () => undefined
    })
  }

  #scanTransaction(
    seedCursor: EventCursor,
    scope: string,
    fromBlock: bigint,
    limit: number,
    continuation: EventCacheScanCursor | undefined,
    baseline: EventCacheScanBaseline | undefined,
    scanSession: string,
    resetOnCorruption: boolean,
  ) {
    return new Promise<EventCacheScanPage>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [SCOPE_STORE, CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      let page: EventCacheScanPage | undefined
      let scopeRecord: unknown
      let cursorRecord: unknown
      let anchorRecord: unknown
      let baselineTailRecord: unknown
      let firstEdgeRecord: unknown
      let lastEdgeRecord: unknown
      const logRecords: unknown[] = []
      let boundaryBlock: bigint | undefined
      let currentBlock: bigint | undefined
      let currentBlockLogCount = 0
      let hasMore = false
      let pageCorrupt = false
      let scopeDone = false
      let cursorDone = false
      let anchorDone = continuation === undefined
      let baselineTailDone = baseline === undefined
      let firstEdgeDone = false
      let lastEdgeDone = false
      let logsDone = false
      let finalized = false
      const scopeStore = transaction.objectStore(SCOPE_STORE)
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logStore = transaction.objectStore(LOG_STORE)
      const fail = (error: unknown) => {
        if (failure) return
        finalized = true
        failure = asError(error, 'The browser event cache could not scan.')
        try {
          transaction.abort()
        } catch {
          reject(failure)
        }
      }
      const finalize = () => {
        if (
          finalized ||
          !scopeDone ||
          !cursorDone ||
          !anchorDone ||
          !baselineTailDone ||
          !firstEdgeDone ||
          !lastEdgeDone ||
          !logsDone
        ) {
          return
        }
        finalized = true
        let state: ScopeState | undefined
        try {
          const hasLogs = firstEdgeRecord !== undefined
          if (hasLogs !== (lastEdgeRecord !== undefined)) {
            throw new EventCacheCorruptionError()
          }
          if (scopeRecord !== undefined) {
            state = asScopeRecord(scopeRecord, scope, this.#filter)
          } else if (
            cursorRecord !== undefined ||
            hasLogs ||
            continuation !== undefined ||
            baseline !== undefined
          ) {
            throw new EventCacheCorruptionError()
          } else {
            state = this.#createScopeState(0n)
            this.#putScopeState(scopeStore, scope, state)
          }
          if (
            state.revision === 0n
              ? cursorRecord !== undefined || hasLogs
              : cursorRecord === undefined
          ) {
            throw new EventCacheCorruptionError()
          }
          const cursor =
            cursorRecord !== undefined
              ? asCursorRecord(cursorRecord, scope)
              : seedCursor
          if (hasLogs !== state.logCount > 0) {
            throw new EventCacheCorruptionError()
          }
          if (hasLogs) {
            const firstEdge = asStoredLogRecord(firstEdgeRecord, scope)
            const lastEdge = asStoredLogRecord(lastEdgeRecord, scope)
            const firstIntegrity = advanceLogIntegrity(
              { digest: EMPTY_LOG_DIGEST, logCount: 0 },
              firstEdge.log,
            )
            if (
              !storedRecordMatchesIntegrity(firstEdge, firstIntegrity) ||
              !storedRecordMatchesIntegrity(lastEdge, {
                digest: state.logDigest,
                lastLog: state.lastLog,
                logCount: state.logCount,
              }) ||
              (state.logCount === 1
                ? compareLogs(firstEdge.log, lastEdge.log) !== 0
                : compareLogs(firstEdge.log, lastEdge.log) >= 0)
            ) {
              throw new EventCacheCorruptionError()
            }
            const edgeLogs =
              state.logCount === 1
                ? [firstEdge.log]
                : [firstEdge.log, lastEdge.log]
            if (
              firstEdge.log.blockNumber < cursor.startBlock ||
              lastEdge.log.blockNumber >= cursor.nextBlock ||
              getLogStreamProblem(edgeLogs, cursor, state.filter)
            ) {
              throw new EventCacheCorruptionError()
            }
          }
          if (continuation) {
            if (
              state.generation !== continuation.generation ||
              state.revision !== continuation.revision ||
              !sameCursor(cursor, continuation.cursor)
            ) {
              throw cacheError(
                'The event cache changed during chronological scanning.',
              )
            }
          }
          if (fromBlock > cursor.nextBlock) {
            throw cacheError('Invalid event cache scan boundary.')
          }
          if (pageCorrupt) throw new EventCacheCorruptionError()
          let integrity: LogIntegrity = {
            digest: EMPTY_LOG_DIGEST,
            logCount: 0,
          }
          let anchor: StoredLogRecord | undefined
          if (continuation) {
            if (anchorRecord === undefined) {
              throw new EventCacheCorruptionError()
            }
            anchor = asStoredLogRecord(anchorRecord, scope)
            if (
              !sameLogPosition(
                getPublicLogPosition(anchor.log),
                continuation.after,
              ) ||
              anchor.log.blockNumber < fromBlock ||
              anchor.log.blockNumber >= cursor.nextBlock ||
              getLogStreamProblem([anchor.log], cursor, state.filter)
            ) {
              throw new EventCacheCorruptionError()
            }
            integrity = {
              digest: continuation.digest,
              lastLog: continuation.after,
              logCount: continuation.logCount,
            }
            if (!storedRecordMatchesIntegrity(anchor, integrity)) {
              throw cacheError('Invalid event cache scan continuation.')
            }
          } else if (baseline) {
            const { proof, ...baselinePayload } = baseline
            if (
              getScanBaselineProof(state.baselineKey, baselinePayload) !== proof
            ) {
              throw cacheError(
                'The event cache scan baseline was not issued by this cache.',
              )
            }
            if (
              state.generation !== baseline.generation ||
              baseline.revision > state.revision ||
              !sameCursorIdentity(cursor, baseline.cursor) ||
              baseline.cursor.nextBlock > cursor.nextBlock ||
              (baseline.revision === state.revision &&
                !sameCursor(cursor, baseline.cursor))
            ) {
              throw cacheError(
                'The event cache scan baseline is no longer canonical.',
              )
            }
            const checkpoint = baseline.cursor.checkpoints.at(-1)
            if (
              checkpoint !== undefined &&
              !cursor.checkpoints.some(
                (current) =>
                  current.blockNumber === checkpoint.blockNumber &&
                  current.blockHash === checkpoint.blockHash,
              )
            ) {
              throw cacheError(
                'The event cache scan baseline is no longer canonical.',
              )
            }
            integrity = {
              digest: baseline.digest,
              lastLog: baseline.last,
              logCount: baseline.logCount,
            }
            if (baseline.logCount === 0) {
              if (baselineTailRecord !== undefined) {
                throw cacheError(
                  'The event cache scan baseline is no longer canonical.',
                )
              }
            } else {
              if (baselineTailRecord === undefined) {
                throw cacheError(
                  'The event cache scan baseline is no longer canonical.',
                )
              }
              const baselineTail = asStoredLogRecord(baselineTailRecord, scope)
              if (!storedRecordMatchesIntegrity(baselineTail, integrity)) {
                throw cacheError(
                  'The event cache scan baseline is no longer canonical.',
                )
              }
            }
          }
          const observedRecords = logRecords.map((record) =>
            asStoredLogRecord(record, scope),
          )
          const observedLogs = observedRecords.map((record) => record.log)
          for (let index = 0; index < observedLogs.length; index += 1) {
            const log = observedLogs[index]!
            if (
              log.blockNumber < fromBlock ||
              log.blockNumber >= cursor.nextBlock ||
              (index > 0 && compareLogs(observedLogs[index - 1]!, log) >= 0)
            ) {
              throw new EventCacheCorruptionError()
            }
          }
          if (
            anchor !== undefined &&
            observedLogs[0] !== undefined &&
            anchor.log.blockNumber >= observedLogs[0].blockNumber
          ) {
            throw cacheError('Invalid event cache scan continuation.')
          }
          if (getLogStreamProblem(observedLogs, cursor, state.filter)) {
            throw new EventCacheCorruptionError()
          }
          const observedIntegrity: LogIntegrity[] = []
          for (const record of observedRecords) {
            integrity = advanceLogIntegrity(integrity, record.log)
            if (!storedRecordMatchesIntegrity(record, integrity)) {
              throw new EventCacheCorruptionError()
            }
            observedIntegrity.push(integrity)
          }
          const returnedCount = observedLogs.length - Number(hasMore)
          const logs = observedLogs.slice(0, returnedCount)
          const last = logs.at(-1)
          if (hasMore && !last) throw new EventCacheCorruptionError()
          const returnedIntegrity =
            observedIntegrity[returnedCount - 1] ??
            (continuation
              ? {
                  digest: continuation.digest,
                  lastLog: continuation.after,
                  logCount: continuation.logCount,
                }
              : baseline
                ? {
                    digest: baseline.digest,
                    lastLog: baseline.last,
                    logCount: baseline.logCount,
                  }
                : { digest: EMPTY_LOG_DIGEST, logCount: 0 })
          if (!hasMore && !stateMatchesIntegrity(state, integrity)) {
            throw new EventCacheCorruptionError()
          }
          const completedBaseline = !hasMore
            ? ({
                cursor,
                digest: state.logDigest,
                generation: state.generation,
                last: state.lastLog,
                logCount: state.logCount,
                revision: state.revision,
              } satisfies Omit<EventCacheScanBaseline, 'proof'>)
            : undefined
          page = {
            baseline: completedBaseline
              ? {
                  ...completedBaseline,
                  proof: getScanBaselineProof(
                    state.baselineKey,
                    completedBaseline,
                  ),
                }
              : undefined,
            complete: !hasMore,
            cursor,
            generation: state.generation,
            logs,
            next:
              hasMore && last
                ? {
                    after: getPublicLogPosition(last),
                    cursor,
                    digest: returnedIntegrity.digest,
                    fromBlock,
                    generation: state.generation,
                    logCount: returnedIntegrity.logCount,
                    revision: state.revision,
                    session: scanSession,
                  }
                : undefined,
            reset: false,
            revision: state.revision,
          }
        } catch (error) {
          if (!(error instanceof EventCacheCorruptionError)) {
            fail(error)
            return
          }
          if (!resetOnCorruption) {
            fail(new DeferredEventCacheCorruptionError())
            return
          }
          try {
            const nextState = this.#resetScope(
              scopeStore,
              cursorStore,
              logStore,
              scope,
              seedCursor,
              state,
              fail,
            )
            page = {
              complete: false,
              cursor: seedCursor,
              generation: nextState.generation,
              logs: [],
              reset: true,
              revision: nextState.revision,
            }
          } catch (resetError) {
            fail(resetError)
          }
        }
      }
      const scopeRequest = scopeStore.get(scope)
      scopeRequest.onsuccess = () => {
        scopeRecord = scopeRequest.result
        scopeDone = true
        finalize()
      }
      scopeRequest.onerror = () => fail(scopeRequest.error)
      const cursorRequest = cursorStore.get(scope)
      cursorRequest.onsuccess = () => {
        cursorRecord = cursorRequest.result
        cursorDone = true
        finalize()
      }
      cursorRequest.onerror = () => fail(cursorRequest.error)
      if (continuation) {
        const anchorRequest = logStore.get([
          scope,
          getLogPosition(continuation.after),
        ])
        anchorRequest.onsuccess = () => {
          anchorRecord = anchorRequest.result
          anchorDone = true
          finalize()
        }
        anchorRequest.onerror = () => fail(anchorRequest.error)
      }
      const minimumPosition = `${fixedHex(seedCursor.startBlock, 64)}:${'0'.repeat(16)}`
      const upperPosition = `${'f'.repeat(64)}:${'f'.repeat(16)}`
      const firstEdgeRequest = logStore
        .index(LOG_SCOPE_INDEX)
        .openCursor(this.#keyRange.only(scope))
      firstEdgeRequest.onsuccess = () => {
        firstEdgeRecord = firstEdgeRequest.result?.value
        firstEdgeDone = true
        finalize()
      }
      firstEdgeRequest.onerror = () => fail(firstEdgeRequest.error)
      const lastEdgeRequest = logStore
        .index(LOG_SCOPE_INDEX)
        .openCursor(this.#keyRange.only(scope), 'prev')
      lastEdgeRequest.onsuccess = () => {
        lastEdgeRecord = lastEdgeRequest.result?.value
        lastEdgeDone = true
        finalize()
      }
      lastEdgeRequest.onerror = () => fail(lastEdgeRequest.error)
      if (baseline) {
        if (fromBlock === seedCursor.startBlock) {
          baselineTailDone = true
        } else {
          const baselineUpperPosition = `${fixedHex(fromBlock - 1n, 64)}:${'f'.repeat(16)}`
          const baselineTailRequest = logStore.openCursor(
            this.#keyRange.bound(
              [scope, minimumPosition],
              [scope, baselineUpperPosition],
            ),
            'prev',
          )
          baselineTailRequest.onsuccess = () => {
            baselineTailRecord = baselineTailRequest.result?.value
            baselineTailDone = true
            finalize()
          }
          baselineTailRequest.onerror = () => fail(baselineTailRequest.error)
        }
      }
      const lowerPosition = continuation
        ? `${fixedHex(continuation.after.blockNumber, 64)}:${fixedHex(
            continuation.after.logIndex,
            16,
          )}`
        : `${fixedHex(fromBlock, 64)}:${fixedHex(0, 16)}`
      const logRequest = logStore.openCursor(
        this.#keyRange.bound(
          [scope, lowerPosition],
          [scope, upperPosition],
          continuation !== undefined,
        ),
      )
      logRequest.onsuccess = () => {
        const logCursor = logRequest.result
        if (!logCursor) {
          logsDone = true
          finalize()
          return
        }
        let log: IndexedEventLog
        try {
          log = asLogRecord(logCursor.value, scope)
        } catch (error) {
          if (!(error instanceof EventCacheCorruptionError)) {
            fail(error)
            return
          }
          pageCorrupt = true
          logsDone = true
          finalize()
          return
        }
        logRecords.push(logCursor.value)
        if (log.blockNumber === currentBlock) {
          currentBlockLogCount += 1
        } else {
          currentBlock = log.blockNumber
          currentBlockLogCount = 1
        }
        if (currentBlockLogCount > MAX_BATCH_LOGS) {
          pageCorrupt = true
          logsDone = true
          finalize()
          return
        }
        if (boundaryBlock === undefined && logRecords.length >= limit) {
          boundaryBlock = log.blockNumber
        } else if (
          boundaryBlock !== undefined &&
          log.blockNumber !== boundaryBlock
        ) {
          hasMore = true
          logsDone = true
          finalize()
          return
        }
        if (logRecords.length > MAX_SCAN_LOGS) {
          pageCorrupt = true
          logsDone = true
          finalize()
          return
        }
        logCursor.continue()
      }
      logRequest.onerror = () => fail(logRequest.error)
      transaction.oncomplete = () => {
        if (page) resolve(page)
        else reject(cacheError('The browser event cache returned no scan.'))
      }
      transaction.onabort = () =>
        reject(
          failure ??
            asError(
              transaction.error,
              'The browser event cache could not scan.',
            ),
        )
      transaction.onerror = () => undefined
    })
  }

  #applyRaw(
    scope: string,
    expected: EventCachePosition,
    nextCursor: EventCursor,
    logs: readonly IndexedEventLog[],
    rollbackTo: bigint | undefined,
  ) {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [SCOPE_STORE, CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      let reset = false
      let scopeRecord: unknown
      let cursorRecord: unknown
      let latestLogRecord: unknown
      let scopeDone = false
      let cursorDone = false
      let hasLogs = false
      let logsDone = false
      let finalized = false
      const fail = (error: unknown) => {
        if (failure) return
        finalized = true
        failure = asError(error, 'The browser event cache could not update.')
        try {
          transaction.abort()
        } catch {
          reject(failure)
        }
      }
      const scopeStore = transaction.objectStore(SCOPE_STORE)
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logStore = transaction.objectStore(LOG_STORE)
      const finalize = () => {
        if (finalized || !scopeDone || !cursorDone || !logsDone) return
        finalized = true
        let state: ScopeState | undefined
        const resetFromCorruption = () => {
          try {
            this.#resetScope(
              scopeStore,
              cursorStore,
              logStore,
              scope,
              getSeedCursor(expected.cursor),
              state,
              fail,
            )
            reset = true
          } catch (resetError) {
            fail(resetError)
          }
        }
        const commitUpdate = (
          currentState: ScopeState,
          startingIntegrity: LogIntegrity,
        ) => {
          try {
            let integrity = startingIntegrity
            for (const log of logs) {
              integrity = advanceLogIntegrity(integrity, log)
              logStore.put({
                digest: integrity.digest,
                identity: getLogIdentity(log),
                log,
                ordinal: integrity.logCount,
                position: getLogPosition(log),
                schemaVersion: CACHE_SCHEMA_VERSION,
                scope,
              } satisfies LogRecord)
            }
            cursorStore.put({
              cursor: nextCursor,
              schemaVersion: CACHE_SCHEMA_VERSION,
              scope,
            } satisfies CursorRecord)
            this.#putScopeState(scopeStore, scope, {
              ...currentState,
              lastLog: integrity.lastLog,
              logCount: integrity.logCount,
              logDigest: integrity.digest,
              revision: currentState.revision + 1n,
            })
          } catch (error) {
            fail(error)
          }
        }
        try {
          if (scopeRecord === undefined) throw new EventCacheCorruptionError()
          const currentState = asScopeRecord(scopeRecord, scope, this.#filter)
          state = currentState
          if (
            currentState.revision === 0n
              ? cursorRecord !== undefined || hasLogs
              : cursorRecord === undefined
          ) {
            throw new EventCacheCorruptionError()
          }
          if (hasLogs !== currentState.logCount > 0) {
            throw new EventCacheCorruptionError()
          }
          if (hasLogs) {
            const latest = asStoredLogRecord(latestLogRecord, scope)
            if (
              !storedRecordMatchesIntegrity(latest, {
                digest: currentState.logDigest,
                lastLog: currentState.lastLog,
                logCount: currentState.logCount,
              })
            ) {
              throw new EventCacheCorruptionError()
            }
          }
          const storedCursor =
            cursorRecord !== undefined
              ? asCursorRecord(cursorRecord, scope)
              : getSeedCursor(expected.cursor)
          if (
            currentState.generation !== expected.generation ||
            currentState.revision !== expected.revision ||
            !sameCursor(storedCursor, expected.cursor)
          ) {
            throw cacheError('The event cache changed during synchronization.')
          }
          if (rollbackTo !== undefined) {
            if (currentState.logCount > this.#maintenanceLogLimit) {
              throw maintenanceLimitError('rollback', this.#maintenanceLogLimit)
            }
            let blockLogs: IndexedEventLog[] = []
            let integrity: LogIntegrity = {
              digest: EMPTY_LOG_DIGEST,
              logCount: 0,
            }
            let retainedIntegrity = integrity
            let previousLog: IndexedEventLog | undefined
            let visited = 0
            const validateBlock = () => {
              if (
                blockLogs.length > MAX_BATCH_LOGS ||
                getLogStreamProblem(
                  blockLogs,
                  storedCursor,
                  currentState.filter,
                )
              ) {
                throw new EventCacheCorruptionError()
              }
            }
            const rollbackRequest = logStore
              .index(LOG_SCOPE_INDEX)
              .openCursor(this.#keyRange.only(scope))
            rollbackRequest.onsuccess = () => {
              const rollbackCursor = rollbackRequest.result
              try {
                if (!rollbackCursor) {
                  validateBlock()
                  if (!stateMatchesIntegrity(currentState, integrity)) {
                    throw new EventCacheCorruptionError()
                  }
                  commitUpdate(currentState, retainedIntegrity)
                  return
                }
                if (visited >= this.#maintenanceLogLimit) {
                  throw maintenanceLimitError(
                    'rollback',
                    this.#maintenanceLogLimit,
                  )
                }
                visited += 1
                const record = asStoredLogRecord(rollbackCursor.value, scope)
                const log = record.log
                if (
                  log.blockNumber < storedCursor.startBlock ||
                  log.blockNumber >= storedCursor.nextBlock ||
                  (previousLog !== undefined &&
                    compareLogs(previousLog, log) >= 0)
                ) {
                  throw new EventCacheCorruptionError()
                }
                if (
                  previousLog !== undefined &&
                  previousLog.blockNumber !== log.blockNumber
                ) {
                  validateBlock()
                  blockLogs = []
                }
                integrity = advanceLogIntegrity(integrity, log)
                if (!storedRecordMatchesIntegrity(record, integrity)) {
                  throw new EventCacheCorruptionError()
                }
                blockLogs.push(log)
                if (blockLogs.length > MAX_BATCH_LOGS) {
                  throw new EventCacheCorruptionError()
                }
                previousLog = log
                if (log.blockNumber >= rollbackTo) {
                  logStore.delete(rollbackCursor.primaryKey)
                } else {
                  retainedIntegrity = integrity
                }
                rollbackCursor.continue()
              } catch (error) {
                if (error instanceof EventCacheCorruptionError) {
                  resetFromCorruption()
                } else {
                  fail(error)
                }
              }
            }
            rollbackRequest.onerror = () => fail(rollbackRequest.error)
          } else {
            commitUpdate(currentState, {
              digest: currentState.logDigest,
              lastLog: currentState.lastLog,
              logCount: currentState.logCount,
            })
          }
        } catch (error) {
          if (error instanceof EventCacheCorruptionError) {
            resetFromCorruption()
          } else {
            fail(error)
          }
        }
      }
      const scopeRequest = scopeStore.get(scope)
      scopeRequest.onsuccess = () => {
        scopeRecord = scopeRequest.result
        scopeDone = true
        finalize()
      }
      scopeRequest.onerror = () => fail(scopeRequest.error)
      const cursorRequest = cursorStore.get(scope)
      cursorRequest.onsuccess = () => {
        cursorRecord = cursorRequest.result
        cursorDone = true
        finalize()
      }
      cursorRequest.onerror = () => fail(cursorRequest.error)
      const logRequest = logStore
        .index(LOG_SCOPE_INDEX)
        .openCursor(this.#keyRange.only(scope), 'prev')
      logRequest.onsuccess = () => {
        latestLogRecord = logRequest.result?.value
        hasLogs = latestLogRecord !== undefined
        logsDone = true
        finalize()
      }
      logRequest.onerror = () => fail(logRequest.error)
      transaction.oncomplete = () => {
        if (reset) {
          reject(
            cacheError(
              'The browser event cache was corrupt and has been reset. Synchronize again.',
            ),
          )
        } else {
          resolve()
        }
      }
      transaction.onabort = () =>
        reject(
          failure ??
            asError(
              transaction.error,
              'The browser event cache could not update.',
            ),
        )
      transaction.onerror = () => undefined
    })
  }
}

export async function openEventCache(options: OpenEventCacheOptions) {
  const filter = normalizeEventLogFilter(options?.filter)
  const factory = options.factory ?? globalThis.indexedDB
  const keyRange = options.keyRange ?? globalThis.IDBKeyRange
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME
  const maintenanceLogLimit = normalizeMaintenanceLogLimit(
    options.maintenanceLogLimit,
  )
  if (!factory || !keyRange) {
    throw cacheError('IndexedDB is unavailable in this browser.')
  }
  if (
    typeof databaseName !== 'string' ||
    databaseName.length < 1 ||
    databaseName.length > 128
  ) {
    throw cacheError('Invalid event cache database name.')
  }
  return new Promise<BrowserEventCache>((resolve, reject) => {
    const request = factory.open(databaseName, CACHE_SCHEMA_VERSION)
    let settled = false
    const fail = (error: unknown, fallback: string) => {
      if (settled) return
      settled = true
      reject(asError(error, fallback))
    }
    request.onupgradeneeded = () => {
      const database = request.result
      for (const storeName of Array.from(database.objectStoreNames)) {
        database.deleteObjectStore(storeName)
      }
      database.createObjectStore(SCOPE_STORE, { keyPath: 'scope' })
      database.createObjectStore(CURSOR_STORE, { keyPath: 'scope' })
      const logStore = database.createObjectStore(LOG_STORE, {
        keyPath: ['scope', 'position'],
      })
      logStore.createIndex(LOG_IDENTITY_INDEX, ['scope', 'identity'], {
        unique: true,
      })
      logStore.createIndex(LOG_SCOPE_INDEX, 'scope')
    }
    request.onerror = () =>
      fail(request.error, 'The browser event cache could not open.')
    request.onblocked = () =>
      fail(undefined, 'A previous browser event cache is still open.')
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.onversionchange = () => database.close()
      resolve(
        new BrowserEventCache(database, keyRange, filter, maintenanceLogLimit),
      )
    }
  })
}
