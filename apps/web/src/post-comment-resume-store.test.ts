import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { Hash } from 'viem'
import type { PostCommentProjectionResumeState } from './post-comment-projection-run'
import {
  createPostCommentResumeStore,
  getPostCommentResumeScope,
  type PostCommentResumeTarget,
} from './post-comment-resume-store'

const HASH_A = `0x${'aa'.repeat(32)}` as Hash
const HASH_B = `0x${'bb'.repeat(32)}` as Hash

function target(
  postId: bigint,
  {
    blockHash = HASH_A,
    blockNumber = 8n,
    logIndex = Number(postId),
  }: Partial<Omit<PostCommentResumeTarget, 'postId'>> = {},
): PostCommentResumeTarget {
  return { blockHash, blockNumber, logIndex, postId }
}

function resumeState(marker = 7n) {
  return {
    baseline: {
      cursor: {
        chainId: 1n,
        checkpoints: [{ blockHash: HASH_A, blockNumber: 8n }],
        filterId: HASH_B,
        finalityDepth: 12n,
        nextBlock: 9n,
        rangeSize: 2_000,
        startBlock: 0n,
      },
      digest: HASH_A,
      generation: 'a'.repeat(64),
      last: { blockNumber: 8n, logIndex: 1 },
      logCount: 1,
      proof: HASH_B,
      revision: marker,
    },
    binding: { digest: HASH_A, proof: HASH_B },
    projection: {
      marker,
      nested: [{ count: marker }],
    },
  } as unknown as PostCommentProjectionResumeState
}

function testStore(factory = new IDBFactory()) {
  return {
    factory,
    name: `post-comment-resume-${crypto.randomUUID()}`,
  }
}

describe('post comment resume store', () => {
  it('round-trips bigint resume tuples without sharing mutable references', async () => {
    const storage = testStore()
    const first = createPostCommentResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    const scope = getPostCommentResumeScope([target(7n)])
    const resume = resumeState()

    await first.save(1n, scope, resume)
    ;(resume.projection as unknown as { marker: bigint }).marker = 99n

    const loaded = await first.load(1n, scope)
    expect(loaded).toEqual(resumeState())
    ;(
      loaded!.projection as unknown as { nested: Array<{ count: bigint }> }
    ).nested[0]!.count = 9n

    const reopened = createPostCommentResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    expect(await reopened.load(1n, scope)).toEqual(resumeState())
  })

  it('canonicalizes order and isolates chain and exact post identities', async () => {
    const storage = testStore()
    const store = createPostCommentResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    const firstScope = getPostCommentResumeScope([
      target(8n, { blockHash: HASH_B, blockNumber: 9n, logIndex: 2 }),
      target(7n),
    ])
    const reorderedScope = getPostCommentResumeScope([
      target(7n),
      target(8n, { blockHash: HASH_B, blockNumber: 9n, logIndex: 2 }),
    ])
    const replacedScope = getPostCommentResumeScope([
      target(7n, { blockHash: HASH_B }),
    ])
    expect(reorderedScope).toBe(firstScope)

    await store.save(1n, firstScope, resumeState(1n))
    await store.save(1n, replacedScope, resumeState(2n))
    await store.save(2n, firstScope, resumeState(3n))
    await store.remove(1n, reorderedScope)

    await expect(store.load(1n, firstScope)).resolves.toBeUndefined()
    expect(await store.load(1n, replacedScope)).toEqual(resumeState(2n))
    expect(await store.load(2n, firstScope)).toEqual(resumeState(3n))
  })

  it('rejects a corrupt envelope so the caller can discard it', async () => {
    const storage = testStore()
    const store = createPostCommentResumeStore({
      databaseName: storage.name,
      factory: storage.factory,
    })
    const scope = getPostCommentResumeScope([target(7n)])
    await store.save(1n, scope, resumeState())
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = storage.factory.open(storage.name, 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const read = database
      .transaction('post-comment-resumes', 'readonly')
      .objectStore('post-comment-resumes')
      .getAll()
    const records = await new Promise<Array<Record<string, unknown>>>(
      (resolve, reject) => {
        read.onerror = () => reject(read.error)
        read.onsuccess = () =>
          resolve(read.result as Array<Record<string, unknown>>)
      },
    )
    const transaction = database.transaction(
      'post-comment-resumes',
      'readwrite',
    )
    transaction.objectStore('post-comment-resumes').put({
      ...records[0],
      schemaVersion: 99,
    })
    await new Promise<void>((resolve, reject) => {
      transaction.onabort = () => reject(transaction.error)
      transaction.oncomplete = () => resolve()
    })
    database.close()

    await expect(store.load(1n, scope)).rejects.toThrow(/record is invalid/i)
    await store.remove(1n, scope)
    await expect(store.load(1n, scope)).resolves.toBeUndefined()
  })

  it('fails clearly for unavailable storage and invalid scopes', async () => {
    const unavailable = createPostCommentResumeStore({ factory: undefined })
    const original = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: undefined,
    })
    try {
      await expect(
        unavailable.load(1n, getPostCommentResumeScope([target(7n)])),
      ).rejects.toThrow(/unavailable/i)
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: original,
      })
    }

    const store = createPostCommentResumeStore({
      databaseName: `post-comment-resume-${crypto.randomUUID()}`,
      factory: new IDBFactory(),
    })
    const validScope = getPostCommentResumeScope([target(7n)])
    await expect(store.load(-1n, validScope)).rejects.toThrow(/chain/i)
    await expect(store.load(1n << 256n, validScope)).rejects.toThrow(/chain/i)
    await expect(store.load(1n, '')).rejects.toThrow(/post scope/i)
    await expect(store.load(1n, `0${validScope}`)).rejects.toThrow(
      /post scope/i,
    )
    await expect(store.load(1n, `${validScope};${validScope}`)).rejects.toThrow(
      /duplicate/i,
    )
    await expect(store.load(1n, '1,0,0xnope,0')).rejects.toThrow(/hash/i)
  })

  it('rejects ambiguous post and block identities before deriving a key', () => {
    expect(() => getPostCommentResumeScope([target(7n), target(7n)])).toThrow(
      /duplicate/i,
    )
    expect(() =>
      getPostCommentResumeScope([
        target(7n),
        target(8n, { blockHash: HASH_B, blockNumber: 8n }),
      ]),
    ).toThrow(/block identity/i)
    expect(() =>
      getPostCommentResumeScope([
        target(7n),
        target(8n, { blockHash: HASH_A, blockNumber: 9n }),
      ]),
    ).toThrow(/block identity/i)
    expect(() =>
      getPostCommentResumeScope([
        target(7n, { logIndex: Number.MAX_SAFE_INTEGER + 1 }),
      ]),
    ).toThrow(/log index/i)
  })
})
