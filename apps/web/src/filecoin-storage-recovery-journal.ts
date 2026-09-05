import { type Address, type Hash, type Hex } from 'viem'
import {
  normalizeFilecoinStorageUploadCheckpoint,
  type FilecoinStorageUploadCheckpoint,
} from './filecoin-storage-upload'

const DEFAULT_DATABASE_NAME = 'lifeinvader-filecoin-storage-recovery'
const RECOVERY_DATABASE_VERSION = 2
const RECOVERY_SCHEMA_VERSION = 1
const RECOVERY_STORE = 'recoveries'
const RECOVERY_TOMBSTONE_STORE = 'discarded-recoveries'
const RECOVERY_NOTIFICATION_PREFIX = 'lifeinvader:filecoin-storage-recovery:'
const RECOVERY_NOTIFICATION_MESSAGE = 'journal-changed-v1'
const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const MAX_RECORD_BYTES = 8_192
const HASH_CAPACITY_SENTINELS = [
  `0x${'00'.repeat(32)}` as Hash,
  `0x${'ff'.repeat(32)}` as Hash,
] as const

export const MAX_FILECOIN_STORAGE_RECOVERY_RECORDS = 16

export type FilecoinStorageRecoveryRecord = Readonly<{
  checkpoint: FilecoinStorageUploadCheckpoint
  createdAtMs: number
  transactionHashes: readonly Hash[]
  updatedAtMs: number
}>

export type FilecoinStorageRecoveryJournal = {
  clear(): Promise<void>
  list(): Promise<readonly FilecoinStorageRecoveryRecord[]>
  markSubmitted(
    checkpoint: FilecoinStorageUploadCheckpoint,
    transactionHash: Hash,
  ): Promise<FilecoinStorageRecoveryRecord>
  remove(uploadId: Hex): Promise<void>
  removeIfUnchanged(record: FilecoinStorageRecoveryRecord): Promise<boolean>
  stage(
    checkpoint: FilecoinStorageUploadCheckpoint,
  ): Promise<FilecoinStorageRecoveryRecord>
  subscribe(listener: () => void): () => void
}

export type FilecoinStorageRecoveryNotifications = {
  publish(databaseName: string): void
  subscribe(databaseName: string, listener: () => void): () => void
}

export type FilecoinStorageRecoveryJournalOptions = {
  databaseName?: string
  factory?: IDBFactory
  notifications?: FilecoinStorageRecoveryNotifications
  now?: () => number
}

type EncodedCheckpoint = {
  account: string
  carByteLength: number
  chainId: string
  ipfsIndexingRequested: true
  mediaCid: string
  piece: {
    bytes: string
    paddedSize: string
    size: number
    text: string
  }
  provider: {
    id: string
    serviceProvider: string
    serviceUrl: string
  }
  uploadId: string
  withCDN: false
}

type EncodedRecoveryRecord = {
  checkpoint: EncodedCheckpoint
  createdAtMs: number
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION
  transactionHashes: string[]
  updatedAtMs: number
}

type StoredRecoveryEnvelope = {
  raw: string
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION
  uploadId: Hex
}

type StoredRecoveryTombstone = {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION
  uploadId: Hex
}

type NativeNotificationHub = {
  channel: BroadcastChannel
  listeners: Set<() => void>
}

const nativeNotificationHubs = new Map<string, NativeNotificationHub>()

export class FilecoinStorageRecoveryJournalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Filecoin storage recovery journal ${message}.`, options)
    this.name = 'FilecoinStorageRecoveryJournalError'
  }
}

function journalError(message: string, cause?: unknown) {
  return new FilecoinStorageRecoveryJournalError(
    message,
    cause === undefined ? undefined : { cause },
  )
}

function asJournalError(value: unknown, fallback: string) {
  if (value instanceof FilecoinStorageRecoveryJournalError) return value
  return journalError(fallback, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort()
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  )
}

function parseUint(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw journalError(`${label} is invalid`)
  }
  const parsed = BigInt(value)
  if (parsed > MAX_EVM_QUANTITY) {
    throw journalError(`${label} is invalid`)
  }
  return parsed
}

function normalizeHash(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw journalError('transaction hash is invalid')
  }
  return value.toLowerCase() as Hash
}

function normalizeUploadId(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw journalError('upload ID is invalid')
  }
  return value.toLowerCase() as Hex
}

function normalizeTimestamp(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw journalError(`${label} is invalid`)
  }
  return value
}

function normalizeCheckpoint(value: FilecoinStorageUploadCheckpoint) {
  if (
    !isRecord(value) ||
    typeof value.account !== 'string' ||
    typeof value.chainId !== 'bigint'
  ) {
    throw journalError('checkpoint is invalid')
  }
  try {
    return normalizeFilecoinStorageUploadCheckpoint(
      value,
      value.account as Address,
      value.chainId,
    )
  } catch (cause) {
    throw journalError('checkpoint is invalid', cause)
  }
}

function encodeCheckpoint(
  checkpoint: FilecoinStorageUploadCheckpoint,
): EncodedCheckpoint {
  return {
    account: checkpoint.account,
    carByteLength: checkpoint.carByteLength,
    chainId: checkpoint.chainId.toString(),
    ipfsIndexingRequested: true,
    mediaCid: checkpoint.mediaCid,
    piece: {
      bytes: checkpoint.piece.bytes,
      paddedSize: checkpoint.piece.paddedSize.toString(),
      size: checkpoint.piece.size,
      text: checkpoint.piece.text,
    },
    provider: {
      id: checkpoint.provider.id.toString(),
      serviceProvider: checkpoint.provider.serviceProvider,
      serviceUrl: checkpoint.provider.serviceUrl,
    },
    uploadId: checkpoint.uploadId,
    withCDN: false,
  }
}

function decodeCheckpoint(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'account',
      'carByteLength',
      'chainId',
      'ipfsIndexingRequested',
      'mediaCid',
      'piece',
      'provider',
      'uploadId',
      'withCDN',
    ]) ||
    !isRecord(value.piece) ||
    !hasExactKeys(value.piece, ['bytes', 'paddedSize', 'size', 'text']) ||
    !isRecord(value.provider) ||
    !hasExactKeys(value.provider, ['id', 'serviceProvider', 'serviceUrl'])
  ) {
    throw journalError('checkpoint encoding is invalid')
  }
  const candidate = {
    account: value.account as Address,
    carByteLength: value.carByteLength as number,
    chainId: parseUint(value.chainId, 'checkpoint chain ID'),
    ipfsIndexingRequested: value.ipfsIndexingRequested as true,
    mediaCid: value.mediaCid as string,
    piece: {
      bytes: value.piece.bytes as Hex,
      paddedSize: parseUint(
        value.piece.paddedSize,
        'checkpoint padded piece size',
      ),
      size: value.piece.size as number,
      text: value.piece.text as string,
    },
    provider: {
      id: parseUint(value.provider.id, 'checkpoint provider ID'),
      serviceProvider: value.provider.serviceProvider as Address,
      serviceUrl: value.provider.serviceUrl as string,
    },
    uploadId: value.uploadId as Hex,
    withCDN: value.withCDN as false,
  } satisfies FilecoinStorageUploadCheckpoint
  const normalized = normalizeCheckpoint(candidate)
  if (JSON.stringify(value) !== JSON.stringify(encodeCheckpoint(normalized))) {
    throw journalError('checkpoint encoding is not canonical')
  }
  return normalized
}

function encodeRecord(record: FilecoinStorageRecoveryRecord) {
  const encoded: EncodedRecoveryRecord = {
    checkpoint: encodeCheckpoint(record.checkpoint),
    createdAtMs: record.createdAtMs,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    transactionHashes: [...record.transactionHashes],
    updatedAtMs: record.updatedAtMs,
  }
  const raw = JSON.stringify(encoded)
  if (raw.length > MAX_RECORD_BYTES) {
    throw journalError('record size is invalid')
  }
  return raw
}

function decodeRecord(raw: string, uploadId: Hex) {
  if (raw.length === 0 || raw.length > MAX_RECORD_BYTES) {
    throw journalError('record size is invalid')
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw journalError('record is not valid JSON', cause)
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'checkpoint',
      'createdAtMs',
      'schemaVersion',
      'transactionHashes',
      'updatedAtMs',
    ]) ||
    value.schemaVersion !== RECOVERY_SCHEMA_VERSION ||
    !Array.isArray(value.transactionHashes) ||
    value.transactionHashes.length > 2
  ) {
    throw journalError('record schema is invalid')
  }
  const checkpoint = decodeCheckpoint(value.checkpoint)
  if (checkpoint.uploadId !== uploadId) {
    throw journalError('record key does not match its upload ID')
  }
  const transactionHashes = value.transactionHashes.map(normalizeHash)
  if (
    new Set(transactionHashes).size !== transactionHashes.length ||
    value.transactionHashes.some(
      (hash, index) => hash !== transactionHashes[index],
    )
  ) {
    throw journalError('transaction hashes are not canonical')
  }
  const createdAtMs = normalizeTimestamp(value.createdAtMs, 'creation time')
  const updatedAtMs = normalizeTimestamp(value.updatedAtMs, 'update time')
  if (updatedAtMs < createdAtMs) {
    throw journalError('update time precedes creation time')
  }
  return Object.freeze({
    checkpoint,
    createdAtMs,
    transactionHashes: Object.freeze(transactionHashes),
    updatedAtMs,
  })
}

function sameCheckpoint(
  first: FilecoinStorageUploadCheckpoint,
  second: FilecoinStorageUploadCheckpoint,
) {
  return (
    JSON.stringify(encodeCheckpoint(first)) ===
    JSON.stringify(encodeCheckpoint(second))
  )
}

function createRecord(
  checkpoint: FilecoinStorageUploadCheckpoint,
  createdAtMs: number,
  updatedAtMs: number,
  transactionHashes: readonly Hash[],
) {
  return Object.freeze({
    checkpoint,
    createdAtMs,
    transactionHashes: Object.freeze([...transactionHashes]),
    updatedAtMs,
  })
}

function normalizeRecord(record: FilecoinStorageRecoveryRecord) {
  try {
    const uploadId = normalizeUploadId(record.checkpoint.uploadId)
    const raw = encodeRecord(record)
    const normalized = decodeRecord(raw, uploadId)
    if (raw !== encodeRecord(normalized)) {
      throw journalError('record is not canonical')
    }
    return normalized
  } catch (cause) {
    throw asJournalError(cause, 'record is invalid')
  }
}

function assertHashCapacity(checkpoint: FilecoinStorageUploadCheckpoint) {
  encodeRecord(
    createRecord(
      checkpoint,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      HASH_CAPACITY_SENTINELS,
    ),
  )
}

function encodeEnvelope(
  record: FilecoinStorageRecoveryRecord,
): StoredRecoveryEnvelope {
  return {
    raw: encodeRecord(record),
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    uploadId: record.checkpoint.uploadId,
  }
}

function decodeEnvelope(value: unknown, expectedUploadId?: Hex) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['raw', 'schemaVersion', 'uploadId']) ||
    value.schemaVersion !== RECOVERY_SCHEMA_VERSION ||
    typeof value.raw !== 'string'
  ) {
    throw journalError('stored envelope is invalid')
  }
  const uploadId = normalizeUploadId(value.uploadId)
  if (value.uploadId !== uploadId) {
    throw journalError('stored envelope key is not canonical')
  }
  if (expectedUploadId !== undefined && uploadId !== expectedUploadId) {
    throw journalError('stored envelope key is invalid')
  }
  return decodeRecord(value.raw, uploadId)
}

function encodeTombstone(uploadId: Hex): StoredRecoveryTombstone {
  return { schemaVersion: RECOVERY_SCHEMA_VERSION, uploadId }
}

function decodeTombstone(value: unknown, expectedUploadId: Hex) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'uploadId']) ||
    value.schemaVersion !== RECOVERY_SCHEMA_VERSION
  ) {
    throw journalError('discard marker is invalid')
  }
  const uploadId = normalizeUploadId(value.uploadId)
  if (value.uploadId !== uploadId || uploadId !== expectedUploadId) {
    throw journalError('discard marker key is invalid')
  }
  return uploadId
}

function currentTime(now: () => number) {
  let value: unknown
  try {
    value = now()
  } catch (cause) {
    throw journalError('clock is unavailable', cause)
  }
  return normalizeTimestamp(value, 'clock value')
}

function recoveryDatabaseName(options: FilecoinStorageRecoveryJournalOptions) {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME
  if (
    typeof databaseName !== 'string' ||
    databaseName.length === 0 ||
    databaseName.length > 128
  ) {
    throw journalError('database name is invalid')
  }
  return databaseName
}

function nativeNotificationHub(databaseName: string) {
  const existing = nativeNotificationHubs.get(databaseName)
  if (existing) return existing
  if (typeof globalThis.BroadcastChannel !== 'function') {
    throw journalError('cross-tab notifications are unavailable')
  }
  let channel: BroadcastChannel
  try {
    channel = new globalThis.BroadcastChannel(
      `${RECOVERY_NOTIFICATION_PREFIX}${databaseName}`,
    )
  } catch (cause) {
    throw journalError('cross-tab notifications are unavailable', cause)
  }
  const hub = { channel, listeners: new Set<() => void>() }
  channel.addEventListener('message', (event) => {
    if (event.data !== RECOVERY_NOTIFICATION_MESSAGE) return
    for (const listener of [...hub.listeners]) {
      try {
        listener()
      } catch {
        // One mounted client cannot prevent the others from invalidating.
      }
    }
  })
  nativeNotificationHubs.set(databaseName, hub)
  return hub
}

const nativeNotifications: FilecoinStorageRecoveryNotifications = {
  publish(databaseName) {
    const hub = nativeNotificationHub(databaseName)
    for (const listener of [...hub.listeners]) {
      try {
        listener()
      } catch {
        // Mutation persistence has already succeeded; notify every listener.
      }
    }
    hub.channel.postMessage(RECOVERY_NOTIFICATION_MESSAGE)
  },
  subscribe(databaseName, listener) {
    const hub = nativeNotificationHub(databaseName)
    hub.listeners.add(listener)
    return () => {
      hub.listeners.delete(listener)
    }
  },
}

function openDatabase(options: FilecoinStorageRecoveryJournalOptions) {
  let factory: IDBFactory | undefined
  try {
    factory = options.factory ?? globalThis.indexedDB
  } catch (cause) {
    throw journalError('is unavailable in this browser', cause)
  }
  const databaseName = recoveryDatabaseName(options)
  if (!factory) throw journalError('is unavailable in this browser')
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(databaseName, RECOVERY_DATABASE_VERSION)
    } catch (cause) {
      reject(journalError('could not open', cause))
      return
    }
    let settled = false
    const fail = (value: unknown, fallback: string) => {
      if (settled) return
      settled = true
      reject(asJournalError(value, fallback))
    }
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort()
        return
      }
      const database = request.result
      if (!database.objectStoreNames.contains(RECOVERY_STORE)) {
        database.createObjectStore(RECOVERY_STORE, { keyPath: 'uploadId' })
      }
      if (!database.objectStoreNames.contains(RECOVERY_TOMBSTONE_STORE)) {
        database.createObjectStore(RECOVERY_TOMBSTONE_STORE, {
          keyPath: 'uploadId',
        })
      }
    }
    request.onerror = () => fail(request.error, 'could not open')
    request.onblocked = () => fail(undefined, 'is blocked by another tab')
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

async function withDatabase<T>(
  options: FilecoinStorageRecoveryJournalOptions,
  operation: (database: IDBDatabase) => Promise<T>,
) {
  const database = await openDatabase(options)
  try {
    return await operation(database)
  } finally {
    database.close()
  }
}

function listRecords(database: IDBDatabase) {
  return new Promise<readonly FilecoinStorageRecoveryRecord[]>(
    (resolve, reject) => {
      const transaction = database.transaction(RECOVERY_STORE, 'readonly')
      const request = transaction
        .objectStore(RECOVERY_STORE)
        .getAll(undefined, MAX_FILECOIN_STORAGE_RECOVERY_RECORDS + 1)
      let values: unknown[] = []
      let requestError: unknown
      request.onsuccess = () => {
        values = request.result as unknown[]
      }
      request.onerror = () => {
        requestError = request.error
      }
      transaction.oncomplete = () => {
        try {
          if (values.length > MAX_FILECOIN_STORAGE_RECOVERY_RECORDS) {
            throw journalError('record limit was exceeded')
          }
          const records = values.map((value) => decodeEnvelope(value))
          records.sort(
            (first, second) =>
              second.updatedAtMs - first.updatedAtMs ||
              first.checkpoint.uploadId.localeCompare(
                second.checkpoint.uploadId,
              ),
          )
          resolve(Object.freeze(records))
        } catch (error) {
          reject(asJournalError(error, 'record validation failed'))
        }
      }
      transaction.onabort = () =>
        reject(
          asJournalError(requestError ?? transaction.error, 'read was aborted'),
        )
      transaction.onerror = () => undefined
    },
  )
}

function mutateRecord(
  database: IDBDatabase,
  checkpoint: FilecoinStorageUploadCheckpoint,
  now: () => number,
  transactionHash?: Hash,
) {
  return new Promise<FilecoinStorageRecoveryRecord>((resolve, reject) => {
    const transaction = database.transaction(
      [RECOVERY_STORE, RECOVERY_TOMBSTONE_STORE],
      'readwrite',
    )
    const store = transaction.objectStore(RECOVERY_STORE)
    const tombstones = transaction.objectStore(RECOVERY_TOMBSTONE_STORE)
    const tombstoneRequest = tombstones.get(checkpoint.uploadId)
    const getRequest = store.get(checkpoint.uploadId)
    let failure: unknown
    let result: FilecoinStorageRecoveryRecord | undefined
    const fail = (error: unknown, fallback: string) => {
      if (failure === undefined) failure = asJournalError(error, fallback)
      try {
        transaction.abort()
      } catch {
        reject(asJournalError(failure, fallback))
      }
    }
    const write = (record: FilecoinStorageRecoveryRecord) => {
      result = record
      try {
        const request = store.put(encodeEnvelope(record))
        request.onerror = () => {
          if (failure === undefined) {
            failure = asJournalError(request.error, 'write failed')
          }
        }
      } catch (error) {
        fail(error, 'write failed')
      }
    }
    const create = () => {
      const time = currentTime(now)
      write(
        createRecord(
          checkpoint,
          time,
          time,
          transactionHash ? [transactionHash] : [],
        ),
      )
    }
    const checkCapacityAndCreate = () => {
      const countRequest = store.count()
      countRequest.onsuccess = () => {
        if (countRequest.result >= MAX_FILECOIN_STORAGE_RECOVERY_RECORDS) {
          fail(journalError('record limit was reached'), 'capacity failed')
          return
        }
        create()
      }
      countRequest.onerror = () => {
        if (failure === undefined) {
          failure = asJournalError(countRequest.error, 'capacity read failed')
        }
      }
    }
    getRequest.onsuccess = () => {
      try {
        if (tombstoneRequest.result !== undefined) {
          decodeTombstone(tombstoneRequest.result, checkpoint.uploadId)
          throw journalError('upload ID was explicitly discarded')
        }
        if (getRequest.result === undefined) {
          checkCapacityAndCreate()
          return
        }
        const existing = decodeEnvelope(getRequest.result, checkpoint.uploadId)
        if (!sameCheckpoint(existing.checkpoint, checkpoint)) {
          throw journalError('upload ID is already bound to another checkpoint')
        }
        if (!transactionHash) {
          result = existing
          return
        }
        const hashes = [...existing.transactionHashes]
        if (!hashes.includes(transactionHash)) hashes.push(transactionHash)
        if (hashes.length > 2) {
          throw journalError('transaction replacement limit was exceeded')
        }
        const time = currentTime(now)
        write(
          createRecord(
            checkpoint,
            existing.createdAtMs,
            Math.max(existing.updatedAtMs, time),
            hashes,
          ),
        )
      } catch (error) {
        fail(error, 'record update failed')
      }
    }
    tombstoneRequest.onerror = () => {
      if (failure === undefined) {
        failure = asJournalError(
          tombstoneRequest.error,
          'discard marker read failed',
        )
      }
    }
    getRequest.onerror = () => {
      if (failure === undefined) {
        failure = asJournalError(getRequest.error, 'record read failed')
      }
    }
    transaction.oncomplete = () => {
      if (result) resolve(result)
      else reject(journalError('record update did not complete'))
    }
    transaction.onabort = () =>
      reject(asJournalError(failure ?? transaction.error, 'write was aborted'))
    transaction.onerror = () => undefined
  })
}

function deleteRecords(
  database: IDBDatabase,
  mode: 'all' | 'one',
  uploadId?: Hex,
) {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      mode === 'all'
        ? [RECOVERY_STORE, RECOVERY_TOMBSTONE_STORE]
        : RECOVERY_STORE,
      'readwrite',
    )
    let failure: unknown
    try {
      const store = transaction.objectStore(RECOVERY_STORE)
      const requests =
        mode === 'all'
          ? [
              store.clear(),
              transaction.objectStore(RECOVERY_TOMBSTONE_STORE).clear(),
            ]
          : [store.delete(uploadId!)]
      for (const request of requests) {
        request.onerror = () => {
          failure = request.error
        }
      }
    } catch (error) {
      failure = error
      transaction.abort()
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(asJournalError(failure ?? transaction.error, 'delete failed'))
    transaction.onerror = () => undefined
  })
}

function deleteRecordIfUnchanged(
  database: IDBDatabase,
  expected: FilecoinStorageRecoveryRecord,
) {
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(
      [RECOVERY_STORE, RECOVERY_TOMBSTONE_STORE],
      'readwrite',
    )
    const store = transaction.objectStore(RECOVERY_STORE)
    const tombstones = transaction.objectStore(RECOVERY_TOMBSTONE_STORE)
    const getRequest = store.get(expected.checkpoint.uploadId)
    let failure: unknown
    let removed: boolean | undefined
    const fail = (error: unknown, fallback: string) => {
      if (failure === undefined) failure = asJournalError(error, fallback)
      try {
        transaction.abort()
      } catch {
        reject(asJournalError(failure, fallback))
      }
    }
    const markDiscarded = () => {
      const request = tombstones.put(
        encodeTombstone(expected.checkpoint.uploadId),
      )
      request.onerror = () => {
        if (failure === undefined) {
          failure = asJournalError(request.error, 'discard marker write failed')
        }
      }
      removed = true
    }
    getRequest.onsuccess = () => {
      try {
        if (getRequest.result === undefined) {
          markDiscarded()
          return
        }
        const current = decodeEnvelope(
          getRequest.result,
          expected.checkpoint.uploadId,
        )
        if (encodeRecord(current) !== encodeRecord(expected)) {
          removed = false
          return
        }
        const deleteRequest = store.delete(expected.checkpoint.uploadId)
        deleteRequest.onsuccess = () => {
          removed = true
        }
        deleteRequest.onerror = () => {
          if (failure === undefined) {
            failure = asJournalError(deleteRequest.error, 'delete failed')
          }
        }
        markDiscarded()
      } catch (error) {
        fail(error, 'conditional delete failed')
      }
    }
    getRequest.onerror = () => {
      if (failure === undefined) {
        failure = asJournalError(getRequest.error, 'record read failed')
      }
    }
    transaction.oncomplete = () => {
      if (removed !== undefined) resolve(removed)
      else reject(journalError('conditional delete did not complete'))
    }
    transaction.onabort = () =>
      reject(asJournalError(failure ?? transaction.error, 'delete was aborted'))
    transaction.onerror = () => undefined
  })
}

export function createFilecoinStorageRecoveryJournal(
  options: FilecoinStorageRecoveryJournalOptions = {},
): FilecoinStorageRecoveryJournal {
  const now = options.now ?? Date.now
  const notifications = options.notifications ?? nativeNotifications
  const notify = () => notifications.publish(recoveryDatabaseName(options))
  return {
    async clear() {
      await withDatabase(options, (database) => deleteRecords(database, 'all'))
      notify()
    },
    async list() {
      return withDatabase(options, listRecords)
    },
    async markSubmitted(checkpoint, transactionHash) {
      const normalized = normalizeCheckpoint(checkpoint)
      const normalizedHash = normalizeHash(transactionHash)
      assertHashCapacity(normalized)
      const record = await withDatabase(options, (database) =>
        mutateRecord(database, normalized, now, normalizedHash),
      )
      notify()
      return record
    },
    async remove(uploadId) {
      const normalized = normalizeUploadId(uploadId)
      await withDatabase(options, (database) =>
        deleteRecords(database, 'one', normalized),
      )
      notify()
    },
    async removeIfUnchanged(record) {
      const normalized = normalizeRecord(record)
      const removed = await withDatabase(options, (database) =>
        deleteRecordIfUnchanged(database, normalized),
      )
      if (removed) notify()
      return removed
    },
    async stage(checkpoint) {
      const normalized = normalizeCheckpoint(checkpoint)
      assertHashCapacity(normalized)
      const record = await withDatabase(options, (database) =>
        mutateRecord(database, normalized, now),
      )
      notify()
      return record
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw journalError('change listener is invalid')
      }
      return notifications.subscribe(recoveryDatabaseName(options), listener)
    },
  }
}
