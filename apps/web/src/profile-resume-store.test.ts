import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { type Address, type Hash } from 'viem'
import type { ProfileProjectionResumeState } from './profile-projection-run'
import { createProfileResumeStore } from './profile-resume-store'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const HASH_A = `0x${'aa'.repeat(32)}` as Hash
const HASH_B = `0x${'bb'.repeat(32)}` as Hash

function resumeState(
  account = ACCOUNT_A,
  displayName = 'Tracey',
): ProfileProjectionResumeState {
  const cursor = {
    chainId: 1n,
    checkpoints: [{ blockHash: HASH_A, blockNumber: 8n }],
    filterId: HASH_B,
    finalityDepth: 12n,
    nextBlock: 9n,
    rangeSize: 2_000,
    startBlock: 0n,
  }
  return {
    baseline: {
      cursor,
      digest: HASH_A,
      generation: 'a'.repeat(64),
      last: { blockNumber: 3n, logIndex: 0 },
      logCount: 1,
      proof: HASH_B,
      revision: 2n,
    },
    binding: { digest: HASH_A, proof: HASH_B },
    projection: {
      accounts: [account],
      confirmedThrough: { blockHash: HASH_A, blockNumber: 8n },
      last: { blockHash: HASH_B, blockNumber: 3n, logIndex: 0 },
      profiles: [
        {
          account,
          avatarCid: '0x',
          bio: 'Nothing here is private.',
          blockHash: HASH_B,
          blockNumber: 3n,
          displayName,
          logIndex: 0,
          transactionHash: HASH_A,
          transactionIndex: 0,
        },
      ],
      schemaVersion: 1,
    },
  }
}

function testStore(factory = new IDBFactory()) {
  return {
    factory,
    name: `profile-resume-${crypto.randomUUID()}`,
  }
}

describe('profile resume store', () => {
  it('round-trips bigint resume tuples without sharing mutable references', async () => {
    const storage = testStore()
    const first = createProfileResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    const resume = resumeState()

    await first.save(1n, ACCOUNT_A, resume)
    resume.projection.profiles[0]!.displayName = 'Mutated source'

    const loaded = await first.load(1n, ACCOUNT_A)
    expect(loaded).toEqual(resumeState())
    loaded!.projection.profiles[0]!.displayName = 'Mutated result'

    const reopened = createProfileResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    expect(await reopened.load(1n, ACCOUNT_A)).toEqual(resumeState())
  })

  it('isolates chain and account scopes and removes only the selected tuple', async () => {
    const storage = testStore()
    const store = createProfileResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    await store.save(1n, ACCOUNT_A, resumeState())
    await store.save(1n, ACCOUNT_B, resumeState(ACCOUNT_B, 'Michael'))
    await store.save(2n, ACCOUNT_A, resumeState(ACCOUNT_A, 'Chain two'))

    await store.remove(1n, ACCOUNT_A)

    expect(await store.load(1n, ACCOUNT_A)).toBeUndefined()
    expect(
      (await store.load(1n, ACCOUNT_B))?.projection.profiles[0]?.displayName,
    ).toBe('Michael')
    expect(
      (await store.load(2n, ACCOUNT_A))?.projection.profiles[0]?.displayName,
    ).toBe('Chain two')
  })

  it('rejects a corrupt envelope so the caller can discard it', async () => {
    const storage = testStore()
    const store = createProfileResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    await store.save(1n, ACCOUNT_A, resumeState())
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = storage.factory.open(storage.name, 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const transaction = database.transaction('profile-resumes', 'readwrite')
    transaction.objectStore('profile-resumes').put({
      account: ACCOUNT_A,
      chainId: 1n,
      resume: resumeState(),
      schemaVersion: 99,
      scope: `1:${ACCOUNT_A.toLowerCase()}`,
    })
    await new Promise<void>((resolve, reject) => {
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve()
    })
    database.close()

    await expect(store.load(1n, ACCOUNT_A)).rejects.toThrow(
      /record is invalid/i,
    )
    await store.remove(1n, ACCOUNT_A)
    await expect(store.load(1n, ACCOUNT_A)).resolves.toBeUndefined()
  })

  it('fails clearly for unavailable storage and invalid scopes', async () => {
    const unavailable = createProfileResumeStore({
      factory: undefined,
    })
    const original = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
    try {
      await expect(unavailable.load(1n, ACCOUNT_A)).rejects.toThrow(
        /unavailable/i,
      )
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: original,
      })
    }

    const store = createProfileResumeStore({
      databaseName: `profile-resume-${crypto.randomUUID()}`,
      factory: new IDBFactory(),
    })
    await expect(store.load(-1n, ACCOUNT_A)).rejects.toThrow(/chain/i)
    await expect(store.load(1n, 'not-an-address' as Address)).rejects.toThrow(
      /account/i,
    )
  })
})
