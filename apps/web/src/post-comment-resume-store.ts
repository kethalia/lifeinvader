import { keccak256, stringToHex, type Hash } from 'viem'
import { MAX_POST_COMMENT_PROJECTION_POSTS } from './post-comment-projection'
import type { PostCommentProjectionResumeState } from './post-comment-projection-run'

const DEFAULT_DATABASE_NAME = 'lifeinvader-post-comment-resume-cache'
const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const MAX_POST_SCOPE_TEXT_LENGTH = 12_000
const POST_COMMENT_RESUME_SCHEMA_VERSION = 1
const RESUME_STORE = 'post-comment-resumes'

export type PostCommentResumeTarget = {
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
  postId: bigint
}

export type PostCommentResumeStoreOptions = {
  databaseName?: string
  factory?: IDBFactory
}

export type PostCommentResumeStore = {
  load(
    chainId: bigint,
    postScope: string,
  ): Promise<PostCommentProjectionResumeState | undefined>
  remove(chainId: bigint, postScope: string): Promise<void>
  save(
    chainId: bigint,
    postScope: string,
    resume: PostCommentProjectionResumeState,
  ): Promise<void>
}

type StoredPostCommentResume = {
  chainId: bigint
  postScope: string
  resume: PostCommentProjectionResumeState
  schemaVersion: typeof POST_COMMENT_RESUME_SCHEMA_VERSION
  scope: string
}

function resumeStoreError(message: string) {
  return new Error(`Post comment resume cache ${message}.`)
}

function asError(value: unknown, fallback: string) {
  return value instanceof Error ? value : resumeStoreError(fallback)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeQuantity(value: unknown, label: string, minimum = 0n) {
  if (
    typeof value !== 'bigint' ||
    value < minimum ||
    value > MAX_EVM_QUANTITY
  ) {
    throw resumeStoreError(`${label} is invalid`)
  }
  return value
}

function normalizeIndex(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw resumeStoreError('post log index is invalid')
  }
  return value
}

function normalizeHash(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw resumeStoreError('post block hash is invalid')
  }
  return value.toLowerCase() as Hash
}

export function getPostCommentResumeScope(postsValue: unknown) {
  if (
    !Array.isArray(postsValue) ||
    postsValue.length < 1 ||
    postsValue.length > MAX_POST_COMMENT_PROJECTION_POSTS
  ) {
    throw resumeStoreError('post scope is invalid')
  }
  const postIds = new Set<string>()
  const blockHashes = new Map<bigint, Hash>()
  const blockNumbers = new Map<Hash, bigint>()
  const posts = postsValue.map((value) => {
    if (!isRecord(value)) throw resumeStoreError('post scope is invalid')
    const postId = normalizeQuantity(value.postId, 'post identifier', 1n)
    const blockNumber = normalizeQuantity(value.blockNumber, 'post block')
    const blockHash = normalizeHash(value.blockHash)
    const logIndex = normalizeIndex(value.logIndex)
    const postKey = postId.toString(16)
    if (postIds.has(postKey)) {
      throw resumeStoreError('post scope contains a duplicate identifier')
    }
    postIds.add(postKey)
    const knownHash = blockHashes.get(blockNumber)
    const knownBlockNumber = blockNumbers.get(blockHash)
    if (
      (knownHash !== undefined && knownHash !== blockHash) ||
      (knownBlockNumber !== undefined && knownBlockNumber !== blockNumber)
    ) {
      throw resumeStoreError('post scope block identity is invalid')
    }
    blockHashes.set(blockNumber, blockHash)
    blockNumbers.set(blockHash, blockNumber)
    return `${postKey},${blockNumber.toString(16)},${blockHash},${logIndex.toString(16)}`
  })
  return posts.toSorted().join(';')
}

function normalizePostScope(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_POST_SCOPE_TEXT_LENGTH
  ) {
    throw resumeStoreError('post scope is invalid')
  }
  const posts = value.split(';').map((entry) => {
    const fields = entry.split(',')
    if (fields.length !== 4) throw resumeStoreError('post scope is invalid')
    const [postId, blockNumber, blockHash, logIndex] = fields
    if (
      !/^[1-9a-f][0-9a-f]*$/.test(postId!) ||
      !/^(?:0|[1-9a-f][0-9a-f]*)$/.test(blockNumber!) ||
      !/^(?:0|[1-9a-f][0-9a-f]*)$/.test(logIndex!)
    ) {
      throw resumeStoreError('post scope is invalid')
    }
    const parsedLogIndex = BigInt(`0x${logIndex}`)
    if (parsedLogIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw resumeStoreError('post scope is invalid')
    }
    return {
      blockHash,
      blockNumber: BigInt(`0x${blockNumber}`),
      logIndex: Number(parsedLogIndex),
      postId: BigInt(`0x${postId}`),
    }
  })
  const normalized = getPostCommentResumeScope(posts)
  if (normalized !== value) throw resumeStoreError('post scope is invalid')
  return normalized
}

function normalizeScope(chainIdValue: unknown, postScopeValue: unknown) {
  const chainId = normalizeQuantity(chainIdValue, 'chain identifier')
  const postScope = normalizePostScope(postScopeValue)
  const postScopeId = keccak256(
    stringToHex(
      JSON.stringify(['lifeinvader.post-comment-resume-scope.v1', postScope]),
    ),
  )
  return {
    chainId,
    postScope,
    scope: `${chainId.toString(16)}:${postScopeId}`,
  }
}

function normalizeStoredResume(
  value: unknown,
  expected: ReturnType<typeof normalizeScope>,
) {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    value.schemaVersion !== POST_COMMENT_RESUME_SCHEMA_VERSION ||
    value.scope !== expected.scope ||
    value.chainId !== expected.chainId ||
    value.postScope !== expected.postScope ||
    !isRecord(value.resume)
  ) {
    throw resumeStoreError('record is invalid')
  }
  // IndexedDB is an acceleration layer. The projection runner performs the
  // authoritative deep validation and authenticates this untrusted tuple.
  return value.resume as PostCommentProjectionResumeState
}

function openDatabase(options: PostCommentResumeStoreOptions) {
  const factory = options.factory ?? globalThis.indexedDB
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME
  if (!factory) throw resumeStoreError('is unavailable in this browser')
  if (
    typeof databaseName !== 'string' ||
    databaseName.length < 1 ||
    databaseName.length > 128
  ) {
    throw resumeStoreError('database name is invalid')
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(
      databaseName,
      POST_COMMENT_RESUME_SCHEMA_VERSION,
    )
    let settled = false
    const fail = (value: unknown, fallback: string) => {
      if (settled) return
      settled = true
      reject(asError(value, fallback))
    }
    request.onupgradeneeded = () => {
      const database = request.result
      for (const storeName of Array.from(database.objectStoreNames)) {
        database.deleteObjectStore(storeName)
      }
      database.createObjectStore(RESUME_STORE, { keyPath: 'scope' })
    }
    request.onerror = () => fail(request.error, 'could not open')
    request.onblocked = () =>
      fail(undefined, 'is blocked by another browser tab')
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

function readRecord(database: IDBDatabase, scope: string) {
  return new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction(RESUME_STORE, 'readonly')
    const request = transaction.objectStore(RESUME_STORE).get(scope)
    let result: unknown
    request.onsuccess = () => {
      result = request.result
    }
    request.onerror = () => undefined
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () =>
      reject(asError(transaction.error, 'read was aborted'))
    transaction.onerror = () => undefined
  })
}

function writeRecord(
  database: IDBDatabase,
  mode: 'remove' | 'save',
  scope: string,
  record?: StoredPostCommentResume,
) {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(RESUME_STORE, 'readwrite')
    try {
      if (mode === 'save') {
        transaction.objectStore(RESUME_STORE).put(record!)
      } else {
        transaction.objectStore(RESUME_STORE).delete(scope)
      }
    } catch (error) {
      transaction.abort()
      reject(asError(error, `${mode} failed`))
      return
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(asError(transaction.error, `${mode} was aborted`))
    transaction.onerror = () => undefined
  })
}

async function withDatabase<T>(
  options: PostCommentResumeStoreOptions,
  operation: (database: IDBDatabase) => Promise<T>,
) {
  const database = await openDatabase(options)
  try {
    return await operation(database)
  } finally {
    database.close()
  }
}

export function createPostCommentResumeStore(
  options: PostCommentResumeStoreOptions = {},
): PostCommentResumeStore {
  return {
    async load(chainId, postScope) {
      const scope = normalizeScope(chainId, postScope)
      return withDatabase(options, async (database) =>
        normalizeStoredResume(await readRecord(database, scope.scope), scope),
      )
    },
    async remove(chainId, postScope) {
      const scope = normalizeScope(chainId, postScope)
      await withDatabase(options, (database) =>
        writeRecord(database, 'remove', scope.scope),
      )
    },
    async save(chainId, postScope, resume) {
      const scope = normalizeScope(chainId, postScope)
      if (!isRecord(resume)) throw resumeStoreError('resume state is invalid')
      await withDatabase(options, (database) =>
        writeRecord(database, 'save', scope.scope, {
          chainId: scope.chainId,
          postScope: scope.postScope,
          resume,
          schemaVersion: POST_COMMENT_RESUME_SCHEMA_VERSION,
          scope: scope.scope,
        }),
      )
    },
  }
}
