import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, stringToHex } from 'viem'
import {
  BrowserEventCache,
  getEventCacheScope,
  openEventCache,
} from './event-cache'
import {
  createEventCursor,
  type EventCursor,
  type EventLogFilter,
  type EventSyncResult,
  type IndexedEventLog,
} from './event-indexer'
import { POST_PUBLISHED_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [POST_PUBLISHED_TOPIC],
} as const
const OTHER_ADDRESS = '0x000000000000000000000000000000000000b0b0'
const OTHER_TOPIC = keccak256(stringToHex('OtherEvent()'))
let cache: BrowserEventCache | undefined

afterEach(() => {
  cache?.close()
  vi.restoreAllMocks()
})

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`${branch}:block:${blockNumber}`))
}
function transactionHash(blockNumber: bigint, transactionIndex = 0) {
  return keccak256(
    stringToHex(`transaction:${blockNumber}:${transactionIndex}`),
  )
}
function seedCursor(filter: EventLogFilter = FILTER) {
  return createEventCursor({
    chainId: 1n,
    filter,
    finalityDepth: 12n,
    rangeSize: 4,
    startBlock: 0n,
  })
}
function cursorAt(seed: EventCursor, nextBlock: bigint, branch = 'a') {
  if (nextBlock === seed.startBlock) return seed
  const endpoint = nextBlock - 1n
  return {
    ...seed,
    checkpoints: [
      { blockHash: blockHash(endpoint, branch), blockNumber: endpoint },
    ],
    nextBlock,
  } satisfies EventCursor
}
function eventLog(
  blockNumber: bigint,
  options: {
    branch?: string
    logIndex?: number
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? 0
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber, options.branch),
    blockNumber,
    data: '0x',
    logIndex,
    topics: [POST_PUBLISHED_TOPIC],
    transactionHash: transactionHash(blockNumber, transactionIndex),
    transactionIndex,
  }
}
function logIdentity(log: IndexedEventLog) {
  return `${log.blockNumber.toString(16).padStart(64, '0')}:${log.logIndex
    .toString(16)
    .padStart(16, '0')}`
}
function syncResult(
  cursor: EventCursor,
  logs: readonly IndexedEventLog[],
  rollbackTo?: bigint,
): EventSyncResult {
  return {
    caughtUp: false,
    cursor,
    head: cursor.nextBlock,
    logs,
    rollbackTo,
    safeHead: cursor.nextBlock,
    scannedRanges: 1,
  }
}
async function createCache(
  factory = new IDBFactory(),
  filter: EventLogFilter = FILTER,
) {
  cache = await openEventCache({
    databaseName: 'lifeinvader-event-cache-test',
    factory,
    filter,
    keyRange: IDBKeyRange,
  })
  return { cache, factory }
}
async function putRawRecord(
  factory: IDBFactory,
  storeName: 'cursors' | 'logs' | 'scopes',
  value: Record<string, unknown>,
) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('lifeinvader-event-cache-test', 7)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction.objectStore(storeName).put(value)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}
async function deleteRawRecord(
  factory: IDBFactory,
  storeName: 'cursors' | 'logs' | 'scopes',
  key: IDBValidKey,
) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('lifeinvader-event-cache-test', 7)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}
async function countRawScopeLogs(factory: IDBFactory, scope: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('lifeinvader-event-cache-test', 7)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const count = await new Promise<number>((resolve, reject) => {
    const transaction = database.transaction('logs', 'readonly')
    const request = transaction
      .objectStore('logs')
      .index('scope')
      .count(IDBKeyRange.only(scope))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return count
}

describe('browser event cache', () => {
  it('persists a bounded newest-first page and cursor', async () => {
    const factory = new IDBFactory()
    const opened = await createCache(factory)
    const seed = seedCursor()
    const next = cursorAt(seed, 4n)
    const initial = await opened.cache.readLatest(seed)
    await opened.cache.apply(
      initial,
      syncResult(next, [eventLog(1n), eventLog(3n)]),
    )
    expect(await opened.cache.readLatest(seed)).toEqual({
      cursor: next,
      generation: initial.generation,
      logs: [eventLog(3n), eventLog(1n)],
      reset: false,
      revision: 1n,
    })

    opened.cache.close()
    cache = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      filter: FILTER,
      keyRange: IDBKeyRange,
    })
    expect((await cache.readLatest(seed)).cursor).toEqual(next)
  })

  it('applies rollback deletion and replacement logs atomically', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const original = cursorAt(seed, 4n)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(original, [eventLog(1n), eventLog(3n)]),
    )
    const replacement = cursorAt(seed, 4n, 'b')
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(replacement, [eventLog(2n, { branch: 'b' })], 2n),
    )
    const page = await opened.readLatest(seed)
    expect(page.cursor).toEqual(replacement)
    expect(page.logs).toEqual([eventLog(2n, { branch: 'b' }), eventLog(1n)])
    expect(page.revision).toBe(2n)
    await expect(opened.scan(seed)).resolves.toMatchObject({
      complete: true,
      logs: [eventLog(1n), eventLog(2n, { branch: 'b' })],
      reset: false,
    })
  })

  it('rejects a stale concurrent batch without changing the cache', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const first = cursorAt(seed, 2n)
    const stale = await opened.readLatest(seed)
    await opened.apply(stale, syncResult(first, [eventLog(1n)]))
    await expect(
      opened.apply(stale, syncResult(cursorAt(seed, 1n), [eventLog(0n)])),
    ).rejects.toThrow(/changed during synchronization/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: first,
      logs: [eventLog(1n)],
      revision: 1n,
    })
  })

  it('rejects an ABA batch after the cursor returns to the same value', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const original = cursorAt(seed, 4n)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(original, [eventLog(1n)]),
    )
    const stale = await opened.readLatest(seed)
    const advanced = cursorAt(seed, 6n)
    await opened.apply(
      stale,
      syncResult(advanced, [eventLog(4n), eventLog(5n)]),
    )
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(original, [], 4n),
    )

    await expect(
      opened.apply(
        stale,
        syncResult(cursorAt(seed, 5n, 'stale'), [
          eventLog(4n, { branch: 'stale' }),
        ]),
      ),
    ).rejects.toThrow(/changed during synchronization/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: original,
      logs: [eventLog(1n)],
      revision: 3n,
    })
  })

  it('resets malformed persisted data instead of trusting it', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 2n)
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(next, [eventLog(1n)]))
    await putRawRecord(factory, 'cursors', {
      cursor: next,
      schemaVersion: 99,
      scope: getEventCacheScope(seed),
    })
    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: false,
      revision: 2n,
    })
  })

  it('resets a malformed cached log and its cursor together', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 2n)
    const log = eventLog(1n)
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(next, [log]))
    const position = `${'0'.repeat(63)}1:${'0'.repeat(16)}`
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(log),
      log: { ...log, data: '0x1' },
      position,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })
    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('makes corruption recovery atomic with a concurrent repair', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const original = cursorAt(seed, 4n)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(original, [eventLog(1n), eventLog(3n)]),
    )
    const repairBase = await opened.readLatest(seed)
    const corruptLog = eventLog(2n)
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(corruptLog),
      log: { ...corruptLog, data: '0x1' },
      position: `${'0'.repeat(63)}2:${'0'.repeat(16)}`,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    const otherTab = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      filter: FILTER,
      keyRange: IDBKeyRange,
    })
    try {
      const resetting = opened.readLatest(seed)
      const repairing = otherTab.apply(
        repairBase,
        syncResult(
          cursorAt(seed, 4n, 'b'),
          [eventLog(2n, { branch: 'b' })],
          2n,
        ),
      )
      const [resetResult, repairResult] = await Promise.allSettled([
        resetting,
        repairing,
      ])
      expect(resetResult).toEqual({
        status: 'fulfilled',
        value: {
          cursor: seed,
          generation: repairBase.generation,
          logs: [],
          reset: true,
          revision: 2n,
        },
      })
      expect(repairResult.status).toBe('rejected')
      if (repairResult.status !== 'rejected') {
        throw new Error('Expected rejection')
      }
      expect(repairResult.reason).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/changed during synchronization/i),
        }),
      )
      expect(await opened.readLatest(seed)).toMatchObject({
        cursor: seed,
        logs: [],
        revision: 2n,
      })
    } finally {
      otherTab.close()
    }
  })

  it('advances the revision when a scope is cleared', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const stale = await opened.readLatest(seed)
    await opened.clear(seed)
    await expect(
      opened.apply(stale, syncResult(cursorAt(seed, 1n), [eventLog(0n)])),
    ).rejects.toThrow(/changed during synchronization/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      logs: [],
      revision: 1n,
    })
  })

  it('preserves the generation when the cursor record is lost', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.clear(seed)
    const stale = await opened.readLatest(seed)
    expect(stale).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      revision: 1n,
    })
    await opened.apply(stale, syncResult(cursorAt(seed, 2n), [eventLog(1n)]))
    await deleteRawRecord(factory, 'cursors', getEventCacheScope(seed))

    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 3n,
    })
    await expect(
      opened.apply(stale, syncResult(cursorAt(seed, 1n), [eventLog(0n)])),
    ).rejects.toThrow(/changed during synchronization/i)
  })

  it('rotates the generation when its filter metadata is corrupt', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const stale = await opened.readLatest(seed)
    await putRawRecord(factory, 'scopes', {
      filter: { address: OTHER_ADDRESS, topics: [POST_PUBLISHED_TOPIC] },
      generation: stale.generation,
      revision: stale.revision,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    const reset = await opened.readLatest(seed)
    expect(reset).toMatchObject({
      cursor: seed,
      logs: [],
      reset: true,
      revision: 1n,
    })
    expect(reset.generation).not.toBe(stale.generation)
    await expect(
      opened.apply(stale, syncResult(cursorAt(seed, 1n), [eventLog(0n)])),
    ).rejects.toThrow(/changed during synchronization/i)
  })

  it('resets an impossible cursor stored at revision zero', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await putRawRecord(factory, 'cursors', {
      cursor: cursorAt(seed, 2n),
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 1n,
    })
  })

  it('resets an impossible revision-zero cursor before applying', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await putRawRecord(factory, 'cursors', {
      cursor: cursorAt(seed, 2n),
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    await expect(
      opened.apply(initial, syncResult(cursorAt(seed, 1n), [eventLog(0n)])),
    ).rejects.toThrow(/corrupt/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      revision: 1n,
    })
  })

  it('resets cached logs from conflicting block branches', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [eventLog(1n)]))
    const conflict = eventLog(1n, { branch: 'b', logIndex: 1 })
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(conflict),
      log: conflict,
      position: `${'0'.repeat(63)}1:${'0'.repeat(15)}1`,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('validates the complete block crossing the page boundary', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    const blockLogs = [
      eventLog(1n),
      eventLog(1n, { logIndex: 1, transactionIndex: 1 }),
      eventLog(1n, { logIndex: 2, transactionIndex: 2 }),
    ]
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), blockLogs))
    const corrupt = {
      ...blockLogs[0]!,
      transactionHash: blockLogs[2]!.transactionHash,
    }
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(corrupt),
      log: corrupt,
      position: logIdentity(corrupt),
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    expect(await opened.readLatest(seed, 1)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('resets a cached log that conflicts with its cursor checkpoint', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 2n), []))
    const conflict = eventLog(1n, { branch: 'b' })
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(conflict),
      log: conflict,
      position: `${'0'.repeat(63)}1:${'0'.repeat(16)}`,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('prevents duplicate block/log-index identities in persisted pages', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    const next = cursorAt(seed, 4n)
    await opened.apply(initial, syncResult(next, [eventLog(1n)]))
    const duplicate = { ...eventLog(1n), transactionIndex: 1 }
    await expect(
      putRawRecord(factory, 'logs', {
        identity: logIdentity(duplicate),
        log: duplicate,
        position: `${'0'.repeat(63)}1:${'0'.repeat(15)}1:${'0'.repeat(16)}`,
        schemaVersion: 7,
        scope: getEventCacheScope(seed),
      }),
    ).rejects.toMatchObject({ name: 'ConstraintError' })

    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: next,
      generation: initial.generation,
      logs: [eventLog(1n)],
      reset: false,
      revision: 1n,
    })
  })

  it('resets a syntactically valid cached log from another filter', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [eventLog(1n)]))
    const unrelated = { ...eventLog(2n), address: OTHER_ADDRESS }
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(eventLog(2n)),
      log: unrelated,
      position: `${'0'.repeat(63)}2:${'0'.repeat(16)}`,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('requires cached logs to contain wildcard topic positions', async () => {
    const filter = {
      address: PROTOCOL_ADDRESS,
      topics: [POST_PUBLISHED_TOPIC, null],
    } as const
    const factory = new IDBFactory()
    const { cache: opened } = await createCache(factory, filter)
    const seed = seedCursor(filter)
    const initial = await opened.readLatest(seed)
    const valid = {
      ...eventLog(1n),
      topics: [POST_PUBLISHED_TOPIC, OTHER_TOPIC],
    } as const
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [valid]))
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(valid),
      log: { ...valid, topics: [POST_PUBLISHED_TOPIC] },
      position: logIdentity(valid),
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('finds and resets a log with a non-string position key', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    const scope = getEventCacheScope(seed)
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(eventLog(0n)),
      log: eventLog(0n),
      position: 7,
      schemaVersion: 7,
      scope,
    })

    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      reset: true,
      revision: 1n,
    })
    expect(await countRawScopeLogs(factory, scope)).toBe(0)
  })

  it('clears every position key type through the scope index', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const scope = getEventCacheScope(seed)
    await opened.clear(seed)
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(eventLog(0n)),
      log: eventLog(0n),
      position: 7,
      schemaVersion: 7,
      scope,
    })
    expect(await countRawScopeLogs(factory, scope)).toBe(1)

    await opened.clear(seed)
    expect(await countRawScopeLogs(factory, scope)).toBe(0)
  })

  it('resets a malformed position encountered during rollback', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [eventLog(1n)]))
    const active = await opened.readLatest(seed)
    const scope = getEventCacheScope(seed)
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(eventLog(2n)),
      log: eventLog(2n),
      position: 7,
      schemaVersion: 7,
      scope,
    })

    await expect(
      opened.apply(
        active,
        syncResult(
          cursorAt(seed, 4n, 'b'),
          [eventLog(2n, { branch: 'b' })],
          2n,
        ),
      ),
    ).rejects.toThrow(/corrupt/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      revision: 2n,
    })
    expect(await countRawScopeLogs(factory, scope)).toBe(0)
  })

  it('resets a rollback suffix record with a corrupted identity key', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [eventLog(1n)]))
    const active = await opened.readLatest(seed)
    const scope = getEventCacheScope(seed)
    const corrupt = eventLog(3n)
    await putRawRecord(factory, 'logs', {
      identity: '0',
      log: corrupt,
      position: logIdentity(corrupt),
      schemaVersion: 7,
      scope,
    })

    await expect(
      opened.apply(
        active,
        syncResult(
          cursorAt(seed, 4n, 'b'),
          [eventLog(2n, { branch: 'b' })],
          2n,
        ),
      ),
    ).rejects.toThrow(/corrupt/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      generation: initial.generation,
      logs: [],
      revision: 2n,
    })
    expect(await countRawScopeLogs(factory, scope)).toBe(0)
  })

  it('resets an affected rollback record whose stored keys both evade the suffix', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [eventLog(1n)]))
    const active = await opened.readLatest(seed)
    const scope = getEventCacheScope(seed)
    const hiddenKey = logIdentity(eventLog(0n))
    await putRawRecord(factory, 'logs', {
      identity: hiddenKey,
      log: eventLog(3n),
      position: hiddenKey,
      schemaVersion: 7,
      scope,
    })

    await expect(
      opened.apply(
        active,
        syncResult(
          cursorAt(seed, 4n, 'b'),
          [eventLog(2n, { branch: 'b' })],
          2n,
        ),
      ),
    ).rejects.toThrow(/corrupt/i)
    expect(await countRawScopeLogs(factory, scope)).toBe(0)
  })

  it('limits reads without scanning the whole local history', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 4n)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(next, [eventLog(1n), eventLog(2n), eventLog(3n)]),
    )
    expect((await opened.readLatest(seed, 2)).logs).toEqual([
      eventLog(3n),
      eventLog(2n),
    ])
    await expect(opened.readLatest(seed, 201)).rejects.toThrow(/page size/i)
  })

  it('scans oldest-first in bounded pages without splitting a block', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 6n)
    const logs = [
      eventLog(1n),
      eventLog(2n),
      eventLog(2n, { logIndex: 1, transactionIndex: 1 }),
      eventLog(2n, { logIndex: 2, transactionIndex: 2 }),
      eventLog(3n),
    ]
    await opened.apply(await opened.readLatest(seed), syncResult(next, logs))

    const first = await opened.scan(seed, { limit: 2 })
    expect(first).toMatchObject({
      complete: false,
      cursor: next,
      logs: logs.slice(0, 4),
      reset: false,
      revision: 1n,
    })
    expect(first.next).toMatchObject({
      after: { blockNumber: 2n, logIndex: 2 },
      cursor: next,
      fromBlock: 0n,
      generation: first.generation,
      logCount: 4,
      revision: 1n,
    })

    const second = await opened.scan(seed, {
      continuation: first.next,
      limit: 2,
    })
    expect(second).toMatchObject({
      complete: true,
      cursor: next,
      generation: first.generation,
      logs: [logs[4]],
      reset: false,
      revision: 1n,
    })
    expect(second.next).toBeUndefined()
    expect(second.baseline).toMatchObject({
      cursor: next,
      generation: first.generation,
      last: { blockNumber: 3n, logIndex: 0 },
      logCount: 5,
      revision: 1n,
    })
    await expect(
      opened.scan(seed, { continuation: first.next }),
    ).rejects.toThrow(/not issued for this session/i)
  })

  it('does not count the full scope while scanning pages', async () => {
    const count = vi.spyOn(IDBObjectStore.prototype, 'count')
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 5n), [
        eventLog(1n),
        eventLog(2n),
        eventLog(3n),
      ]),
    )

    const first = await opened.scan(seed, { limit: 1 })
    await opened.scan(seed, { continuation: first.next })

    expect(count).not.toHaveBeenCalled()
  })

  it('uses a completed canonical scan as an append-only delta baseline', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 6n)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(next, [eventLog(1n), eventLog(2n), eventLog(3n)]),
    )
    const complete = await opened.scan(seed)
    expect(complete.baseline).toBeDefined()
    opened.close()
    cache = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      filter: FILTER,
      keyRange: IDBKeyRange,
    })

    const advanced = {
      ...next,
      checkpoints: [
        ...next.checkpoints,
        { blockHash: blockHash(7n), blockNumber: 7n },
      ],
      nextBlock: 8n,
    } satisfies EventCursor
    await cache.apply(
      await cache.readLatest(seed),
      syncResult(advanced, [eventLog(6n)]),
    )

    await expect(
      cache.scan(seed, { baseline: complete.baseline }),
    ).resolves.toMatchObject({
      complete: true,
      cursor: advanced,
      logs: [eventLog(6n)],
      reset: false,
      revision: 2n,
    })
  })

  it('authenticates multiple completed scopes in one database snapshot', async () => {
    const factory = new IDBFactory()
    const firstSeed = seedCursor()
    const firstCache = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      filter: FILTER,
      keyRange: IDBKeyRange,
    })
    await firstCache.apply(
      await firstCache.readLatest(firstSeed),
      syncResult(cursorAt(firstSeed, 4n), [eventLog(1n)]),
    )
    const firstBaseline = (await firstCache.scan(firstSeed)).baseline
    firstCache.close()
    expect(firstBaseline).toBeDefined()

    const secondFilter = {
      address: PROTOCOL_ADDRESS,
      topics: [OTHER_TOPIC],
    } as const
    const secondSeed = seedCursor(secondFilter)
    cache = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      filter: secondFilter,
      keyRange: IDBKeyRange,
    })
    const secondLog = { ...eventLog(2n), topics: [OTHER_TOPIC] }
    await cache.apply(
      await cache.readLatest(secondSeed),
      syncResult(cursorAt(secondSeed, 4n), [secondLog]),
    )
    const secondBaseline = (await cache.scan(secondSeed)).baseline
    expect(secondBaseline).toBeDefined()
    const authentications = [
      { baseline: firstBaseline!, filter: FILTER, seed: firstSeed },
      {
        baseline: secondBaseline!,
        filter: secondFilter,
        seed: secondSeed,
      },
    ]

    await expect(cache.authenticateBaselines(authentications)).resolves.toBe(
      undefined,
    )
    await expect(
      cache.authenticateBaselines([authentications[0], authentications[0]]),
    ).rejects.toThrow(/duplicate.*scope/i)

    const mutator = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      filter: FILTER,
      keyRange: IDBKeyRange,
    })
    try {
      await mutator.clear(firstSeed)
    } finally {
      mutator.close()
    }
    await expect(cache.authenticateBaselines(authentications)).rejects.toThrow(
      /baseline snapshot changed or is corrupt/i,
    )
  })

  it('rejects a continuation prefix masquerading as a completed baseline', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const current = {
      ...seed,
      checkpoints: [
        { blockHash: blockHash(1n), blockNumber: 1n },
        { blockHash: blockHash(3n), blockNumber: 3n },
      ],
      nextBlock: 4n,
    } satisfies EventCursor
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(current, [eventLog(1n), eventLog(2n), eventLog(3n)]),
    )
    const partial = await opened.scan(seed, { limit: 1 })
    const complete = await opened.scan(seed)
    expect(partial.next).toBeDefined()
    expect(complete.baseline).toBeDefined()

    await expect(
      opened.scan(seed, {
        baseline: {
          cursor: {
            ...current,
            checkpoints: [current.checkpoints[0]!],
            nextBlock: 2n,
          },
          digest: partial.next!.digest,
          generation: complete.generation,
          last: partial.next!.after,
          logCount: partial.next!.logCount,
          proof: complete.baseline!.proof,
          revision: 0n,
        },
      }),
    ).rejects.toThrow(/baseline was not issued by this cache/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: current,
      reset: false,
      revision: 1n,
    })
  })

  it('rejects a delta baseline whose final checkpoint was reorganized', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 6n), [eventLog(1n), eventLog(3n)]),
    )
    const complete = await opened.scan(seed)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 6n, 'b'), [eventLog(4n, { branch: 'b' })], 4n),
    )

    await expect(
      opened.scan(seed, { baseline: complete.baseline }),
    ).rejects.toThrow(/baseline is no longer canonical/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: cursorAt(seed, 6n, 'b'),
      reset: false,
      revision: 2n,
    })
  })

  it('returns a whole large boundary block under a fixed hard cap', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const blockLogs = Array.from({ length: 201 }, (_value, index) =>
      eventLog(1n, { logIndex: index, transactionIndex: index }),
    )
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 3n), blockLogs),
    )

    const page = await opened.scan(seed, { limit: 1 })
    expect(page.complete).toBe(true)
    expect(page.logs).toEqual(blockLogs)
  })

  it('rejects a continuation after any cache revision change', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 4n), [
        eventLog(1n),
        eventLog(2n),
        eventLog(3n),
      ]),
    )
    const first = await opened.scan(seed, { limit: 1 })
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 6n), [eventLog(4n)]),
    )

    await expect(
      opened.scan(seed, { continuation: first.next }),
    ).rejects.toThrow(/changed during chronological scanning/i)
    expect((await opened.readLatest(seed)).revision).toBe(2n)
  })

  it('resets when a scan continuation anchor disappears', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(
      initial,
      syncResult(cursorAt(seed, 4n), [
        eventLog(1n),
        eventLog(2n),
        eventLog(3n),
      ]),
    )
    const first = await opened.scan(seed, { limit: 1 })
    await deleteRawRecord(factory, 'logs', [
      getEventCacheScope(seed),
      logIdentity(eventLog(1n)),
    ])

    await expect(
      opened.scan(seed, { continuation: first.next }),
    ).resolves.toMatchObject({
      complete: false,
      cursor: seed,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('resets instead of treating local EOF as proof after a log disappears', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(
      initial,
      syncResult(cursorAt(seed, 5n), [
        eventLog(1n),
        eventLog(2n),
        eventLog(3n),
      ]),
    )
    await deleteRawRecord(factory, 'logs', [
      getEventCacheScope(seed),
      logIdentity(eventLog(2n)),
    ])

    await expect(opened.scan(seed)).resolves.toMatchObject({
      complete: false,
      cursor: seed,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('can defer corrupt scan cleanup outside a bounded reader', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(cursorAt(seed, 5n), [
        eventLog(1n),
        eventLog(2n),
        eventLog(3n),
      ]),
    )
    const scope = getEventCacheScope(seed)
    await deleteRawRecord(factory, 'logs', [scope, logIdentity(eventLog(2n))])

    await expect(
      opened.scan(seed, { resetOnCorruption: false }),
    ).rejects.toThrow(/corrupt and was not reset/i)
    expect(await countRawScopeLogs(factory, scope)).toBe(2)
    await expect(opened.readLatest(seed)).resolves.toMatchObject({
      cursor: seed,
      logs: [],
      reset: true,
      revision: 2n,
    })
    expect(await countRawScopeLogs(factory, scope)).toBe(0)
  })

  it('resets a noncanonical position key outside the scan range', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(initial, syncResult(cursorAt(seed, 4n), [eventLog(1n)]))
    const hidden = eventLog(2n)
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(hidden),
      log: hidden,
      position: 7,
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    await expect(opened.scan(seed)).resolves.toMatchObject({
      complete: false,
      cursor: seed,
      logs: [],
      reset: true,
      revision: 2n,
    })
    expect(await countRawScopeLogs(factory, getEventCacheScope(seed))).toBe(0)
  })

  it('validates unread sentinels before issuing a continuation', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const initial = await opened.readLatest(seed)
    await opened.apply(
      initial,
      syncResult(cursorAt(seed, 5n), [
        eventLog(1n),
        eventLog(2n),
        eventLog(3n),
      ]),
    )
    const corrupt = eventLog(2n)
    await putRawRecord(factory, 'logs', {
      identity: logIdentity(corrupt),
      log: { ...corrupt, data: '0x1' },
      position: logIdentity(corrupt),
      schemaVersion: 7,
      scope: getEventCacheScope(seed),
    })

    await expect(opened.scan(seed, { limit: 1 })).resolves.toMatchObject({
      cursor: seed,
      logs: [],
      reset: true,
      revision: 2n,
    })
  })

  it('rejects later continuation fields substituted from another scan', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 4n)
    await opened.apply(
      await opened.readLatest(seed),
      syncResult(next, [eventLog(1n), eventLog(2n), eventLog(3n)]),
    )
    const first = await opened.scan(seed, { limit: 1 })
    expect(first.next).toBeDefined()
    const otherFirst = await opened.scan(seed, { limit: 1 })
    const later = await opened.scan(seed, {
      continuation: otherFirst.next,
      limit: 1,
    })
    expect(later.next).toBeDefined()

    await expect(
      opened.scan(seed, {
        continuation: {
          ...first.next!,
          after: later.next!.after,
          digest: later.next!.digest,
          logCount: later.next!.logCount,
        },
      }),
    ).rejects.toThrow(/not issued for this session/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: next,
      logs: [eventLog(3n), eventLog(2n), eventLog(1n)],
      revision: 1n,
    })
  })

  it('rejects invalid chronological scan inputs before returning data', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    await expect(opened.scan(seed, { limit: 201 })).rejects.toThrow(
      /page size/i,
    )
    await expect(
      opened.scan(seed, { fromBlock: -1n } as never),
    ).rejects.toThrow(/requires a completed scan baseline/i)
    await expect(opened.scan(seed, null as unknown as never)).rejects.toThrow(
      /scan options/i,
    )
    await expect(
      opened.scan(seed, { resetOnCorruption: 'yes' } as never),
    ).rejects.toThrow(/corruption reset option/i)
  })

  it('rejects out-of-range and noncanonical batches before opening a write', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 3n)
    const initial = await opened.readLatest(seed)
    await expect(
      opened.apply(initial, syncResult(next, [eventLog(3n)])),
    ).rejects.toThrow(/out-of-range/i)
    await expect(
      opened.apply(initial, syncResult(next, [eventLog(2n), eventLog(1n)])),
    ).rejects.toThrow(/canonically ordered/i)
    await expect(
      opened.apply(
        initial,
        syncResult(next, [
          eventLog(1n),
          { ...eventLog(1n), transactionIndex: 1 },
        ]),
      ),
    ).rejects.toThrow(/duplicate block\/log-index/i)
    await expect(
      opened.apply(
        initial,
        syncResult(next, [
          eventLog(1n, { transactionIndex: 1 }),
          eventLog(1n, { logIndex: 1, transactionIndex: 0 }),
        ]),
      ),
    ).rejects.toThrow(/transaction metadata/i)
    await expect(
      opened.apply(
        initial,
        syncResult(next, [{ ...eventLog(1n), address: OTHER_ADDRESS }]),
      ),
    ).rejects.toThrow(/out-of-filter/i)
    await expect(
      opened.apply(
        initial,
        syncResult(next, [{ ...eventLog(1n), topics: [OTHER_TOPIC] }]),
      ),
    ).rejects.toThrow(/out-of-filter/i)
    await expect(
      opened.apply(
        initial,
        syncResult(next, [
          eventLog(1n),
          eventLog(1n, { branch: 'b', logIndex: 1 }),
        ]),
      ),
    ).rejects.toThrow(/block hashes/i)
    await expect(
      opened.apply(
        initial,
        syncResult(cursorAt(seed, 2n), [eventLog(1n, { branch: 'b' })]),
      ),
    ).rejects.toThrow(/block hashes/i)
    await expect(
      opened.apply(
        { ...initial, cursor: cursorAt(seed, 4n) },
        syncResult(seed, [], 1n),
      ),
    ).rejects.toThrow(/update boundary/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      logs: [],
      revision: 0n,
    })
  })
})
