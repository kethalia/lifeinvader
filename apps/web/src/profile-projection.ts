import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import {
  eventTransactionsAreConsistent,
  validateIndexedEventLog,
  type EventCheckpoint,
  type IndexedEventLog,
} from './event-indexer'
import { decodeProfileSet, type ProfileSet } from './protocol-events'
import {
  getUtf8ByteLength,
  MAX_MEDIA_CID_BYTES,
  MAX_PROFILE_BIO_BYTES,
  MAX_PROFILE_DISPLAY_NAME_BYTES,
  PROTOCOL_ADDRESS,
} from './protocol'

export const MAX_PROFILE_PROJECTION_ACCOUNTS = 50
export const MAX_PROFILE_PROJECTION_PAGE_LOGS = 5_199
export const PROFILE_PROJECTION_SNAPSHOT_VERSION = 1

const MAX_UINT256 = (1n << 256n) - 1n

export type ProfileProjectionPosition = {
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
}

export type ProfileProjectionSnapshot = {
  accounts: readonly Address[]
  confirmedThrough?: EventCheckpoint
  last?: ProfileProjectionPosition
  profiles: readonly ProfileSet[]
  schemaVersion: typeof PROFILE_PROJECTION_SNAPSHOT_VERSION
}

type DecodedProfilePage = {
  events: readonly ProfileSet[]
  last?: ProfileProjectionPosition
}

function projectionError(message: string) {
  return new Error(`Invalid profile projection ${message}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeAccount(value: unknown) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw projectionError('account')
  }
  return getAddress(value)
}

function compareAccounts(first: Address, second: Address) {
  const normalizedFirst = first.toLowerCase()
  const normalizedSecond = second.toLowerCase()
  if (normalizedFirst === normalizedSecond) return 0
  return normalizedFirst < normalizedSecond ? -1 : 1
}

function normalizeAccounts(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_PROFILE_PROJECTION_ACCOUNTS
  ) {
    throw projectionError('tracked accounts')
  }
  const accounts = new Map<string, Address>()
  for (const accountValue of value) {
    const account = normalizeAccount(accountValue)
    const key = account.toLowerCase()
    if (accounts.has(key)) throw projectionError('duplicate tracked account')
    accounts.set(key, account)
  }
  return [...accounts.values()].toSorted(compareAccounts)
}

function normalizeHash(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw projectionError(label)
  }
  return value.toLowerCase() as Hash
}

function normalizeBlockNumber(value: unknown, label: string) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) {
    throw projectionError(label)
  }
  return value
}

function normalizeIndex(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw projectionError(label)
  }
  return value
}

function normalizePosition(
  value: unknown,
): ProfileProjectionPosition | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw projectionError('snapshot position')
  return {
    blockHash: normalizeHash(value.blockHash, 'snapshot position block hash'),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      'snapshot position block number',
    ),
    logIndex: normalizeIndex(value.logIndex, 'snapshot position log index'),
  }
}

function normalizeCheckpoint(value: unknown): EventCheckpoint | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw projectionError('snapshot confirmation')
  return {
    blockHash: normalizeHash(
      value.blockHash,
      'snapshot confirmation block hash',
    ),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      'snapshot confirmation block number',
    ),
  }
}

function normalizeAvatarCid(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_MEDIA_CID_BYTES * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw projectionError('snapshot avatar CID')
  }
  return value.toLowerCase() as Hex
}

function normalizeProfile(value: unknown): ProfileSet {
  if (!isRecord(value)) throw projectionError('snapshot profile')
  if (
    typeof value.displayName !== 'string' ||
    value.displayName.length > MAX_PROFILE_DISPLAY_NAME_BYTES ||
    getUtf8ByteLength(value.displayName) > MAX_PROFILE_DISPLAY_NAME_BYTES
  ) {
    throw projectionError('snapshot display name')
  }
  if (
    typeof value.bio !== 'string' ||
    value.bio.length > MAX_PROFILE_BIO_BYTES ||
    getUtf8ByteLength(value.bio) > MAX_PROFILE_BIO_BYTES
  ) {
    throw projectionError('snapshot bio')
  }
  return {
    account: normalizeAccount(value.account),
    avatarCid: normalizeAvatarCid(value.avatarCid),
    bio: value.bio,
    blockHash: normalizeHash(value.blockHash, 'snapshot profile block hash'),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      'snapshot profile block number',
    ),
    displayName: value.displayName,
    logIndex: normalizeIndex(value.logIndex, 'snapshot profile log index'),
    transactionHash: normalizeHash(
      value.transactionHash,
      'snapshot profile transaction hash',
    ),
    transactionIndex: normalizeIndex(
      value.transactionIndex,
      'snapshot profile transaction index',
    ),
  }
}

function compareProfiles(first: ProfileSet, second: ProfileSet) {
  return compareAccounts(first.account, second.account)
}

function comparePositions(
  first: { blockNumber: bigint; logIndex?: number },
  second: { blockNumber: bigint; logIndex?: number },
) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  return (
    (first.logIndex ?? Number.MAX_SAFE_INTEGER) -
    (second.logIndex ?? Number.MAX_SAFE_INTEGER)
  )
}

function assertProfileBeforeBoundary(
  profile: ProfileSet,
  last: ProfileProjectionPosition,
) {
  if (
    comparePositions(profile, last) > 0 ||
    (profile.blockNumber === last.blockNumber &&
      profile.blockHash !== last.blockHash)
  ) {
    throw projectionError('snapshot profile boundary')
  }
}

function assertTransactionHashesBelongToOneBlock(
  profiles: readonly ProfileSet[],
  label: string,
) {
  const blocksByTransactionHash = new Map<Hash, bigint>()
  for (const profile of profiles) {
    const transactionBlock = blocksByTransactionHash.get(
      profile.transactionHash,
    )
    if (
      transactionBlock !== undefined &&
      transactionBlock !== profile.blockNumber
    ) {
      throw projectionError(`${label} transaction block`)
    }
    blocksByTransactionHash.set(profile.transactionHash, profile.blockNumber)
  }
}

function assertBlockIdentities(
  fingerprints: readonly { blockHash: Hash; blockNumber: bigint }[],
  label: string,
) {
  const hashesByBlockNumber = new Map<bigint, Hash>()
  const blockNumbersByHash = new Map<Hash, bigint>()
  for (const fingerprint of fingerprints) {
    const knownHash = hashesByBlockNumber.get(fingerprint.blockNumber)
    const knownBlockNumber = blockNumbersByHash.get(fingerprint.blockHash)
    if (
      (knownHash !== undefined && knownHash !== fingerprint.blockHash) ||
      (knownBlockNumber !== undefined &&
        knownBlockNumber !== fingerprint.blockNumber)
    ) {
      throw projectionError(`${label} block identity`)
    }
    hashesByBlockNumber.set(fingerprint.blockNumber, fingerprint.blockHash)
    blockNumbersByHash.set(fingerprint.blockHash, fingerprint.blockNumber)
  }
}

function assertConsistentProfileMetadata(
  profiles: readonly ProfileSet[],
  label: string,
) {
  const blockHashes = new Map<bigint, Hash>()
  const positions = new Set<string>()
  const ordered = profiles.toSorted((first, second) =>
    comparePositions(first, second),
  )
  for (const profile of ordered) {
    const position = `${profile.blockNumber.toString()}:${profile.logIndex.toString()}`
    if (positions.has(position)) {
      throw projectionError(`${label} duplicate log position`)
    }
    positions.add(position)
    const knownHash = blockHashes.get(profile.blockNumber)
    if (knownHash !== undefined && knownHash !== profile.blockHash) {
      throw projectionError(`${label} profile block hash`)
    }
    blockHashes.set(profile.blockNumber, profile.blockHash)
  }
  assertTransactionHashesBelongToOneBlock(ordered, label)
  const logs = ordered.map((profile): IndexedEventLog => ({
    address: PROTOCOL_ADDRESS,
    blockHash: profile.blockHash,
    blockNumber: profile.blockNumber,
    data: '0x',
    logIndex: profile.logIndex,
    topics: [],
    transactionHash: profile.transactionHash,
    transactionIndex: profile.transactionIndex,
  }))
  if (!eventTransactionsAreConsistent(logs)) {
    throw projectionError(`${label} transaction metadata`)
  }
}

function assertCheckpointMatchesProfiles(
  checkpoint: EventCheckpoint,
  profiles: Iterable<ProfileSet>,
) {
  for (const profile of profiles) {
    if (
      profile.blockNumber === checkpoint.blockNumber &&
      profile.blockHash !== checkpoint.blockHash
    ) {
      throw projectionError('snapshot confirmation profile block hash')
    }
  }
}

function normalizeSnapshot(value: unknown): ProfileProjectionSnapshot {
  if (!isRecord(value)) throw projectionError('snapshot')
  if (value.schemaVersion !== PROFILE_PROJECTION_SNAPSHOT_VERSION) {
    throw projectionError('snapshot schema version')
  }
  const accounts = normalizeAccounts(value.accounts)
  if (!Array.isArray(value.profiles)) {
    throw projectionError('snapshot profiles')
  }
  if (value.profiles.length > accounts.length) {
    throw projectionError('snapshot profile count')
  }
  const tracked = new Set(accounts.map((account) => account.toLowerCase()))
  const profiles = new Map<string, ProfileSet>()
  for (const profileValue of value.profiles) {
    const profile = normalizeProfile(profileValue)
    const key = profile.account.toLowerCase()
    if (!tracked.has(key)) throw projectionError('snapshot untracked profile')
    if (profiles.has(key)) throw projectionError('snapshot duplicate profile')
    profiles.set(key, profile)
  }
  const last = normalizePosition(value.last)
  const confirmedThrough = normalizeCheckpoint(value.confirmedThrough)
  if (profiles.size > 0 && !last) {
    throw projectionError('snapshot profile progress')
  }
  if (last && confirmedThrough) {
    if (
      last.blockNumber === confirmedThrough.blockNumber &&
      last.blockHash !== confirmedThrough.blockHash
    ) {
      throw projectionError('snapshot confirmation progress')
    }
  }
  if (last) {
    for (const profile of profiles.values()) {
      assertProfileBeforeBoundary(profile, last)
    }
  }
  if (confirmedThrough) {
    assertCheckpointMatchesProfiles(confirmedThrough, profiles.values())
  }
  assertConsistentProfileMetadata([...profiles.values()], 'snapshot')
  assertBlockIdentities(
    [
      ...profiles.values(),
      ...(last ? [last] : []),
      ...(confirmedThrough ? [confirmedThrough] : []),
    ],
    'snapshot',
  )
  return {
    accounts,
    ...(confirmedThrough ? { confirmedThrough } : {}),
    ...(last ? { last } : {}),
    profiles: [...profiles.values()].toSorted(compareProfiles),
    schemaVersion: PROFILE_PROJECTION_SNAPSHOT_VERSION,
  }
}

function serializeSnapshot(value: unknown) {
  const snapshot = normalizeSnapshot(value)
  return JSON.stringify([
    'lifeinvader.profile-projection.snapshot.v1',
    snapshot.accounts.map((account) => account.toLowerCase()),
    snapshot.confirmedThrough
      ? [
          snapshot.confirmedThrough.blockNumber.toString(16),
          snapshot.confirmedThrough.blockHash,
        ]
      : null,
    snapshot.last
      ? [
          snapshot.last.blockNumber.toString(16),
          snapshot.last.logIndex.toString(16),
          snapshot.last.blockHash,
        ]
      : null,
    snapshot.profiles.map((profile) => [
      profile.account.toLowerCase(),
      profile.displayName,
      profile.bio,
      profile.avatarCid,
      profile.blockNumber.toString(16),
      profile.blockHash,
      profile.logIndex.toString(16),
      profile.transactionHash,
      profile.transactionIndex.toString(16),
    ]),
  ])
}

export function getProfileProjectionSnapshotDigest(value: unknown) {
  return keccak256(stringToHex(serializeSnapshot(value)))
}

function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  return first.logIndex - second.logIndex
}

function getPosition(log: IndexedEventLog): ProfileProjectionPosition {
  return {
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  }
}

function decodePage(
  value: unknown,
  previous: { blockNumber: bigint } | undefined,
): DecodedProfilePage {
  if (!Array.isArray(value)) throw projectionError('page')
  if (value.length > MAX_PROFILE_PROJECTION_PAGE_LOGS) {
    throw projectionError('page size')
  }
  const logs = value.map((entry) => {
    try {
      return validateIndexedEventLog(entry)
    } catch {
      throw projectionError('log')
    }
  })
  const blockHashes = new Map<bigint, Hash>()
  for (let index = 0; index < logs.length; index += 1) {
    const log = logs[index]!
    if (index > 0 && compareLogs(logs[index - 1]!, log) >= 0) {
      throw projectionError('page order')
    }
    const knownHash = blockHashes.get(log.blockNumber)
    if (knownHash !== undefined && knownHash !== log.blockHash) {
      throw projectionError('page block hash')
    }
    blockHashes.set(log.blockNumber, log.blockHash)
  }
  const first = logs[0]
  if (first && previous && first.blockNumber <= previous.blockNumber) {
    throw projectionError('page boundary')
  }
  if (!eventTransactionsAreConsistent(logs)) {
    throw projectionError('transaction metadata')
  }
  const events = logs.map((log) => {
    try {
      const profile = decodeProfileSet(log)
      if (!profile) throw projectionError('event family')
      return profile
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid profile projection ')
      ) {
        throw error
      }
      throw projectionError('event')
    }
  })
  assertTransactionHashesBelongToOneBlock(events, 'page')
  assertBlockIdentities(events, 'page')
  return {
    events,
    last: logs.length > 0 ? getPosition(logs.at(-1)!) : undefined,
  }
}

function copyPosition(position: ProfileProjectionPosition) {
  return { ...position }
}

function copyCheckpoint(checkpoint: EventCheckpoint) {
  return { ...checkpoint }
}

function copyProfile(profile: ProfileSet) {
  return { ...profile }
}

function getBoundary(
  last: ProfileProjectionPosition | undefined,
  confirmedThrough: EventCheckpoint | undefined,
) {
  if (!confirmedThrough) return last
  if (!last || confirmedThrough.blockNumber >= last.blockNumber) {
    return confirmedThrough
  }
  return last
}

export class ProfileProjection {
  readonly #accounts: readonly Address[]
  readonly #profiles = new Map<string, ProfileSet>()
  readonly #tracked = new Set<string>()
  #confirmedThrough?: EventCheckpoint
  #last?: ProfileProjectionPosition

  constructor(accountsValue: unknown) {
    this.#accounts = normalizeAccounts(accountsValue)
    for (const account of this.#accounts) {
      this.#tracked.add(account.toLowerCase())
    }
  }

  static fromSnapshot(value: unknown) {
    const snapshot = normalizeSnapshot(value)
    const projection = new ProfileProjection(snapshot.accounts)
    for (const profile of snapshot.profiles) {
      projection.#profiles.set(
        profile.account.toLowerCase(),
        copyProfile(profile),
      )
    }
    projection.#confirmedThrough = snapshot.confirmedThrough
      ? copyCheckpoint(snapshot.confirmedThrough)
      : undefined
    projection.#last = snapshot.last ? copyPosition(snapshot.last) : undefined
    return projection
  }

  get confirmedThrough() {
    return this.#confirmedThrough
      ? copyCheckpoint(this.#confirmedThrough)
      : undefined
  }

  get progress() {
    return this.#last ? copyPosition(this.#last) : undefined
  }

  get snapshot(): ProfileProjectionSnapshot {
    return {
      accounts: [...this.#accounts],
      ...(this.#confirmedThrough
        ? { confirmedThrough: copyCheckpoint(this.#confirmedThrough) }
        : {}),
      ...(this.#last ? { last: copyPosition(this.#last) } : {}),
      profiles: [...this.#profiles.values()]
        .map(copyProfile)
        .toSorted(compareProfiles),
      schemaVersion: PROFILE_PROJECTION_SNAPSHOT_VERSION,
    }
  }

  get trackedAccounts() {
    return [...this.#accounts]
  }

  applyLogs(value: unknown) {
    const page = decodePage(
      value,
      getBoundary(this.#last, this.#confirmedThrough),
    )
    const updates = new Map<string, ProfileSet>()
    for (const profile of page.events) {
      const key = profile.account.toLowerCase()
      if (this.#tracked.has(key)) updates.set(key, profile)
    }
    const retainedProfiles = new Map(this.#profiles)
    for (const [key, profile] of updates) retainedProfiles.set(key, profile)
    assertConsistentProfileMetadata([...retainedProfiles.values()], 'retained')
    const nextLast = page.last ?? this.#last
    assertBlockIdentities(
      [
        ...retainedProfiles.values(),
        ...(nextLast ? [nextLast] : []),
        ...(this.#confirmedThrough ? [this.#confirmedThrough] : []),
      ],
      'retained',
    )
    for (const [key, profile] of updates) {
      this.#profiles.set(key, copyProfile(profile))
    }
    if (page.last) this.#last = page.last
  }

  confirmThrough(value: unknown) {
    const checkpoint = normalizeCheckpoint(value)
    if (!checkpoint) throw projectionError('confirmation')
    if (
      this.#confirmedThrough &&
      (checkpoint.blockNumber < this.#confirmedThrough.blockNumber ||
        (checkpoint.blockNumber === this.#confirmedThrough.blockNumber &&
          checkpoint.blockHash !== this.#confirmedThrough.blockHash))
    ) {
      throw projectionError('confirmation boundary')
    }
    if (
      this.#last &&
      (this.#last.blockNumber > checkpoint.blockNumber ||
        (this.#last.blockNumber === checkpoint.blockNumber &&
          this.#last.blockHash !== checkpoint.blockHash))
    ) {
      throw projectionError('confirmation progress')
    }
    assertBlockIdentities(
      [
        ...this.#profiles.values(),
        ...(this.#last ? [this.#last] : []),
        checkpoint,
      ],
      'confirmation',
    )
    this.#confirmedThrough = checkpoint
  }

  getProfile(accountValue: unknown) {
    const account = normalizeAccount(accountValue)
    const key = account.toLowerCase()
    if (!this.#tracked.has(key)) throw projectionError('untracked account')
    const profile = this.#profiles.get(key)
    return profile ? copyProfile(profile) : undefined
  }

  reset() {
    this.#profiles.clear()
    this.#confirmedThrough = undefined
    this.#last = undefined
  }
}
