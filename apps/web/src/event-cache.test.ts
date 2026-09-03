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
  type EventSyncResult,
  type IndexedEventLog,
} from './event-indexer'
import { POST_PUBLISHED_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [POST_PUBLISHED_TOPIC],
} as const
let cache: BrowserEventCache | undefined

afterEach(() => cache?.close())

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`${branch}:block:${blockNumber}`))
}
function transactionHash(blockNumber: bigint, logIndex = 0) {
  return keccak256(stringToHex(`transaction:${blockNumber}:${logIndex}`))
}
function seedCursor() {
  return createEventCursor({
    chainId: 1n,
    filter: FILTER,
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
  options: { branch?: string; logIndex?: number } = {},
): IndexedEventLog {
  const logIndex = options.logIndex ?? 0
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber, options.branch),
    blockNumber,
    data: '0x',
    logIndex,
    topics: [POST_PUBLISHED_TOPIC],
    transactionHash: transactionHash(blockNumber, logIndex),
    transactionIndex: 0,
  }
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
async function createCache(factory = new IDBFactory()) {
  cache = await openEventCache({
    databaseName: 'lifeinvader-event-cache-test',
    factory,
    keyRange: IDBKeyRange,
  })
  return { cache, factory }
}
async function putRawRecord(
  factory: IDBFactory,
  storeName: 'cursors' | 'logs',
  value: Record<string, unknown>,
) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('lifeinvader-event-cache-test', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

describe('browser event cache', () => {
  it('persists a bounded newest-first page and cursor', async () => {
    const factory = new IDBFactory()
    const opened = await createCache(factory)
    const seed = seedCursor()
    const next = cursorAt(seed, 4n)
    await opened.cache.apply(
      seed,
      syncResult(next, [eventLog(1n), eventLog(3n)]),
    )
    expect(await opened.cache.readLatest(seed)).toEqual({
      cursor: next,
      logs: [eventLog(3n), eventLog(1n)],
      reset: false,
    })

    opened.cache.close()
    cache = await openEventCache({
      databaseName: 'lifeinvader-event-cache-test',
      factory,
      keyRange: IDBKeyRange,
    })
    expect((await cache.readLatest(seed)).cursor).toEqual(next)
  })

  it('applies rollback deletion and replacement logs atomically', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const original = cursorAt(seed, 4n)
    await opened.apply(seed, syncResult(original, [eventLog(1n), eventLog(3n)]))
    const replacement = cursorAt(seed, 4n, 'b')
    await opened.apply(
      original,
      syncResult(replacement, [eventLog(2n, { branch: 'b' })], 2n),
    )
    const page = await opened.readLatest(seed)
    expect(page.cursor).toEqual(replacement)
    expect(page.logs).toEqual([eventLog(2n, { branch: 'b' }), eventLog(1n)])
  })

  it('rejects a stale concurrent batch without changing the cache', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const first = cursorAt(seed, 2n)
    await opened.apply(seed, syncResult(first, [eventLog(1n)]))
    await expect(
      opened.apply(seed, syncResult(cursorAt(seed, 1n), [eventLog(0n)])),
    ).rejects.toThrow(/changed during synchronization/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: first,
      logs: [eventLog(1n)],
    })
  })

  it('resets malformed persisted data instead of trusting it', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 2n)
    await opened.apply(seed, syncResult(next, [eventLog(1n)]))
    await putRawRecord(factory, 'cursors', {
      cursor: next,
      schemaVersion: 99,
      scope: getEventCacheScope(seed),
    })
    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      logs: [],
      reset: true,
    })
    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      logs: [],
      reset: false,
    })
  })

  it('resets a malformed cached log and its cursor together', async () => {
    const { cache: opened, factory } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 2n)
    const log = eventLog(1n)
    await opened.apply(seed, syncResult(next, [log]))
    const position = `${'0'.repeat(63)}1:${'0'.repeat(16)}:${'0'.repeat(16)}`
    await putRawRecord(factory, 'logs', {
      log: { ...log, data: '0x1' },
      position,
      schemaVersion: 1,
      scope: getEventCacheScope(seed),
    })
    expect(await opened.readLatest(seed)).toEqual({
      cursor: seed,
      logs: [],
      reset: true,
    })
  })

  it('limits reads without scanning the whole local history', async () => {
    const { cache: opened } = await createCache()
    const seed = seedCursor()
    const next = cursorAt(seed, 4n)
    await opened.apply(
      seed,
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
    await expect(
      opened.apply(seed, syncResult(next, [eventLog(3n)])),
    ).rejects.toThrow(/out-of-range/i)
    await expect(
      opened.apply(seed, syncResult(next, [eventLog(2n), eventLog(1n)])),
    ).rejects.toThrow(/canonically ordered/i)
    await expect(
      opened.apply(cursorAt(seed, 4n), syncResult(seed, [], 1n)),
    ).rejects.toThrow(/update boundary/i)
    expect(await opened.readLatest(seed)).toMatchObject({
      cursor: seed,
      logs: [],
    })
  })
})
