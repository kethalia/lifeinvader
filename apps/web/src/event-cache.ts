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

const CACHE_SCHEMA_VERSION = 6
const DEFAULT_DATABASE_NAME = 'lifeinvader-event-cache'
const SCOPE_STORE = 'scopes'
const CURSOR_STORE = 'cursors'
const LOG_STORE = 'logs'
const LOG_IDENTITY_INDEX = 'identity'
const LOG_SCOPE_INDEX = 'scope'
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_BATCH_LOGS = 5_000

type CursorRecord = {
  cursor: unknown
  schemaVersion: number
  scope: string
}
type ScopeRecord = {
  filter: unknown
  generation: string
  revision: bigint
  schemaVersion: number
  scope: string
}
type ScopeState = {
  filter: NormalizedEventLogFilter
  generation: string
  revision: bigint
}
type LogRecord = {
  identity: string
  log: unknown
  position: string
  schemaVersion: number
  scope: string
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
export type OpenEventCacheOptions = {
  databaseName?: string
  factory?: IDBFactory
  filter: EventLogFilter
  keyRange?: typeof IDBKeyRange
}

class EventCacheCorruptionError extends Error {}

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
function getLogPosition(log: IndexedEventLog) {
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
    !isGeneration(record.generation) ||
    typeof record.revision !== 'bigint' ||
    record.revision < 0n
  ) {
    throw new EventCacheCorruptionError()
  }
  try {
    const filter = normalizeEventLogFilter(record.filter)
    if (filter.id !== expectedFilter.id) throw new EventCacheCorruptionError()
    return { filter, generation: record.generation, revision: record.revision }
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
function asLogRecord(value: unknown, scope: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventCacheCorruptionError()
  }
  const record = value as Partial<LogRecord>
  if (
    record.schemaVersion !== CACHE_SCHEMA_VERSION ||
    record.scope !== scope ||
    typeof record.identity !== 'string' ||
    typeof record.position !== 'string'
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
    return log
  } catch {
    throw new EventCacheCorruptionError()
  }
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

export class BrowserEventCache {
  readonly #database: IDBDatabase
  readonly #filter: NormalizedEventLogFilter
  readonly #keyRange: typeof IDBKeyRange

  constructor(
    database: IDBDatabase,
    keyRange: typeof IDBKeyRange,
    filter: NormalizedEventLogFilter,
  ) {
    this.#database = database
    this.#filter = filter
    this.#keyRange = keyRange
  }

  close() {
    this.#database.close()
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
          )
        } catch (error) {
          failure = asError(error, 'The browser event cache could not clear.')
          transaction.abort()
        }
      }
      scopeRequest.onerror = () => {
        failure = asError(
          scopeRequest.error,
          'The browser event cache could not clear.',
        )
        transaction.abort()
      }
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
  ) {
    const nextState = state
      ? { ...state, revision: state.revision + 1n }
      : this.#createScopeState(1n)
    this.#deleteScopeLogs(logStore, scope)
    cursorStore.put({
      cursor: seedCursor,
      schemaVersion: CACHE_SCHEMA_VERSION,
      scope,
    } satisfies CursorRecord)
    this.#putScopeState(scopeStore, scope, nextState)
    return nextState
  }

  #deleteScopeLogs(logStore: IDBObjectStore, scope: string) {
    const request = logStore
      .index(LOG_SCOPE_INDEX)
      .openKeyCursor(this.#keyRange.only(scope))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      logStore.delete(cursor.primaryKey)
      cursor.continue()
    }
    request.onerror = () => undefined
  }

  #createScopeState(revision: bigint): ScopeState {
    const generation = defaultCreateGeneration()
    if (!isGeneration(generation)) {
      throw cacheError('The event cache generated an invalid scope token.')
    }
    return { filter: this.#filter, generation, revision }
  }

  #putScopeState(scopeStore: IDBObjectStore, scope: string, state: ScopeState) {
    scopeStore.put({
      filter: {
        address: state.filter.address,
        topics: state.filter.topics,
      },
      generation: state.generation,
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
          const logs = logRecords.map((record) => asLogRecord(record, scope))
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
          logsDone = true
          finalize()
          return
        }
        logRecords.push(cursor.value)
        if (logRecords.length <= limit) {
          cursor.continue()
          return
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
            )
            reset = true
          } catch (resetError) {
            fail(resetError)
          }
        }
        const commitUpdate = (currentState: ScopeState) => {
          try {
            for (const log of logs) {
              logStore.put({
                identity: getLogIdentity(log),
                log,
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
            const rollbackRange = this.#keyRange.bound(
              [scope, `${fixedHex(rollbackTo, 64)}:${'0'.repeat(16)}`],
              [scope, '\uffff'],
            )
            const traverseRollback = (
              source: IDBIndex | IDBObjectStore,
              onComplete: () => void,
            ) => {
              const rollbackRequest = source.openCursor(rollbackRange, 'prev')
              rollbackRequest.onsuccess = () => {
                const rollbackCursor = rollbackRequest.result
                if (!rollbackCursor) {
                  onComplete()
                  return
                }
                try {
                  asLogRecord(rollbackCursor.value, scope)
                  logStore.delete(rollbackCursor.primaryKey)
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
            }
            traverseRollback(logStore, () =>
              traverseRollback(logStore.index(LOG_IDENTITY_INDEX), () =>
                commitUpdate(currentState),
              ),
            )
          } else {
            commitUpdate(currentState)
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
        .openKeyCursor(this.#keyRange.only(scope))
      logRequest.onsuccess = () => {
        hasLogs = Boolean(logRequest.result)
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
      resolve(new BrowserEventCache(database, keyRange, filter))
    }
  })
}
