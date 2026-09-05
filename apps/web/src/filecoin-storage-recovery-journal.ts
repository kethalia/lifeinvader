import { type Address, type Hash, type Hex } from 'viem'
import {
  normalizeFilecoinStorageUploadCheckpoint,
  type FilecoinStorageUploadCheckpoint,
} from './filecoin-storage-upload'

const RECOVERY_KEY_PREFIX = 'lifeinvader:filecoin-storage-recovery:v1:'
const RECOVERY_SCHEMA_VERSION = 1
const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const MAX_RECORD_BYTES = 8_192
const MAX_SCANNED_STORAGE_KEYS = 512

export const MAX_FILECOIN_STORAGE_RECOVERY_RECORDS = 16

export type FilecoinStorageRecoveryRecord = Readonly<{
  checkpoint: FilecoinStorageUploadCheckpoint
  createdAtMs: number
  transactionHashes: readonly Hash[]
  updatedAtMs: number
}>

export type FilecoinStorageRecoveryStorage = Pick<
  Storage,
  'getItem' | 'key' | 'length' | 'removeItem' | 'setItem'
>

export type FilecoinStorageRecoveryJournal = {
  clear(): void
  list(): readonly FilecoinStorageRecoveryRecord[]
  markSubmitted(
    checkpoint: FilecoinStorageUploadCheckpoint,
    transactionHash: Hash,
  ): FilecoinStorageRecoveryRecord
  remove(uploadId: Hex): void
  stage(
    checkpoint: FilecoinStorageUploadCheckpoint,
  ): FilecoinStorageRecoveryRecord
}

export type FilecoinStorageRecoveryJournalOptions = {
  now?: () => number
  storage?: FilecoinStorageRecoveryStorage
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

function recoveryKey(uploadId: Hex) {
  return `${RECOVERY_KEY_PREFIX}${normalizeUploadId(uploadId).slice(2)}`
}

function encodeRecord(record: FilecoinStorageRecoveryRecord) {
  const encoded: EncodedRecoveryRecord = {
    checkpoint: encodeCheckpoint(record.checkpoint),
    createdAtMs: record.createdAtMs,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    transactionHashes: [...record.transactionHashes],
    updatedAtMs: record.updatedAtMs,
  }
  return JSON.stringify(encoded)
}

function decodeRecord(raw: string, key: string) {
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
  if (key !== recoveryKey(checkpoint.uploadId)) {
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

function resolveStorage(storage?: FilecoinStorageRecoveryStorage) {
  if (storage) return storage
  try {
    const browserStorage = globalThis.localStorage
    if (browserStorage) return browserStorage
  } catch (cause) {
    throw journalError('is unavailable in this browser', cause)
  }
  throw journalError('is unavailable in this browser')
}

function storageLength(storage: FilecoinStorageRecoveryStorage) {
  try {
    const length = storage.length
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_SCANNED_STORAGE_KEYS
    ) {
      throw journalError('storage key scan limit was exceeded')
    }
    return length
  } catch (cause) {
    if (cause instanceof FilecoinStorageRecoveryJournalError) throw cause
    throw journalError('could not inspect browser storage', cause)
  }
}

function recoveryKeys(
  storage: FilecoinStorageRecoveryStorage,
  enforceRecordLimit = true,
) {
  const keys: string[] = []
  const length = storageLength(storage)
  try {
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(RECOVERY_KEY_PREFIX)) keys.push(key)
    }
  } catch (cause) {
    throw journalError('could not inspect browser storage', cause)
  }
  if (
    enforceRecordLimit &&
    keys.length > MAX_FILECOIN_STORAGE_RECOVERY_RECORDS
  ) {
    throw journalError('record limit was exceeded')
  }
  return keys.sort()
}

function readStorage(storage: FilecoinStorageRecoveryStorage, key: string) {
  try {
    return storage.getItem(key)
  } catch (cause) {
    throw journalError('could not read browser storage', cause)
  }
}

function writeStorage(
  storage: FilecoinStorageRecoveryStorage,
  key: string,
  record: FilecoinStorageRecoveryRecord,
) {
  const encoded = encodeRecord(record)
  if (encoded.length > MAX_RECORD_BYTES) {
    throw journalError('record size is invalid')
  }
  try {
    storage.setItem(key, encoded)
  } catch (cause) {
    throw journalError('could not write browser storage', cause)
  }
}

function removeStorage(storage: FilecoinStorageRecoveryStorage, key: string) {
  try {
    storage.removeItem(key)
  } catch (cause) {
    throw journalError('could not update browser storage', cause)
  }
}

function readRecords(storage: FilecoinStorageRecoveryStorage) {
  const records: FilecoinStorageRecoveryRecord[] = []
  for (const key of recoveryKeys(storage)) {
    const raw = readStorage(storage, key)
    if (raw !== null) records.push(decodeRecord(raw, key))
  }
  records.sort(
    (first, second) =>
      second.updatedAtMs - first.updatedAtMs ||
      first.checkpoint.uploadId.localeCompare(second.checkpoint.uploadId),
  )
  return Object.freeze(records)
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

export function createFilecoinStorageRecoveryJournal(
  options: FilecoinStorageRecoveryJournalOptions = {},
): FilecoinStorageRecoveryJournal {
  const storage = resolveStorage(options.storage)
  const now = options.now ?? Date.now
  return {
    clear() {
      for (const key of recoveryKeys(storage, false)) {
        removeStorage(storage, key)
      }
    },
    list() {
      return readRecords(storage)
    },
    markSubmitted(checkpoint, transactionHash) {
      const normalized = normalizeCheckpoint(checkpoint)
      const normalizedHash = normalizeHash(transactionHash)
      const key = recoveryKey(normalized.uploadId)
      const records = readRecords(storage)
      const existing = records.find(
        (record) => record.checkpoint.uploadId === normalized.uploadId,
      )
      if (existing && !sameCheckpoint(existing.checkpoint, normalized)) {
        throw journalError('upload ID is already bound to another checkpoint')
      }
      if (
        !existing &&
        records.length >= MAX_FILECOIN_STORAGE_RECOVERY_RECORDS
      ) {
        throw journalError('record limit was reached')
      }
      const hashes = existing ? [...existing.transactionHashes] : []
      if (!hashes.includes(normalizedHash)) hashes.push(normalizedHash)
      if (hashes.length > 2) {
        throw journalError('transaction replacement limit was exceeded')
      }
      const time = currentTime(now)
      const createdAtMs = existing?.createdAtMs ?? time
      const record = createRecord(
        normalized,
        createdAtMs,
        Math.max(createdAtMs, time),
        hashes,
      )
      writeStorage(storage, key, record)
      return record
    },
    remove(uploadId) {
      removeStorage(storage, recoveryKey(uploadId))
    },
    stage(checkpoint) {
      const normalized = normalizeCheckpoint(checkpoint)
      const records = readRecords(storage)
      const existing = records.find(
        (record) => record.checkpoint.uploadId === normalized.uploadId,
      )
      if (existing) {
        if (!sameCheckpoint(existing.checkpoint, normalized)) {
          throw journalError('upload ID is already bound to another checkpoint')
        }
        return existing
      }
      if (records.length >= MAX_FILECOIN_STORAGE_RECOVERY_RECORDS) {
        throw journalError('record limit was reached')
      }
      const time = currentTime(now)
      const record = createRecord(normalized, time, time, [])
      writeStorage(storage, recoveryKey(normalized.uploadId), record)
      return record
    },
  }
}
