import { calculate } from '@filoz/synapse-core/piece'
import { bytesToHex, getAddress, type Hash, type Hex } from 'viem'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createFilecoinStorageRecoveryJournal,
  FilecoinStorageRecoveryJournalError,
  MAX_FILECOIN_STORAGE_RECOVERY_RECORDS,
  type FilecoinStorageRecoveryStorage,
} from './filecoin-storage-recovery-journal'
import type { FilecoinStorageUploadCheckpoint } from './filecoin-storage-upload'
import { FILECOIN_CALIBRATION_CHAIN_ID } from './filecoin-storage'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const SERVICE_PROVIDER = '0x0000000000000000000000000000000000005e11'
const MEDIA_CID = 'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm'
const HASH_A = `0x${'12'.repeat(32)}` as Hash
const HASH_B = `0x${'23'.repeat(32)}` as Hash
const HASH_C = `0x${'34'.repeat(32)}` as Hash
const CAR_BYTES = new Uint8Array(273).fill(7)

let piece: Awaited<ReturnType<typeof calculate>>

beforeAll(async () => {
  piece = await calculate(CAR_BYTES)
})

class MemoryStorage implements FilecoinStorageRecoveryStorage {
  readonly items = new Map<string, string>()

  get length() {
    return this.items.size
  }

  getItem(key: string) {
    return this.items.get(key) ?? null
  }

  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.items.delete(key)
  }

  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}

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

function onlyRecoveryEntry(storage: MemoryStorage) {
  const entries = [...storage.items.entries()].filter(([key]) =>
    key.startsWith('lifeinvader:filecoin-storage-recovery:'),
  )
  expect(entries).toHaveLength(1)
  return entries[0]!
}

describe('Filecoin storage recovery journal', () => {
  it('round-trips a canonical checkpoint without persisting CAR bytes', () => {
    const storage = new MemoryStorage()
    const source = checkpoint()
    const journal = createFilecoinStorageRecoveryJournal({
      now: () => 1_000,
      storage,
    })

    const staged = journal.stage(source)
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

    const [, raw] = onlyRecoveryEntry(storage)
    expect(raw).toContain(MEDIA_CID)
    expect(raw).not.toContain('carBytes')
    expect(raw.length).toBeLessThan(8_192)

    const reopened = createFilecoinStorageRecoveryJournal({ storage })
    expect(reopened.list()).toEqual([staged])
    expect(reopened.list()).not.toBe(reopened.list())
  })

  it('records an initial and replacement transaction hash idempotently', () => {
    const storage = new MemoryStorage()
    let now = 10
    const journal = createFilecoinStorageRecoveryJournal({
      now: () => now,
      storage,
    })
    const saved = checkpoint()
    journal.stage(saved)

    now = 11
    journal.markSubmitted(saved, `0x${HASH_A.slice(2).toUpperCase()}` as Hash)
    now = 12
    journal.markSubmitted(saved, HASH_A)
    now = 13
    const replaced = journal.markSubmitted(saved, HASH_B)

    expect(replaced.createdAtMs).toBe(10)
    expect(replaced.updatedAtMs).toBe(13)
    expect(replaced.transactionHashes).toEqual([HASH_A, HASH_B])
    expect(() => journal.markSubmitted(saved, HASH_C)).toThrow(
      /transaction replacement limit/i,
    )
    expect(journal.list()[0]?.transactionHashes).toEqual([HASH_A, HASH_B])
  })

  it('can create a submitted record if browser storage was cleared mid-flow', () => {
    const storage = new MemoryStorage()
    const journal = createFilecoinStorageRecoveryJournal({
      now: () => 22,
      storage,
    })

    expect(journal.markSubmitted(checkpoint(), HASH_A)).toMatchObject({
      createdAtMs: 22,
      transactionHashes: [HASH_A],
      updatedAtMs: 22,
    })
    expect(journal.list()).toHaveLength(1)
  })

  it('caps unresolved records without evicting them and clears only its keys', () => {
    const storage = new MemoryStorage()
    storage.setItem('another-static-app', 'keep me')
    const journal = createFilecoinStorageRecoveryJournal({
      now: () => 30,
      storage,
    })
    for (
      let index = 1;
      index <= MAX_FILECOIN_STORAGE_RECOVERY_RECORDS;
      index += 1
    ) {
      journal.stage(checkpoint(uploadId(index)))
    }

    expect(journal.list()).toHaveLength(MAX_FILECOIN_STORAGE_RECOVERY_RECORDS)
    expect(() =>
      journal.stage(
        checkpoint(uploadId(MAX_FILECOIN_STORAGE_RECOVERY_RECORDS + 1)),
      ),
    ).toThrow(/record limit was reached/i)
    expect(journal.list()).toHaveLength(MAX_FILECOIN_STORAGE_RECOVERY_RECORDS)

    journal.remove(uploadId(1))
    journal.stage(
      checkpoint(uploadId(MAX_FILECOIN_STORAGE_RECOVERY_RECORDS + 1)),
    )
    const [recoveryKey, raw] = [...storage.items.entries()].find(([key]) =>
      key.startsWith('lifeinvader:filecoin-storage-recovery:'),
    )!
    storage.setItem(`${recoveryKey.slice(0, -64)}${'ff'.repeat(32)}`, raw)
    expect(() => journal.list()).toThrow(/record limit was exceeded/i)
    journal.clear()
    expect(journal.list()).toEqual([])
    expect(storage.getItem('another-static-app')).toBe('keep me')
  })

  it('refuses upload-ID collisions and corrupt records instead of replacing them', () => {
    const storage = new MemoryStorage()
    const journal = createFilecoinStorageRecoveryJournal({ storage })
    const saved = checkpoint()
    journal.stage(saved)

    expect(() =>
      journal.stage(
        checkpoint(saved.uploadId, {
          provider: { ...saved.provider, id: 18n },
        }),
      ),
    ).toThrow(/already bound to another checkpoint/i)

    const [key, raw] = onlyRecoveryEntry(storage)
    const corrupt = JSON.parse(raw) as {
      checkpoint: { piece: { size: number } }
    }
    corrupt.checkpoint.piece.size += 1
    storage.setItem(key, JSON.stringify(corrupt))
    expect(() => journal.list()).toThrow(/checkpoint is invalid/i)
    expect(() => journal.stage(saved)).toThrow(/checkpoint is invalid/i)

    journal.clear()
    expect(journal.list()).toEqual([])
  })

  it('rejects records stored beneath another upload ID', () => {
    const storage = new MemoryStorage()
    const journal = createFilecoinStorageRecoveryJournal({ storage })
    journal.stage(checkpoint())
    const [key, raw] = onlyRecoveryEntry(storage)
    storage.removeItem(key)
    storage.setItem(`${key.slice(0, -64)}${'ff'.repeat(32)}`, raw)

    expect(() => journal.list()).toThrow(/record key does not match/i)
    journal.clear()
    expect(journal.list()).toEqual([])
  })

  it('deeply validates checkpoints before writing browser state', () => {
    const journal = createFilecoinStorageRecoveryJournal({
      storage: new MemoryStorage(),
    })
    expect(() =>
      journal.stage(checkpoint(uploadId(2), { chainId: 1n })),
    ).toThrow(/checkpoint is invalid/i)
    expect(() =>
      journal.stage(
        checkpoint(uploadId(3), {
          provider: {
            ...checkpoint().provider,
            serviceUrl: 'http://provider.example/',
          },
        }),
      ),
    ).toThrow(/checkpoint is invalid/i)
    expect(() =>
      journal.stage(
        checkpoint(uploadId(4), {
          piece: { ...checkpoint().piece, bytes: `0x${'00'.repeat(32)}` },
        }),
      ),
    ).toThrow(/checkpoint is invalid/i)
  })

  it('fails closed on quota errors and an excessive origin-key scan', () => {
    const quotaStorage = new MemoryStorage()
    quotaStorage.setItem = () => {
      throw new DOMException('Full', 'QuotaExceededError')
    }
    const quotaJournal = createFilecoinStorageRecoveryJournal({
      storage: quotaStorage,
    })
    expect(() => quotaJournal.stage(checkpoint())).toThrow(
      /could not write browser storage/i,
    )
    expect(quotaStorage.length).toBe(0)

    const crowdedStorage = new MemoryStorage()
    for (let index = 0; index < 513; index += 1) {
      crowdedStorage.setItem(`unrelated-${index.toString()}`, 'x')
    }
    const crowdedJournal = createFilecoinStorageRecoveryJournal({
      storage: crowdedStorage,
    })
    expect(() => crowdedJournal.list()).toThrow(/scan limit/i)
  })

  it('uses a specific error type for unavailable browser storage', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Denied', 'SecurityError')
      },
    })
    try {
      expect(() => createFilecoinStorageRecoveryJournal()).toThrow(
        FilecoinStorageRecoveryJournalError,
      )
      expect(() => createFilecoinStorageRecoveryJournal()).toThrow(
        /unavailable in this browser/i,
      )
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original)
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage')
      }
    }
  })
})
