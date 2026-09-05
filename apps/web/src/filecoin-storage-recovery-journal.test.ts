import { calculate } from '@filoz/synapse-core/piece'
import { IDBFactory } from 'fake-indexeddb'
import { bytesToHex, getAddress, type Hash, type Hex } from 'viem'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createFilecoinStorageRecoveryJournal,
  FilecoinStorageRecoveryJournalError,
  MAX_FILECOIN_STORAGE_RECOVERY_RECORDS,
  type FilecoinStorageRecoveryJournalOptions,
} from './filecoin-storage-recovery-journal'
import { FILECOIN_CALIBRATION_CHAIN_ID } from './filecoin-storage'
import type { FilecoinStorageUploadCheckpoint } from './filecoin-storage-upload'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const SERVICE_PROVIDER = '0x0000000000000000000000000000000000005e11'
const MEDIA_CID = 'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm'
const HASH_A = `0x${'12'.repeat(32)}` as Hash
const HASH_B = `0x${'23'.repeat(32)}` as Hash
const HASH_C = `0x${'34'.repeat(32)}` as Hash
const CAR_BYTES = new Uint8Array(273).fill(7)
const RECOVERY_STORE = 'recoveries'

type TestStorage = Required<
  Pick<FilecoinStorageRecoveryJournalOptions, 'databaseName' | 'factory'>
>

type RawEnvelope = {
  raw: string
  schemaVersion: number
  uploadId: Hex
}

let piece: Awaited<ReturnType<typeof calculate>>

beforeAll(async () => {
  piece = await calculate(CAR_BYTES)
})

function uploadId(value: number) {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex
}

function checkpoint(
  id = uploadId(1),
  overrides: Partial<FilecoinStorageUploadCheckpoint> = {},
): FilecoinStorageUploadCheckpoint {
  return {
    account: ACCOUNT,
    carByteLength: CAR_BYTES.byteLength,
    chainId: FILECOIN_CALIBRATION_CHAIN_ID,
    ipfsIndexingRequested: true,
    mediaCid: MEDIA_CID,
    piece: {
      bytes: bytesToHex(piece.bytes),
      paddedSize: piece.paddedSize,
      size: piece.size,
      text: piece.toString(),
    },
    provider: {
      id: 17n,
      serviceProvider: SERVICE_PROVIDER,
      serviceUrl: 'https://provider.example/pdp',
    },
    uploadId: id,
    withCDN: false,
    ...overrides,
  }
}

function testStorage(factory = new IDBFactory()): TestStorage {
  return {
    databaseName: `filecoin-recovery-${crypto.randomUUID()}`,
    factory,
  }
}

function openJournal(storage: TestStorage, now: () => number = Date.now) {
  return createFilecoinStorageRecoveryJournal({ ...storage, now })
}

function openRawDatabase(storage: TestStorage) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = storage.factory.open(storage.databaseName, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => undefined
  })
}

async function readRawEnvelopes(storage: TestStorage) {
  const database = await openRawDatabase(storage)
  try {
    const transaction = database.transaction(RECOVERY_STORE, 'readonly')
    const request = transaction.objectStore(RECOVERY_STORE).getAll()
    let result: RawEnvelope[] = []
    request.onsuccess = () => {
      result = request.result as RawEnvelope[]
    }
    await transactionDone(transaction)
    return result
  } finally {
    database.close()
  }
}

async function rewriteRawEnvelope(
  storage: TestStorage,
  key: Hex,
  rewrite: (current: RawEnvelope) => RawEnvelope,
) {
  const database = await openRawDatabase(storage)
  try {
    const transaction = database.transaction(RECOVERY_STORE, 'readwrite')
    const store = transaction.objectStore(RECOVERY_STORE)
    const request = store.get(key)
    let rewriteError: unknown
    request.onsuccess = () => {
      try {
        const current = request.result as RawEnvelope | undefined
        if (!current) throw new Error('Missing raw recovery fixture')
        const next = rewrite(current)
        if (next.uploadId !== key) store.delete(key)
        store.put(next)
      } catch (error) {
        rewriteError = error
        transaction.abort()
      }
    }
    try {
      await transactionDone(transaction)
    } catch (error) {
      throw rewriteError ?? error
    }
  } finally {
    database.close()
  }
}

describe('Filecoin storage recovery journal', () => {
  it('round-trips a canonical checkpoint without persisting CAR bytes', async () => {
    const storage = testStorage()
    const source = checkpoint()
    const journal = openJournal(storage, () => 1_000)

    const staged = await journal.stage(source)
    source.provider.serviceUrl = 'https://mutated.example/'

    expect(staged).toEqual({
      checkpoint: {
        ...checkpoint(),
        account: getAddress(ACCOUNT),
        provider: {
          ...checkpoint().provider,
          serviceProvider: getAddress(SERVICE_PROVIDER),
          serviceUrl: 'https://provider.example/pdp/',
        },
      },
      createdAtMs: 1_000,
      transactionHashes: [],
      updatedAtMs: 1_000,
    })
    expect(Object.isFrozen(staged)).toBe(true)
    expect(Object.isFrozen(staged.checkpoint)).toBe(true)
    expect(Object.isFrozen(staged.transactionHashes)).toBe(true)

    const rawEntries = await readRawEnvelopes(storage)
    expect(rawEntries).toHaveLength(1)
    expect(rawEntries[0]?.raw).toContain(MEDIA_CID)
    expect(rawEntries[0]?.raw).not.toContain('carBytes')
    expect(rawEntries[0]?.raw.length).toBeLessThan(8_192)

    const reopened = openJournal(storage)
    const firstRead = await reopened.list()
    const secondRead = await reopened.list()
    expect(firstRead).toEqual([staged])
    expect(firstRead).not.toBe(secondRead)
  })

  it('records two transaction hashes idempotently with monotonic time', async () => {
    const storage = testStorage()
    let now = 10
    const journal = openJournal(storage, () => now)
    const saved = checkpoint()
    await journal.stage(saved)

    now = 11
    await journal.markSubmitted(
      saved,
      `0x${HASH_A.slice(2).toUpperCase()}` as Hash,
    )
    now = 12
    await journal.markSubmitted(saved, HASH_A)
    now = 13
    const replaced = await journal.markSubmitted(saved, HASH_B)

    expect(replaced.createdAtMs).toBe(10)
    expect(replaced.updatedAtMs).toBe(13)
    expect(replaced.transactionHashes).toEqual([HASH_A, HASH_B])
    now = 5
    expect((await journal.markSubmitted(saved, HASH_B)).updatedAtMs).toBe(13)
    await expect(journal.markSubmitted(saved, HASH_C)).rejects.toThrow(
      /transaction replacement limit/i,
    )
    expect((await journal.list())[0]?.transactionHashes).toEqual([
      HASH_A,
      HASH_B,
    ])
  })

  it('can create a submitted record if browser state was cleared mid-flow', async () => {
    const storage = testStorage()
    const journal = openJournal(storage, () => 22)

    await expect(
      journal.markSubmitted(checkpoint(), HASH_A),
    ).resolves.toMatchObject({
      createdAtMs: 22,
      transactionHashes: [HASH_A],
      updatedAtMs: 22,
    })
    await expect(journal.list()).resolves.toHaveLength(1)
  })

  it('serializes cross-tab admission without evicting a recovery', async () => {
    const storage = testStorage()
    const firstTab = openJournal(storage, () => 30)
    const secondTab = openJournal(storage, () => 31)
    for (
      let index = 1;
      index < MAX_FILECOIN_STORAGE_RECOVERY_RECORDS;
      index += 1
    ) {
      await firstTab.stage(checkpoint(uploadId(index)))
    }

    const candidates = [
      checkpoint(uploadId(MAX_FILECOIN_STORAGE_RECOVERY_RECORDS)),
      checkpoint(uploadId(MAX_FILECOIN_STORAGE_RECOVERY_RECORDS + 1)),
    ]
    const results = await Promise.allSettled([
      firstTab.stage(candidates[0]!),
      secondTab.stage(candidates[1]!),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({
      message: expect.stringMatching(/record limit was reached/i),
    })
    await expect(firstTab.list()).resolves.toHaveLength(
      MAX_FILECOIN_STORAGE_RECOVERY_RECORDS,
    )
  })

  it('updates one upload even when an unrelated record is corrupt', async () => {
    const storage = testStorage()
    const journal = openJournal(storage)
    const target = checkpoint(uploadId(1))
    const unrelated = checkpoint(uploadId(2))
    await journal.stage(target)
    await journal.stage(unrelated)
    await rewriteRawEnvelope(storage, unrelated.uploadId, (envelope) => ({
      ...envelope,
      raw: '{',
    }))

    await expect(journal.markSubmitted(target, HASH_A)).resolves.toMatchObject({
      transactionHashes: [HASH_A],
    })
    await expect(journal.list()).rejects.toThrow(/not valid JSON/i)

    await journal.remove(unrelated.uploadId)
    expect((await journal.list())[0]?.transactionHashes).toEqual([HASH_A])
  })

  it('refuses upload-ID collisions and corrupt target records', async () => {
    const storage = testStorage()
    const journal = openJournal(storage)
    const saved = checkpoint()
    await journal.stage(saved)

    await expect(
      journal.stage(
        checkpoint(saved.uploadId, {
          provider: { ...saved.provider, id: 18n },
        }),
      ),
    ).rejects.toThrow(/already bound to another checkpoint/i)

    await rewriteRawEnvelope(storage, saved.uploadId, (envelope) => {
      const record = JSON.parse(envelope.raw) as {
        checkpoint: { piece: { size: number } }
      }
      record.checkpoint.piece.size += 1
      return { ...envelope, raw: JSON.stringify(record) }
    })
    await expect(journal.list()).rejects.toThrow(/checkpoint is invalid/i)
    await expect(journal.stage(saved)).rejects.toThrow(/checkpoint is invalid/i)

    await journal.clear()
    await expect(journal.list()).resolves.toEqual([])
  })

  it('rejects records stored beneath another upload ID', async () => {
    const storage = testStorage()
    const journal = openJournal(storage)
    await journal.stage(checkpoint())
    await rewriteRawEnvelope(storage, uploadId(1), (envelope) => ({
      ...envelope,
      uploadId: uploadId(255),
    }))

    await expect(journal.list()).rejects.toThrow(/record key does not match/i)
    await journal.remove(uploadId(255))
    await expect(journal.list()).resolves.toEqual([])
  })

  it('deeply validates checkpoints and hashes before opening storage', async () => {
    const journal = openJournal(testStorage())
    await expect(
      journal.stage(checkpoint(uploadId(2), { chainId: 1n })),
    ).rejects.toThrow(/checkpoint is invalid/i)
    await expect(
      journal.stage(
        checkpoint(uploadId(3), {
          provider: {
            ...checkpoint().provider,
            serviceUrl: 'http://provider.example/',
          },
        }),
      ),
    ).rejects.toThrow(/checkpoint is invalid/i)
    await expect(
      journal.stage(
        checkpoint(uploadId(4), {
          piece: { ...checkpoint().piece, bytes: `0x${'00'.repeat(32)}` },
        }),
      ),
    ).rejects.toThrow(/checkpoint is invalid/i)
    await expect(
      journal.markSubmitted(checkpoint(), '0x12' as Hash),
    ).rejects.toThrow(/transaction hash is invalid/i)
  })

  it('reserves both hash slots before accepting a normalized checkpoint', async () => {
    const storage = testStorage()
    const journal = openJournal(storage)
    const oversizedAfterEncoding = checkpoint(uploadId(1), {
      provider: {
        ...checkpoint().provider,
        serviceUrl: `https://provider.example/${'😀'.repeat(700)}`,
      },
    })
    await expect(journal.stage(oversizedAfterEncoding)).rejects.toThrow(
      /checkpoint is invalid/i,
    )

    const largestSupported = checkpoint(uploadId(2), {
      provider: {
        ...checkpoint().provider,
        serviceUrl: `https://provider.example/${'a'.repeat(1_900)}`,
      },
    })
    await journal.stage(largestSupported)
    await journal.markSubmitted(largestSupported, HASH_A)
    await expect(
      journal.markSubmitted(largestSupported, HASH_B),
    ).resolves.toMatchObject({ transactionHashes: [HASH_A, HASH_B] })
    expect(
      (await readRawEnvelopes(storage))[0]?.raw.length,
    ).toBeLessThanOrEqual(8_192)
  })

  it('removes and clears only the selected recovery database', async () => {
    const factory = new IDBFactory()
    const firstStorage = testStorage(factory)
    const otherStorage = testStorage(factory)
    const first = openJournal(firstStorage)
    const other = openJournal(otherStorage)
    await first.stage(checkpoint(uploadId(1)))
    await first.stage(checkpoint(uploadId(2)))
    await other.stage(checkpoint(uploadId(3)))

    await first.remove(uploadId(1))
    expect(
      (await first.list()).map((record) => record.checkpoint.uploadId),
    ).toEqual([uploadId(2)])
    await first.clear()
    await expect(first.list()).resolves.toEqual([])
    await expect(other.list()).resolves.toHaveLength(1)
  })

  it('conditionally removes only the exact record observed by the caller', async () => {
    const storage = testStorage()
    const firstTab = openJournal(storage)
    const secondTab = openJournal(storage)
    const saved = checkpoint()
    const stale = await firstTab.stage(saved)

    await secondTab.markSubmitted(saved, HASH_A)
    await expect(firstTab.removeIfUnchanged(stale)).resolves.toBe(false)
    const latest = (await firstTab.list())[0]
    expect(latest?.transactionHashes).toEqual([HASH_A])

    await expect(firstTab.removeIfUnchanged(latest!)).resolves.toBe(true)
    await expect(firstTab.removeIfUnchanged(latest!)).resolves.toBe(true)
    await expect(firstTab.list()).resolves.toEqual([])
  })

  it('uses a specific error for unavailable storage and invalid names', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('Denied', 'SecurityError')
      },
    })
    try {
      const unavailable = createFilecoinStorageRecoveryJournal()
      await expect(unavailable.list()).rejects.toBeInstanceOf(
        FilecoinStorageRecoveryJournalError,
      )
      await expect(unavailable.list()).rejects.toThrow(
        /unavailable in this browser/i,
      )
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'indexedDB', original)
      } else {
        Reflect.deleteProperty(globalThis, 'indexedDB')
      }
    }

    const factory = new IDBFactory()
    await expect(
      createFilecoinStorageRecoveryJournal({
        databaseName: '',
        factory,
      }).list(),
    ).rejects.toThrow(/database name is invalid/i)
    await expect(
      createFilecoinStorageRecoveryJournal({
        databaseName: 'x'.repeat(129),
        factory,
      }).list(),
    ).rejects.toThrow(/database name is invalid/i)
  })
})
