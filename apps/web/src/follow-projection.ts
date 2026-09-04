import { getAddress, isAddress, type Address, type Hash } from 'viem'
import {
  eventTransactionsAreConsistent,
  validateIndexedEventLog,
  type EventCheckpoint,
  type IndexedEventLog,
} from './event-indexer'
import { decodeFollowSet, type FollowSet } from './protocol-events'
import { PROTOCOL_ADDRESS } from './protocol'

export const FOLLOW_PROJECTION_READ_PAGE_SIZE = 50
export const MAX_FOLLOW_PROJECTION_PAGE_LOGS = 5_199
export const MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE = 200

export type FollowDirection = 'followers' | 'following'

const MAX_UINT256 = (1n << 256n) - 1n
const ADDRESS_HEX_LENGTH = 40
const HEX_DIGITS = '0123456789abcdef'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type FollowProjectionPosition = {
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
}

export type FollowProjectionProgress = {
  confirmedThrough?: EventCheckpoint
  last?: FollowProjectionPosition
  relationshipCount: bigint
  signalCount: bigint
}

export type FollowProjectionReadOptions = {
  after?: Address
  limit?: number
}

export type FollowProjectionReadPage = {
  complete: boolean
  relationships: readonly FollowSet[]
  nextAfter?: Address
  totalRelationships: bigint
}

type DecodedFollowPage = {
  events: readonly FollowSet[]
  last?: FollowProjectionPosition
}

type RetainedIdentity = {
  blockNumber: bigint
  references: number
}

type AddressIndexNode = {
  children: Map<string, AddressIndexNode>
  relationshipKey?: string
}

function projectionError(message: string) {
  return new Error(`Invalid follow projection ${message}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeDirection(value: unknown): FollowDirection {
  if (value !== 'followers' && value !== 'following') {
    throw projectionError('direction')
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

function normalizeCheckpoint(value: unknown): EventCheckpoint | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw projectionError('confirmation')
  return {
    blockHash: normalizeHash(value.blockHash, 'confirmation block hash'),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      'confirmation block number',
    ),
  }
}

function getCounterpart(
  event: FollowSet,
  account: Address,
  direction: FollowDirection,
) {
  const selectedKey = account.toLowerCase()
  if (direction === 'following') {
    if (event.follower.toLowerCase() !== selectedKey) {
      throw projectionError('event account')
    }
    return event.followed
  }
  if (event.followed.toLowerCase() !== selectedKey) {
    throw projectionError('event account')
  }
  return event.follower
}

function createAddressIndexNode(): AddressIndexNode {
  return { children: new Map() }
}

function getAddressHex(account: Address) {
  return account.toLowerCase().slice(2)
}

function findFirstIndexedRelationship(node: AddressIndexNode) {
  let current = node
  for (let depth = 0; !current.relationshipKey; depth += 1) {
    if (depth >= ADDRESS_HEX_LENGTH) {
      throw projectionError('internal relationship index')
    }
    let child: AddressIndexNode | undefined
    for (const digit of HEX_DIGITS) {
      child = current.children.get(digit)
      if (child) break
    }
    if (!child) throw projectionError('internal relationship index')
    current = child
  }
  return current.relationshipKey
}

function findNextIndexedRelationship(root: AddressIndexNode, account: Address) {
  const addressHex = getAddressHex(account)
  const path = [root]
  let current = root
  for (const digit of addressHex) {
    const child = current.children.get(digit)
    if (!child) throw projectionError('read cursor')
    path.push(child)
    current = child
  }
  if (!current.relationshipKey) throw projectionError('read cursor')
  for (let depth = ADDRESS_HEX_LENGTH - 1; depth >= 0; depth -= 1) {
    const parent = path[depth]!
    const digitIndex = HEX_DIGITS.indexOf(addressHex[depth]!)
    for (let nextIndex = digitIndex + 1; nextIndex < 16; nextIndex += 1) {
      const sibling = parent.children.get(HEX_DIGITS[nextIndex]!)
      if (sibling) return findFirstIndexedRelationship(sibling)
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

function assertTransactionHashesBelongToOneBlock(
  events: readonly FollowSet[],
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

function assertConsistentFollowMetadata(
  events: readonly FollowSet[],
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
      throw projectionError(`${label} relationship block hash`)
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

function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  return first.logIndex - second.logIndex
}

function getPosition(log: IndexedEventLog): FollowProjectionPosition {
  return {
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  }
}

function decodePage(
  value: unknown,
  previous: { blockNumber: bigint } | undefined,
  account: Address,
  direction: FollowDirection,
): DecodedFollowPage {
  if (!Array.isArray(value)) throw projectionError('page')
  if (value.length > MAX_FOLLOW_PROJECTION_PAGE_LOGS) {
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
      const event = decodeFollowSet(log)
      if (!event) throw projectionError('event family')
      getCounterpart(event, account, direction)
      return event
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid follow projection ')
      ) {
        throw error
      }
      throw projectionError('event')
    }
  })
  assertConsistentFollowMetadata(events, 'page')
  assertBlockIdentities(events, 'page')
  return {
    events,
    last: logs.length > 0 ? getPosition(logs.at(-1)!) : undefined,
  }
}

function copyPosition(position: FollowProjectionPosition) {
  return { ...position }
}

function copyCheckpoint(checkpoint: EventCheckpoint) {
  return { ...checkpoint }
}

function copyRelationship(relationship: FollowSet) {
  return { ...relationship }
}

function getBoundary(
  last: FollowProjectionPosition | undefined,
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
  const options = value as FollowProjectionReadOptions
  const limit = options.limit ?? FOLLOW_PROJECTION_READ_PAGE_SIZE
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE
  ) {
    throw projectionError('read limit')
  }
  const after =
    options.after === undefined ? undefined : normalizeAccount(options.after)
  return { after, limit }
}

export class FollowProjection {
  readonly #addressIndex = createAddressIndexNode()
  readonly #account: Address
  readonly #direction: FollowDirection
  readonly #relationshipBlocksByHash = new Map<Hash, RetainedIdentity>()
  readonly #relationships = new Map<string, FollowSet>()
  readonly #relationshipTransactionsByHash = new Map<Hash, RetainedIdentity>()
  #confirmedThrough?: EventCheckpoint
  #last?: FollowProjectionPosition
  #signalCount = 0n

  constructor(accountValue: unknown, directionValue: unknown) {
    this.#account = normalizeAccount(accountValue)
    this.#direction = normalizeDirection(directionValue)
  }

  get account() {
    return this.#account
  }

  get direction() {
    return this.#direction
  }

  get progress(): FollowProjectionProgress {
    return {
      ...(this.#confirmedThrough
        ? { confirmedThrough: copyCheckpoint(this.#confirmedThrough) }
        : {}),
      ...(this.#last ? { last: copyPosition(this.#last) } : {}),
      relationshipCount: BigInt(this.#relationships.size),
      signalCount: this.#signalCount,
    }
  }

  applyLogs(value: unknown) {
    const page = decodePage(
      value,
      getBoundary(this.#last, this.#confirmedThrough),
      this.#account,
      this.#direction,
    )
    const nextSignalCount = this.#signalCount + BigInt(page.events.length)
    if (nextSignalCount > MAX_UINT256) {
      throw projectionError('signal count')
    }
    this.#assertCompatiblePage(page.events)
    for (const event of page.events) {
      const counterpart = getCounterpart(event, this.#account, this.#direction)
      this.#releaseRelationship(counterpart)
      if (event.following) this.#retainRelationship(counterpart, event)
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
    for (const boundary of [this.#last, this.#confirmedThrough]) {
      if (
        boundary &&
        boundary.blockHash === checkpoint.blockHash &&
        boundary.blockNumber !== checkpoint.blockNumber
      ) {
        throw projectionError('confirmation block identity')
      }
    }
    const retainedBlock = this.#relationshipBlocksByHash.get(
      checkpoint.blockHash,
    )
    if (retainedBlock && retainedBlock.blockNumber !== checkpoint.blockNumber) {
      throw projectionError('confirmation block identity')
    }
    this.#confirmedThrough = checkpoint
  }

  getRelationship(counterpartValue: unknown) {
    const counterpart = normalizeAccount(counterpartValue)
    const relationship = this.#relationships.get(counterpart.toLowerCase())
    return relationship ? copyRelationship(relationship) : undefined
  }

  hasRelationship(counterpartValue: unknown) {
    const counterpart = normalizeAccount(counterpartValue)
    return this.#relationships.has(counterpart.toLowerCase())
  }

  readRelationships(
    optionsValue: FollowProjectionReadOptions = {},
  ): FollowProjectionReadPage {
    const { after, limit } = normalizeReadOptions(optionsValue)
    if (after && !this.#relationships.has(after.toLowerCase())) {
      throw projectionError('read cursor')
    }
    let relationshipKey = after
      ? findNextIndexedRelationship(this.#addressIndex, after)
      : this.#relationships.size > 0
        ? findFirstIndexedRelationship(this.#addressIndex)
        : undefined
    const relationships: FollowSet[] = []
    let last: FollowSet | undefined
    while (relationshipKey && relationships.length < limit) {
      const relationship = this.#relationships.get(relationshipKey)
      if (!relationship) throw projectionError('internal relationship index')
      last = relationship
      relationships.push(copyRelationship(relationship))
      relationshipKey = findNextIndexedRelationship(
        this.#addressIndex,
        getCounterpart(relationship, this.#account, this.#direction),
      )
    }
    const complete = relationshipKey === undefined
    return {
      complete,
      relationships,
      nextAfter:
        complete || !last
          ? undefined
          : getCounterpart(last, this.#account, this.#direction),
      totalRelationships: BigInt(this.#relationships.size),
    }
  }

  reset() {
    this.#addressIndex.children.clear()
    this.#addressIndex.relationshipKey = undefined
    this.#relationshipBlocksByHash.clear()
    this.#relationships.clear()
    this.#relationshipTransactionsByHash.clear()
    this.#confirmedThrough = undefined
    this.#last = undefined
    this.#signalCount = 0n
  }

  #assertCompatiblePage(events: readonly FollowSet[]) {
    for (const event of events) {
      const retainedBlock = this.#relationshipBlocksByHash.get(event.blockHash)
      if (retainedBlock && retainedBlock.blockNumber !== event.blockNumber) {
        throw projectionError('history block identity')
      }
      const retainedTransaction = this.#relationshipTransactionsByHash.get(
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

  #releaseRelationship(counterpart: Address) {
    const key = counterpart.toLowerCase()
    const relationship = this.#relationships.get(key)
    if (!relationship) return
    this.#relationships.delete(key)
    const addressHex = getAddressHex(counterpart)
    const path = [this.#addressIndex]
    let node = this.#addressIndex
    for (const digit of addressHex) {
      const child = node.children.get(digit)
      if (!child) throw projectionError('internal relationship index')
      path.push(child)
      node = child
    }
    if (node.relationshipKey !== key)
      throw projectionError('internal relationship index')
    node.relationshipKey = undefined
    for (let depth = ADDRESS_HEX_LENGTH - 1; depth >= 0; depth -= 1) {
      const child = path[depth + 1]!
      if (child.relationshipKey || child.children.size > 0) break
      path[depth]!.children.delete(addressHex[depth]!)
    }
    releaseIdentity(this.#relationshipBlocksByHash, relationship.blockHash)
    releaseIdentity(
      this.#relationshipTransactionsByHash,
      relationship.transactionHash,
    )
  }

  #retainRelationship(counterpart: Address, value: FollowSet) {
    const relationship = copyRelationship(value)
    const key = counterpart.toLowerCase()
    this.#relationships.set(key, relationship)
    let node = this.#addressIndex
    for (const digit of getAddressHex(counterpart)) {
      let child = node.children.get(digit)
      if (!child) {
        child = createAddressIndexNode()
        node.children.set(digit, child)
      }
      node = child
    }
    if (node.relationshipKey)
      throw projectionError('internal relationship index')
    node.relationshipKey = key
    retainIdentity(
      this.#relationshipBlocksByHash,
      relationship.blockHash,
      relationship.blockNumber,
    )
    retainIdentity(
      this.#relationshipTransactionsByHash,
      relationship.transactionHash,
      relationship.blockNumber,
    )
  }
}
