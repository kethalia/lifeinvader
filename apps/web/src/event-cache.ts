import {
  validateEventCursor,
  validateIndexedEventLog,
  type EventCursor,
  type EventSyncResult,
  type IndexedEventLog,
} from './event-indexer'

const CACHE_SCHEMA_VERSION = 1
const DEFAULT_DATABASE_NAME = 'lifeinvader-event-cache'
const CURSOR_STORE = 'cursors'
const LOG_STORE = 'logs'
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_BATCH_LOGS = 5_000

type CursorRecord = {
  cursor: unknown
  revision: bigint
  schemaVersion: number
  scope: string
}
type LogRecord = {
  log: unknown
  position: string
  schemaVersion: number
  scope: string
}
export type EventCachePosition = {
  cursor: EventCursor
  revision: bigint
}
export type EventCachePage = EventCachePosition & {
  logs: readonly IndexedEventLog[]
  reset: boolean
}
export type OpenEventCacheOptions = {
  databaseName?: string
  factory?: IDBFactory
  keyRange?: typeof IDBKeyRange
}

class EventCacheCorruptionError extends Error {}

function cacheError(message: string) {
  return new Error(message)
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
  return `${fixedHex(log.blockNumber, 64)}:${fixedHex(
    log.transactionIndex,
    16,
  )}:${fixedHex(log.logIndex, 16)}`
}
function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  const firstPosition = getLogPosition(first)
  const secondPosition = getLogPosition(second)
  if (firstPosition === secondPosition) return 0
  return firstPosition < secondPosition ? -1 : 1
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
  if (typeof position.revision !== 'bigint' || position.revision < 0n) {
    throw cacheError('Invalid event cache revision.')
  }
  return {
    cursor: validateEventCursor(position.cursor),
    revision: position.revision,
  }
}
function asCursorRecord(value: unknown, scope: string): EventCachePosition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventCacheCorruptionError()
  }
  const record = value as Partial<CursorRecord>
  if (
    record.schemaVersion !== CACHE_SCHEMA_VERSION ||
    record.scope !== scope ||
    typeof record.revision !== 'bigint' ||
    record.revision < 1n
  ) {
    throw new EventCacheCorruptionError()
  }
  try {
    const cursor = validateEventCursor(record.cursor)
    if (getEventCacheScope(cursor) !== scope) {
      throw new EventCacheCorruptionError()
    }
    return { cursor, revision: record.revision }
  } catch {
    throw new EventCacheCorruptionError()
  }
}
function getResetRevision(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 1n
  }
  const revision = (value as Partial<CursorRecord>).revision
  return typeof revision === 'bigint' && revision >= 0n ? revision + 1n : 1n
}
function asLogRecord(value: unknown, scope: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EventCacheCorruptionError()
  }
  const record = value as Partial<LogRecord>
  if (
    record.schemaVersion !== CACHE_SCHEMA_VERSION ||
    record.scope !== scope ||
    typeof record.position !== 'string'
  ) {
    throw new EventCacheCorruptionError()
  }
  try {
    const log = validateIndexedEventLog(record.log)
    if (getLogPosition(log) !== record.position) {
      throw new EventCacheCorruptionError()
    }
    return log
  } catch {
    throw new EventCacheCorruptionError()
  }
}
function getScopeRange(keyRange: typeof IDBKeyRange, scope: string) {
  return keyRange.bound([scope, ''], [scope, '\uffff'])
}
function getRollbackRange(
  keyRange: typeof IDBKeyRange,
  scope: string,
  rollbackTo: bigint,
) {
  return keyRange.bound(
    [scope, `${fixedHex(rollbackTo, 64)}:`],
    [scope, '\uffff'],
  )
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
  readonly #keyRange: typeof IDBKeyRange

  constructor(database: IDBDatabase, keyRange: typeof IDBKeyRange) {
    this.#database = database
    this.#keyRange = keyRange
  }

  close() {
    this.#database.close()
  }

  async clear(seedValue: unknown) {
    const seedCursor = validateEventCursor(seedValue)
    if (!isSeedCursor(seedCursor)) {
      throw cacheError('The event cache requires a fresh seed cursor.')
    }
    const scope = getEventCacheScope(seedCursor)
    await new Promise<void>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logStore = transaction.objectStore(LOG_STORE)
      const cursorRequest = cursorStore.get(scope)
      cursorRequest.onsuccess = () => {
        try {
          this.#resetScope(
            cursorStore,
            logStore,
            scope,
            seedCursor,
            cursorRequest.result,
          )
        } catch (error) {
          failure = asError(error, 'The browser event cache could not clear.')
          transaction.abort()
        }
      }
      cursorRequest.onerror = () => {
        failure = asError(
          cursorRequest.error,
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
      if (index > 0 && compareLogs(logs[index - 1]!, log) >= 0) {
        throw cacheError('The event sync batch is not canonically ordered.')
      }
    }
    await this.#applyRaw(scope, expected, nextCursor, logs, rollbackTo)
  }

  #resetScope(
    cursorStore: IDBObjectStore,
    logStore: IDBObjectStore,
    scope: string,
    seedCursor: EventCursor,
    observedCursorRecord: unknown,
  ) {
    const revision = getResetRevision(observedCursorRecord)
    logStore.delete(getScopeRange(this.#keyRange, scope))
    cursorStore.put({
      cursor: seedCursor,
      revision,
      schemaVersion: CACHE_SCHEMA_VERSION,
      scope,
    } satisfies CursorRecord)
    return revision
  }

  #readLatestTransaction(
    seedCursor: EventCursor,
    scope: string,
    limit: number,
  ) {
    return new Promise<EventCachePage>((resolve, reject) => {
      const transaction = this.#database.transaction(
        [CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      let page: EventCachePage | undefined
      let cursorRecord: unknown
      const logRecords: unknown[] = []
      let cursorDone = false
      let logsDone = false
      let finalized = false
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
        if (finalized || !cursorDone || !logsDone) return
        finalized = true
        try {
          if (!cursorRecord && logRecords.length > 0) {
            throw new EventCacheCorruptionError()
          }
          const position = cursorRecord
            ? asCursorRecord(cursorRecord, scope)
            : { cursor: seedCursor, revision: 0n }
          const logs = logRecords.map((record) => asLogRecord(record, scope))
          for (let index = 0; index < logs.length; index += 1) {
            const log = logs[index]!
            if (
              log.blockNumber < position.cursor.startBlock ||
              log.blockNumber >= position.cursor.nextBlock ||
              (index > 0 && compareLogs(logs[index - 1]!, log) <= 0)
            ) {
              throw new EventCacheCorruptionError()
            }
          }
          page = { ...position, logs, reset: false }
        } catch (error) {
          if (!(error instanceof EventCacheCorruptionError)) {
            fail(error)
            return
          }
          try {
            const revision = this.#resetScope(
              cursorStore,
              logStore,
              scope,
              seedCursor,
              cursorRecord,
            )
            page = { cursor: seedCursor, logs: [], reset: true, revision }
          } catch (resetError) {
            fail(resetError)
          }
        }
      }
      const cursorRequest = cursorStore.get(scope)
      cursorRequest.onsuccess = () => {
        cursorRecord = cursorRequest.result
        cursorDone = true
        finalize()
      }
      cursorRequest.onerror = () => fail(cursorRequest.error)
      const logRequest = logStore.openCursor(
        getScopeRange(this.#keyRange, scope),
        'prev',
      )
      logRequest.onsuccess = () => {
        const cursor = logRequest.result
        if (!cursor) {
          logsDone = true
          finalize()
          return
        }
        logRecords.push(cursor.value)
        if (logRecords.length < limit) {
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
        [CURSOR_STORE, LOG_STORE],
        'readwrite',
      )
      let failure: Error | undefined
      let reset = false
      let cursorRecord: unknown
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
      const cursorStore = transaction.objectStore(CURSOR_STORE)
      const logStore = transaction.objectStore(LOG_STORE)
      const finalize = () => {
        if (finalized || !cursorDone || !logsDone) return
        finalized = true
        try {
          if (!cursorRecord && hasLogs) {
            throw new EventCacheCorruptionError()
          }
          const stored = cursorRecord
            ? asCursorRecord(cursorRecord, scope)
            : { cursor: getSeedCursor(expected.cursor), revision: 0n }
          if (
            stored.revision !== expected.revision ||
            !sameCursor(stored.cursor, expected.cursor)
          ) {
            throw cacheError('The event cache changed during synchronization.')
          }
          if (rollbackTo !== undefined) {
            logStore.delete(getRollbackRange(this.#keyRange, scope, rollbackTo))
          }
          for (const log of logs) {
            logStore.put({
              log,
              position: getLogPosition(log),
              schemaVersion: CACHE_SCHEMA_VERSION,
              scope,
            } satisfies LogRecord)
          }
          cursorStore.put({
            cursor: nextCursor,
            revision: stored.revision + 1n,
            schemaVersion: CACHE_SCHEMA_VERSION,
            scope,
          } satisfies CursorRecord)
        } catch (error) {
          if (error instanceof EventCacheCorruptionError) {
            try {
              this.#resetScope(
                cursorStore,
                logStore,
                scope,
                getSeedCursor(expected.cursor),
                cursorRecord,
              )
              reset = true
            } catch (resetError) {
              fail(resetError)
            }
          } else {
            fail(error)
          }
        }
      }
      const cursorRequest = cursorStore.get(scope)
      cursorRequest.onsuccess = () => {
        cursorRecord = cursorRequest.result
        cursorDone = true
        finalize()
      }
      cursorRequest.onerror = () => fail(cursorRequest.error)
      const logRequest = logStore.openKeyCursor(
        getScopeRange(this.#keyRange, scope),
      )
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

export async function openEventCache(options: OpenEventCacheOptions = {}) {
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
      database.createObjectStore(CURSOR_STORE, { keyPath: 'scope' })
      database.createObjectStore(LOG_STORE, {
        keyPath: ['scope', 'position'],
      })
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
      resolve(new BrowserEventCache(database, keyRange))
    }
  })
}
