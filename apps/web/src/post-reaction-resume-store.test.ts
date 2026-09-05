import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { type Address, type Hash } from 'viem'
import { getPostReactionProjectionSnapshotDigest } from './post-reaction-projection'
import type { PostReactionProjectionResumeState } from './post-reaction-projection-run'
import { createPostReactionResumeStore } from './post-reaction-resume-store'

const ACCOUNT = '0x000000000000000000000000000000000000aaaa' as Address
const HASH_A = `0x${'aa'.repeat(32)}` as Hash
const HASH_B = `0x${'bb'.repeat(32)}` as Hash

function resumeState(postId = 7n): PostReactionProjectionResumeState {
  const projection = {
    activeLikes: [{ account: ACCOUNT, postId }],
    blockHashes: [],
    confirmedThrough: { blockHash: HASH_A, blockNumber: 8n },
    progress: {
      likes: { blockHash: HASH_B, blockNumber: 3n, logIndex: 0 },
      reposts: { blockHash: HASH_B, blockNumber: 3n, logIndex: 1 },
    },
    repostCounts: [{ count: 1n, postId }],
    schemaVersion: 1 as const,
  }
  const digest = getPostReactionProjectionSnapshotDigest(projection)
  const baseline = (filterId: Hash, logIndex: number) => ({
    cursor: {
      chainId: 1n,
      checkpoints: [{ blockHash: HASH_A, blockNumber: 8n }],
      filterId,
      finalityDepth: 12n,
      nextBlock: 9n,
      rangeSize: 2_000,
      startBlock: 0n,
    },
    digest: HASH_A,
    generation: 'a'.repeat(64),
    last: { blockNumber: 3n, logIndex },
    logCount: 1,
    proof: HASH_B,
    revision: 2n,
  })
  return {
    baselines: {
      likes: baseline(HASH_A, 0),
      reposts: baseline(HASH_B, 1),
    },
    bindings: {
      likes: { digest, proof: HASH_A },
      reposts: { digest, proof: HASH_B },
    },
    projection,
  }
}

function testStore(factory = new IDBFactory()) {
  return {
    factory,
    name: `post-reaction-resume-${crypto.randomUUID()}`,
  }
}

describe('post reaction resume store', () => {
  it('round-trips bigint resume tuples without sharing mutable references', async () => {
    const storage = testStore()
    const first = createPostReactionResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    const resume = resumeState()

    await first.save(1n, resume)
    resume.projection.activeLikes[0]!.postId = 99n

    const loaded = await first.load(1n)
    expect(loaded).toEqual(resumeState())
    loaded!.projection.repostCounts[0]!.count = 9n

    const reopened = createPostReactionResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    expect(await reopened.load(1n)).toEqual(resumeState())
  })

  it('isolates chain scopes and removes only the selected tuple', async () => {
    const storage = testStore()
    const store = createPostReactionResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    await store.save(1n, resumeState(7n))
    await store.save(2n, resumeState(8n))

    await store.remove(1n)

    expect(await store.load(1n)).toBeUndefined()
    expect((await store.load(2n))?.projection.activeLikes[0]?.postId).toBe(8n)
  })

  it('rejects a corrupt envelope so the caller can discard it', async () => {
    const storage = testStore()
    const store = createPostReactionResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    await store.save(1n, resumeState())
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = storage.factory.open(storage.name, 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const transaction = database.transaction(
      'post-reaction-resumes',
      'readwrite',
    )
    transaction.objectStore('post-reaction-resumes').put({
      chainId: 1n,
      resume: resumeState(),
      schemaVersion: 99,
      scope: '1',
    })
    await new Promise<void>((resolve, reject) => {
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve()
    })
    database.close()

    await expect(store.load(1n)).rejects.toThrow(/record is invalid/i)
    await store.remove(1n)
    await expect(store.load(1n)).resolves.toBeUndefined()
  })

  it('fails clearly for unavailable storage and invalid scopes', async () => {
    const unavailable = createPostReactionResumeStore({ factory: undefined })
    const original = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
    try {
      await expect(unavailable.load(1n)).rejects.toThrow(/unavailable/i)
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: original,
      })
    }

    const store = createPostReactionResumeStore({
      databaseName: `post-reaction-resume-${crypto.randomUUID()}`,
      factory: new IDBFactory(),
    })
    await expect(store.load(-1n)).rejects.toThrow(/chain/i)
    await expect(store.load(1n << 256n)).rejects.toThrow(/chain/i)
  })
})
