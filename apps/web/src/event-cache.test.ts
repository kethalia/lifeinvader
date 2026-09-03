import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(() => cache?.close())

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
    const request = factory.open('lifeinvader-event-cache-test', 6)
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
    const request = factory.open('lifeinvader-event-cache-test', 6)
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
    const request = factory.open('lifeinvader-event-cache-test', 6)
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
        schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
      schemaVersion: 6,
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
