import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
} from 'viem'
import {
  eventTransactionsAreConsistent,
  validateIndexedEventLog,
  type EventCheckpoint,
  type IndexedEventLog,
} from './event-indexer'
import {
  decodeGroupMembershipSet,
  type GroupMembershipSet,
} from './protocol-events'
import { PROTOCOL_ADDRESS } from './protocol'

export const GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE = 50
export const MAX_GROUP_MEMBERSHIP_PROJECTION_PAGE_LOGS = 5_199
export const MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE = 200
export const GROUP_MEMBERSHIP_PROJECTION_SNAPSHOT_VERSION = 1

const MAX_UINT256 = (1n << 256n) - 1n
const ADDRESS_HEX_LENGTH = 40
const HEX_DIGITS = '0123456789abcdef'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type GroupMembershipProjectionPosition = {
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
}

export type GroupMembershipProjectionProgress = {
  confirmedThrough?: EventCheckpoint
  last?: GroupMembershipProjectionPosition
  memberCount: bigint
  signalCount: bigint
}

export type GroupMembershipProjectionReadOptions = {
  after?: Address
  limit?: number
}

export type GroupMembershipProjectionReadPage = {
  complete: boolean
  members: readonly GroupMembershipSet[]
  nextAfter?: Address
  totalMembers: bigint
}

export type GroupMembershipProjectionSnapshot = {
  confirmedThrough?: EventCheckpoint
  groupId: bigint
  last?: GroupMembershipProjectionPosition
  members: readonly GroupMembershipSet[]
  schemaVersion: typeof GROUP_MEMBERSHIP_PROJECTION_SNAPSHOT_VERSION
  signalCount: bigint
}

type DecodedMembershipPage = {
  events: readonly GroupMembershipSet[]
  last?: GroupMembershipProjectionPosition
}

type RetainedIdentity = {
  blockNumber: bigint
  references: number
}

type AddressIndexNode = {
  children: Map<string, AddressIndexNode>
  memberKey?: string
}

function projectionError(message: string) {
  return new Error(`Invalid group membership projection ${message}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeGroupId(value: unknown) {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_UINT256) {
    throw projectionError('group identifier')
  }
  return value
}

function normalizeQuantity(value: unknown, label: string) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) {
    throw projectionError(label)
  }
  return value
}

function normalizeAccount(value: unknown) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw projectionError('account')
  }
  const account = getAddress(value)
  if (account.toLowerCase() === ZERO_ADDRESS) {
    throw projectionError('account')
  }
  return account
}

function normalizeHash(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw projectionError(label)
  }
  return value.toLowerCase() as Hash
}

function normalizeBlockNumber(value: unknown, label: string) {
  return normalizeQuantity(value, label)
}

function normalizeIndex(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw projectionError(label)
  }
  return value
}

function normalizePosition(
  value: unknown,
): GroupMembershipProjectionPosition | undefined {
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

function normalizeMember(value: unknown): GroupMembershipSet {
  if (!isRecord(value)) throw projectionError('snapshot member')
  if (value.joined !== true) throw projectionError('snapshot member state')
  return {
    account: normalizeAccount(value.account),
    blockHash: normalizeHash(value.blockHash, 'snapshot member block hash'),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      'snapshot member block number',
    ),
    groupId: normalizeGroupId(value.groupId),
    joined: true,
    logIndex: normalizeIndex(value.logIndex, 'snapshot member log index'),
    transactionHash: normalizeHash(
      value.transactionHash,
      'snapshot member transaction hash',
    ),
    transactionIndex: normalizeIndex(
      value.transactionIndex,
      'snapshot member transaction index',
    ),
  }
}

function compareAccounts(first: Address, second: Address) {
  const normalizedFirst = first.toLowerCase()
  const normalizedSecond = second.toLowerCase()
  if (normalizedFirst === normalizedSecond) return 0
  return normalizedFirst < normalizedSecond ? -1 : 1
}

function compareMembers(first: GroupMembershipSet, second: GroupMembershipSet) {
  return compareAccounts(first.account, second.account)
}

function createAddressIndexNode(): AddressIndexNode {
  return { children: new Map() }
}

function getAddressHex(account: Address) {
  return account.toLowerCase().slice(2)
}

function findFirstIndexedMember(node: AddressIndexNode) {
  let current = node
  for (let depth = 0; !current.memberKey; depth += 1) {
    if (depth >= ADDRESS_HEX_LENGTH) {
      throw projectionError('internal member index')
    }
    let child: AddressIndexNode | undefined
    for (const digit of HEX_DIGITS) {
      child = current.children.get(digit)
      if (child) break
    }
    if (!child) throw projectionError('internal member index')
    current = child
  }
  return current.memberKey
}

function findNextIndexedMember(root: AddressIndexNode, account: Address) {
  const addressHex = getAddressHex(account)
  const path = [root]
  let current = root
  for (const digit of addressHex) {
    const child = current.children.get(digit)
    if (!child) throw projectionError('read cursor')
    path.push(child)
    current = child
  }
  if (!current.memberKey) throw projectionError('read cursor')
  for (let depth = ADDRESS_HEX_LENGTH - 1; depth >= 0; depth -= 1) {
    const parent = path[depth]!
    const digitIndex = HEX_DIGITS.indexOf(addressHex[depth]!)
    for (let nextIndex = digitIndex + 1; nextIndex < 16; nextIndex += 1) {
      const sibling = parent.children.get(HEX_DIGITS[nextIndex]!)
      if (sibling) return findFirstIndexedMember(sibling)
    }
  }
  return undefined
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

function assertMemberBeforeBoundary(
  member: GroupMembershipSet,
  last: GroupMembershipProjectionPosition,
) {
  if (
    comparePositions(member, last) > 0 ||
    (member.blockNumber === last.blockNumber &&
      member.blockHash !== last.blockHash)
  ) {
    throw projectionError('snapshot member boundary')
  }
}

function assertTransactionHashesBelongToOneBlock(
  events: readonly GroupMembershipSet[],
  label: string,
) {
  const blocksByTransactionHash = new Map<Hash, bigint>()
  for (const event of events) {
    const transactionBlock = blocksByTransactionHash.get(event.transactionHash)
    if (
      transactionBlock !== undefined &&
      transactionBlock !== event.blockNumber
    ) {
      throw projectionError(`${label} transaction block`)
    }
    blocksByTransactionHash.set(event.transactionHash, event.blockNumber)
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

function assertConsistentMembershipMetadata(
  events: readonly GroupMembershipSet[],
  label: string,
) {
  const blockHashes = new Map<bigint, Hash>()
  const positions = new Set<string>()
  const ordered = events.toSorted((first, second) =>
    comparePositions(first, second),
  )
  for (const event of ordered) {
    const position = `${event.blockNumber.toString()}:${event.logIndex.toString()}`
    if (positions.has(position)) {
      throw projectionError(`${label} duplicate log position`)
    }
    positions.add(position)
    const knownHash = blockHashes.get(event.blockNumber)
    if (knownHash !== undefined && knownHash !== event.blockHash) {
      throw projectionError(`${label} member block hash`)
    }
    blockHashes.set(event.blockNumber, event.blockHash)
  }
  assertTransactionHashesBelongToOneBlock(ordered, label)
  const logs = ordered.map((event): IndexedEventLog => ({
    address: PROTOCOL_ADDRESS,
    blockHash: event.blockHash,
    blockNumber: event.blockNumber,
    data: '0x',
    logIndex: event.logIndex,
    topics: [],
    transactionHash: event.transactionHash,
    transactionIndex: event.transactionIndex,
  }))
  if (!eventTransactionsAreConsistent(logs)) {
    throw projectionError(`${label} transaction metadata`)
  }
}

function normalizeSnapshot(value: unknown): GroupMembershipProjectionSnapshot {
  if (!isRecord(value)) throw projectionError('snapshot')
  if (value.schemaVersion !== GROUP_MEMBERSHIP_PROJECTION_SNAPSHOT_VERSION) {
    throw projectionError('snapshot schema version')
  }
  const groupId = normalizeGroupId(value.groupId)
  const signalCount = normalizeQuantity(
    value.signalCount,
    'snapshot signal count',
  )
  if (!Array.isArray(value.members)) {
    throw projectionError('snapshot members')
  }
  if (BigInt(value.members.length) > signalCount) {
    throw projectionError('snapshot member count')
  }
  const members = new Map<string, GroupMembershipSet>()
  for (const memberValue of value.members) {
    const member = normalizeMember(memberValue)
    if (member.groupId !== groupId) {
      throw projectionError('snapshot member group')
    }
    const key = member.account.toLowerCase()
    if (members.has(key)) throw projectionError('snapshot duplicate member')
    members.set(key, member)
  }
  const last = normalizePosition(value.last)
  const confirmedThrough = normalizeCheckpoint(value.confirmedThrough)
  if ((signalCount === 0n) !== (last === undefined)) {
    throw projectionError('snapshot signal progress')
  }
  if (last) {
    for (const member of members.values()) {
      assertMemberBeforeBoundary(member, last)
    }
  }
  if (
    last &&
    confirmedThrough &&
    last.blockNumber === confirmedThrough.blockNumber &&
    last.blockHash !== confirmedThrough.blockHash
  ) {
    throw projectionError('snapshot confirmation progress')
  }
  assertConsistentMembershipMetadata([...members.values()], 'snapshot')
  assertBlockIdentities(
    [
      ...members.values(),
      ...(last ? [last] : []),
      ...(confirmedThrough ? [confirmedThrough] : []),
    ],
    'snapshot',
  )
  return {
    ...(confirmedThrough ? { confirmedThrough } : {}),
    groupId,
    ...(last ? { last } : {}),
    members: [...members.values()].toSorted(compareMembers),
    schemaVersion: GROUP_MEMBERSHIP_PROJECTION_SNAPSHOT_VERSION,
    signalCount,
  }
}

function serializeSnapshot(value: unknown) {
  const snapshot = normalizeSnapshot(value)
  return JSON.stringify([
    'lifeinvader.group-membership-projection.snapshot.v1',
    snapshot.groupId.toString(16),
    snapshot.signalCount.toString(16),
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
    snapshot.members.map((member) => [
      member.account.toLowerCase(),
      member.blockNumber.toString(16),
      member.blockHash,
      member.logIndex.toString(16),
      member.transactionHash,
      member.transactionIndex.toString(16),
    ]),
  ])
}

export function getGroupMembershipProjectionSnapshotDigest(value: unknown) {
  return keccak256(stringToHex(serializeSnapshot(value)))
}

function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  return first.logIndex - second.logIndex
}

function getPosition(log: IndexedEventLog): GroupMembershipProjectionPosition {
  return {
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  }
}

function decodePage(
  value: unknown,
  previous: { blockNumber: bigint } | undefined,
  groupId: bigint,
): DecodedMembershipPage {
  if (!Array.isArray(value)) throw projectionError('page')
  if (value.length > MAX_GROUP_MEMBERSHIP_PROJECTION_PAGE_LOGS) {
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
      const event = decodeGroupMembershipSet(log)
      if (!event) throw projectionError('event family')
      if (event.groupId !== groupId) throw projectionError('event group')
      return event
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid group membership projection ')
      ) {
        throw error
      }
      throw projectionError('event')
    }
  })
  assertConsistentMembershipMetadata(events, 'page')
  assertBlockIdentities(events, 'page')
  return {
    events,
    last: logs.length > 0 ? getPosition(logs.at(-1)!) : undefined,
  }
}

function copyPosition(position: GroupMembershipProjectionPosition) {
  return { ...position }
}

function copyCheckpoint(checkpoint: EventCheckpoint) {
  return { ...checkpoint }
}

function copyMember(member: GroupMembershipSet) {
  return { ...member }
}

function getBoundary(
  last: GroupMembershipProjectionPosition | undefined,
  confirmedThrough: EventCheckpoint | undefined,
) {
  if (!confirmedThrough) return last
  if (!last || confirmedThrough.blockNumber >= last.blockNumber) {
    return confirmedThrough
  }
  return last
}

function retainIdentity(
  identities: Map<Hash, RetainedIdentity>,
  hash: Hash,
  blockNumber: bigint,
) {
  const retained = identities.get(hash)
  if (retained) {
    if (retained.blockNumber !== blockNumber) {
      throw projectionError('internal retained identity')
    }
    retained.references += 1
    return
  }
  identities.set(hash, { blockNumber, references: 1 })
}

function releaseIdentity(identities: Map<Hash, RetainedIdentity>, hash: Hash) {
  const retained = identities.get(hash)
  if (!retained) throw projectionError('internal retained identity')
  if (retained.references === 1) identities.delete(hash)
  else retained.references -= 1
}

function normalizeReadOptions(value: unknown) {
  if (!isRecord(value)) throw projectionError('read options')
  const options = value as GroupMembershipProjectionReadOptions
  const limit = options.limit ?? GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE
  ) {
    throw projectionError('read limit')
  }
  const after =
    options.after === undefined ? undefined : normalizeAccount(options.after)
  return { after, limit }
}

export class GroupMembershipProjection {
  readonly #addressIndex = createAddressIndexNode()
  readonly #memberBlocksByHash = new Map<Hash, RetainedIdentity>()
  readonly #groupId: bigint
  readonly #members = new Map<string, GroupMembershipSet>()
  readonly #memberTransactionsByHash = new Map<Hash, RetainedIdentity>()
  #confirmedThrough?: EventCheckpoint
  #last?: GroupMembershipProjectionPosition
  #signalCount = 0n

  constructor(groupIdValue: unknown) {
    this.#groupId = normalizeGroupId(groupIdValue)
  }

  static fromSnapshot(value: unknown) {
    const snapshot = normalizeSnapshot(value)
    const projection = new GroupMembershipProjection(snapshot.groupId)
    for (const member of snapshot.members) {
      projection.#retainMember(member)
    }
    projection.#confirmedThrough = snapshot.confirmedThrough
      ? copyCheckpoint(snapshot.confirmedThrough)
      : undefined
    projection.#last = snapshot.last ? copyPosition(snapshot.last) : undefined
    projection.#signalCount = snapshot.signalCount
    return projection
  }

  get groupId() {
    return this.#groupId
  }

  get progress(): GroupMembershipProjectionProgress {
    return {
      ...(this.#confirmedThrough
        ? { confirmedThrough: copyCheckpoint(this.#confirmedThrough) }
        : {}),
      ...(this.#last ? { last: copyPosition(this.#last) } : {}),
      memberCount: BigInt(this.#members.size),
      signalCount: this.#signalCount,
    }
  }

  get snapshot(): GroupMembershipProjectionSnapshot {
    return {
      ...(this.#confirmedThrough
        ? { confirmedThrough: copyCheckpoint(this.#confirmedThrough) }
        : {}),
      groupId: this.#groupId,
      ...(this.#last ? { last: copyPosition(this.#last) } : {}),
      members: [...this.#members.values()]
        .map(copyMember)
        .toSorted(compareMembers),
      schemaVersion: GROUP_MEMBERSHIP_PROJECTION_SNAPSHOT_VERSION,
      signalCount: this.#signalCount,
    }
  }

  applyLogs(value: unknown) {
    const page = decodePage(
      value,
      getBoundary(this.#last, this.#confirmedThrough),
      this.#groupId,
    )
    const nextSignalCount = this.#signalCount + BigInt(page.events.length)
    if (nextSignalCount > MAX_UINT256) {
      throw projectionError('signal count')
    }
    this.#assertCompatiblePage(page.events)
    for (const event of page.events) {
      this.#releaseMember(event.account)
      if (event.joined) this.#retainMember(event)
    }
    this.#signalCount = nextSignalCount
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
    const retainedBlock = this.#memberBlocksByHash.get(checkpoint.blockHash)
    if (retainedBlock && retainedBlock.blockNumber !== checkpoint.blockNumber) {
      throw projectionError('confirmation block identity')
    }
    this.#confirmedThrough = checkpoint
  }

  getMember(accountValue: unknown) {
    const account = normalizeAccount(accountValue)
    const member = this.#members.get(account.toLowerCase())
    return member ? copyMember(member) : undefined
  }

  isMember(accountValue: unknown) {
    const account = normalizeAccount(accountValue)
    return this.#members.has(account.toLowerCase())
  }

  readMembers(
    optionsValue: GroupMembershipProjectionReadOptions = {},
  ): GroupMembershipProjectionReadPage {
    const { after, limit } = normalizeReadOptions(optionsValue)
    if (after && !this.#members.has(after.toLowerCase())) {
      throw projectionError('read cursor')
    }
    let memberKey = after
      ? findNextIndexedMember(this.#addressIndex, after)
      : this.#members.size > 0
        ? findFirstIndexedMember(this.#addressIndex)
        : undefined
    const members: GroupMembershipSet[] = []
    let last: GroupMembershipSet | undefined
    while (memberKey && members.length < limit) {
      const member = this.#members.get(memberKey)
      if (!member) throw projectionError('internal member index')
      last = member
      members.push(copyMember(member))
      memberKey = findNextIndexedMember(this.#addressIndex, member.account)
    }
    const complete = memberKey === undefined
    return {
      complete,
      members,
      nextAfter: complete ? undefined : last?.account,
      totalMembers: BigInt(this.#members.size),
    }
  }

  reset() {
    this.#addressIndex.children.clear()
    this.#addressIndex.memberKey = undefined
    this.#memberBlocksByHash.clear()
    this.#members.clear()
    this.#memberTransactionsByHash.clear()
    this.#confirmedThrough = undefined
    this.#last = undefined
    this.#signalCount = 0n
  }

  #assertCompatiblePage(events: readonly GroupMembershipSet[]) {
    for (const event of events) {
      const retainedBlock = this.#memberBlocksByHash.get(event.blockHash)
      if (retainedBlock && retainedBlock.blockNumber !== event.blockNumber) {
        throw projectionError('history block identity')
      }
      const retainedTransaction = this.#memberTransactionsByHash.get(
        event.transactionHash,
      )
      if (
        retainedTransaction &&
        retainedTransaction.blockNumber !== event.blockNumber
      ) {
        throw projectionError('history transaction block')
      }
      for (const boundary of [this.#last, this.#confirmedThrough]) {
        if (
          boundary &&
          boundary.blockHash === event.blockHash &&
          boundary.blockNumber !== event.blockNumber
        ) {
          throw projectionError('history block identity')
        }
      }
    }
  }

  #releaseMember(account: Address) {
    const key = account.toLowerCase()
    const member = this.#members.get(key)
    if (!member) return
    this.#members.delete(key)
    const addressHex = getAddressHex(member.account)
    const path = [this.#addressIndex]
    let node = this.#addressIndex
    for (const digit of addressHex) {
      const child = node.children.get(digit)
      if (!child) throw projectionError('internal member index')
      path.push(child)
      node = child
    }
    if (node.memberKey !== key) throw projectionError('internal member index')
    node.memberKey = undefined
    for (let depth = ADDRESS_HEX_LENGTH - 1; depth >= 0; depth -= 1) {
      const child = path[depth + 1]!
      if (child.memberKey || child.children.size > 0) break
      path[depth]!.children.delete(addressHex[depth]!)
    }
    releaseIdentity(this.#memberBlocksByHash, member.blockHash)
    releaseIdentity(this.#memberTransactionsByHash, member.transactionHash)
  }

  #retainMember(value: GroupMembershipSet) {
    const member = copyMember(value)
    const key = member.account.toLowerCase()
    this.#members.set(key, member)
    let node = this.#addressIndex
    for (const digit of getAddressHex(member.account)) {
      let child = node.children.get(digit)
      if (!child) {
        child = createAddressIndexNode()
        node.children.set(digit, child)
      }
      node = child
    }
    if (node.memberKey) throw projectionError('internal member index')
    node.memberKey = key
    retainIdentity(
      this.#memberBlocksByHash,
      member.blockHash,
      member.blockNumber,
    )
    retainIdentity(
      this.#memberTransactionsByHash,
      member.transactionHash,
      member.blockNumber,
    )
  }
}
