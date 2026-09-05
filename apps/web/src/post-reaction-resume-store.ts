import type { PostReactionProjectionResumeState } from './post-reaction-projection-run'

const DEFAULT_DATABASE_NAME = 'lifeinvader-post-reaction-resume-cache'
const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const POST_REACTION_RESUME_SCHEMA_VERSION = 1
const RESUME_STORE = 'post-reaction-resumes'

export type PostReactionResumeStoreOptions = {
  databaseName?: string
  factory?: IDBFactory
}

export type PostReactionResumeStore = {
  load(chainId: bigint): Promise<PostReactionProjectionResumeState | undefined>
  remove(chainId: bigint): Promise<void>
  save(
    chainId: bigint,
    resume: PostReactionProjectionResumeState,
  ): Promise<void>
}

type StoredPostReactionResume = {
  chainId: bigint
  resume: PostReactionProjectionResumeState
  schemaVersion: typeof POST_REACTION_RESUME_SCHEMA_VERSION
  scope: string
}

function resumeStoreError(message: string) {
  return new Error(`Post reaction resume cache ${message}.`)
}

function asError(value: unknown, fallback: string) {
  return value instanceof Error ? value : resumeStoreError(fallback)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeScope(chainId: unknown) {
  if (
    typeof chainId !== 'bigint' ||
    chainId < 0n ||
    chainId > MAX_EVM_QUANTITY
  ) {
    throw resumeStoreError('chain identifier is invalid')
  }
  return { chainId, scope: chainId.toString(16) }
}

function normalizeStoredResume(
  value: unknown,
  expected: ReturnType<typeof normalizeScope>,
) {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    value.schemaVersion !== POST_REACTION_RESUME_SCHEMA_VERSION ||
    value.scope !== expected.scope ||
    value.chainId !== expected.chainId ||
    !isRecord(value.resume)
  ) {
    throw resumeStoreError('record is invalid')
  }
  // IndexedDB is an acceleration layer. The projection runner performs the
  // authoritative deep validation and authenticates this untrusted tuple.
  return value.resume as PostReactionProjectionResumeState
}

function openDatabase(options: PostReactionResumeStoreOptions) {
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
      POST_REACTION_RESUME_SCHEMA_VERSION,
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
  record?: StoredPostReactionResume,
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
  options: PostReactionResumeStoreOptions,
  operation: (database: IDBDatabase) => Promise<T>,
) {
  const database = await openDatabase(options)
  try {
    return await operation(database)
  } finally {
    database.close()
  }
}

export function createPostReactionResumeStore(
  options: PostReactionResumeStoreOptions = {},
): PostReactionResumeStore {
  return {
    async load(chainId) {
      const scope = normalizeScope(chainId)
      return withDatabase(options, async (database) =>
        normalizeStoredResume(await readRecord(database, scope.scope), scope),
      )
    },
    async remove(chainId) {
      const scope = normalizeScope(chainId)
      await withDatabase(options, (database) =>
        writeRecord(database, 'remove', scope.scope),
      )
    },
    async save(chainId, resume) {
      const scope = normalizeScope(chainId)
      if (!isRecord(resume)) throw resumeStoreError('resume state is invalid')
      await withDatabase(options, (database) =>
        writeRecord(database, 'save', scope.scope, {
          chainId: scope.chainId,
          resume,
          schemaVersion: POST_REACTION_RESUME_SCHEMA_VERSION,
          scope: scope.scope,
        }),
      )
    },
  }
}
