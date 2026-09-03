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
  type IndexedEventLog,
} from './event-indexer'
import {
  decodePostLikeSet,
  decodePublishedRepost,
  type PostLikeSet,
  type PublishedRepost,
} from './protocol-events'

export const MAX_POST_REACTION_PROJECTION_PAGE_LOGS = 5_199
export const POST_REACTION_PROJECTION_SNAPSHOT_VERSION = 1

const MAX_UINT256 = (1n << 256n) - 1n

export type PostReactionProjectionPosition = {
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
}

export type PostReactionProjectionProgress = {
  likes?: PostReactionProjectionPosition
  reposts?: PostReactionProjectionPosition
}

export type PostReactionSummary = {
  likeCount: bigint
  likedByAccount?: boolean
  repostCount: bigint
}

export type PostReactionProjectionActiveLike = {
  account: Address
  postId: bigint
}

export type PostReactionProjectionRepostCount = {
  count: bigint
  postId: bigint
}

export type PostReactionProjectionBlockFingerprint = {
  blockHash: Hash
  blockNumber: bigint
}

export type PostReactionProjectionSnapshot = {
  activeLikes: readonly PostReactionProjectionActiveLike[]
  blockHashes: readonly PostReactionProjectionBlockFingerprint[]
  progress: PostReactionProjectionProgress
  repostCounts: readonly PostReactionProjectionRepostCount[]
  schemaVersion: typeof POST_REACTION_PROJECTION_SNAPSHOT_VERSION
}

type DecodedPage<Event> = {
  blockHashes: ReadonlyMap<bigint, Hash>
  events: readonly Event[]
  last?: PostReactionProjectionPosition
}

function projectionError(message: string) {
  return new Error(`Invalid post reaction projection ${message}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  return first.logIndex - second.logIndex
}

function getPosition(log: IndexedEventLog): PostReactionProjectionPosition {
  return {
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  }
}

function copyPosition(position: PostReactionProjectionPosition) {
  return { ...position }
}

function assertCompatibleProjectionPage(
  page: DecodedPage<unknown>,
  retainedBlockHashes: ReadonlyMap<bigint, Hash>,
) {
  for (const [blockNumber, blockHash] of page.blockHashes) {
    const retainedHash = retainedBlockHashes.get(blockNumber)
    if (retainedHash !== undefined && retainedHash !== blockHash) {
      throw projectionError('stream progress block hash')
    }
  }
}

function normalizePosition(
  value: unknown,
  label: string,
): PostReactionProjectionPosition | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw projectionError(`${label} snapshot position`)
  if (
    typeof value.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(value.blockHash)
  ) {
    throw projectionError(`${label} snapshot block hash`)
  }
  if (
    typeof value.blockNumber !== 'bigint' ||
    value.blockNumber < 0n ||
    value.blockNumber > MAX_UINT256
  ) {
    throw projectionError(`${label} snapshot block number`)
  }
  if (
    typeof value.logIndex !== 'number' ||
    !Number.isSafeInteger(value.logIndex) ||
    value.logIndex < 0
  ) {
    throw projectionError(`${label} snapshot log index`)
  }
  return {
    blockHash: value.blockHash.toLowerCase() as Hash,
    blockNumber: value.blockNumber,
    logIndex: value.logIndex,
  }
}

function decodePage<Event>(
  value: unknown,
  previous: PostReactionProjectionPosition | undefined,
  decode: (log: IndexedEventLog) => Event | undefined,
  label: string,
): DecodedPage<Event> {
  if (!Array.isArray(value)) throw projectionError(`${label} page`)
  if (value.length > MAX_POST_REACTION_PROJECTION_PAGE_LOGS) {
    throw projectionError(`${label} page size`)
  }
  const logs = value.map((entry) => {
    try {
      return validateIndexedEventLog(entry)
    } catch {
      throw projectionError(`${label} log`)
    }
  })
  const blockHashes = new Map<bigint, Hash>()
  for (let index = 0; index < logs.length; index += 1) {
    const log = logs[index]!
    if (index > 0 && compareLogs(logs[index - 1]!, log) >= 0) {
      throw projectionError(`${label} order`)
    }
    const knownHash = blockHashes.get(log.blockNumber)
    if (knownHash !== undefined && knownHash !== log.blockHash) {
      throw projectionError(`${label} block hash`)
    }
    blockHashes.set(log.blockNumber, log.blockHash)
  }
  const first = logs[0]
  if (first !== undefined && previous !== undefined) {
    if (first.blockNumber <= previous.blockNumber) {
      throw projectionError(`${label} page boundary`)
    }
  }
  if (!eventTransactionsAreConsistent(logs)) {
    throw projectionError(`${label} transaction metadata`)
  }
  const events = logs.map((log) => {
    try {
      const event = decode(log)
      if (!event) throw projectionError(`${label} event family`)
      return event
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid post reaction projection ')
      ) {
        throw error
      }
      throw projectionError(`${label} event`)
    }
  })
  return {
    blockHashes,
    events,
    last: logs.length > 0 ? getPosition(logs.at(-1)!) : undefined,
  }
}

function normalizePostId(value: unknown) {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_UINT256) {
    throw projectionError('post identifier')
  }
  return value
}

function normalizeAccount(value: unknown) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw projectionError('account')
  }
  return getAddress(value)
}

function getPostKey(postId: bigint) {
  return postId.toString(16)
}

function getLikeKey(postId: bigint, account: Address) {
  return `${getPostKey(postId)}:${account.toLowerCase()}`
}

function compareActiveLikes(
  first: PostReactionProjectionActiveLike,
  second: PostReactionProjectionActiveLike,
) {
  if (first.postId !== second.postId)
    return first.postId < second.postId ? -1 : 1
  const firstAccount = first.account.toLowerCase()
  const secondAccount = second.account.toLowerCase()
  if (firstAccount === secondAccount) return 0
  return firstAccount < secondAccount ? -1 : 1
}

function compareRepostCounts(
  first: PostReactionProjectionRepostCount,
  second: PostReactionProjectionRepostCount,
) {
  if (first.postId === second.postId) return 0
  return first.postId < second.postId ? -1 : 1
}

function compareBlockFingerprints(
  first: PostReactionProjectionBlockFingerprint,
  second: PostReactionProjectionBlockFingerprint,
) {
  if (first.blockNumber === second.blockNumber) return 0
  return first.blockNumber < second.blockNumber ? -1 : 1
}

function decodeLikeKey(key: string): PostReactionProjectionActiveLike {
  const separator = key.indexOf(':')
  if (separator < 1) throw projectionError('internal like key')
  return {
    account: getAddress(key.slice(separator + 1)),
    postId: BigInt(`0x${key.slice(0, separator)}`),
  }
}

function normalizeActiveLikes(
  value: unknown,
): readonly PostReactionProjectionActiveLike[] {
  if (!Array.isArray(value)) throw projectionError('active likes snapshot')
  const likes = new Map<string, PostReactionProjectionActiveLike>()
  for (const entryValue of value) {
    if (!isRecord(entryValue)) throw projectionError('active like snapshot')
    const postId = normalizePostId(entryValue.postId)
    const account = normalizeAccount(entryValue.account)
    const key = getLikeKey(postId, account)
    if (likes.has(key)) throw projectionError('duplicate active like snapshot')
    likes.set(key, { account, postId })
  }
  return [...likes.values()].toSorted(compareActiveLikes)
}

function normalizeRepostCounts(
  value: unknown,
): readonly PostReactionProjectionRepostCount[] {
  if (!Array.isArray(value)) throw projectionError('repost counts snapshot')
  const counts = new Map<string, PostReactionProjectionRepostCount>()
  for (const entryValue of value) {
    if (!isRecord(entryValue)) throw projectionError('repost count snapshot')
    const postId = normalizePostId(entryValue.postId)
    if (typeof entryValue.count !== 'bigint' || entryValue.count < 1n) {
      throw projectionError('repost snapshot count')
    }
    const key = getPostKey(postId)
    if (counts.has(key))
      throw projectionError('duplicate repost count snapshot')
    counts.set(key, { count: entryValue.count, postId })
  }
  return [...counts.values()].toSorted(compareRepostCounts)
}

function normalizeBlockHashes(
  value: unknown,
): readonly PostReactionProjectionBlockFingerprint[] {
  if (!Array.isArray(value)) throw projectionError('block hashes snapshot')
  const fingerprints = new Map<bigint, Hash>()
  for (const entryValue of value) {
    if (!isRecord(entryValue)) throw projectionError('block hash snapshot')
    if (
      typeof entryValue.blockNumber !== 'bigint' ||
      entryValue.blockNumber < 0n ||
      entryValue.blockNumber > MAX_UINT256
    ) {
      throw projectionError('snapshot block hash number')
    }
    if (
      typeof entryValue.blockHash !== 'string' ||
      !/^0x[0-9a-f]{64}$/i.test(entryValue.blockHash)
    ) {
      throw projectionError('snapshot block hash value')
    }
    if (fingerprints.has(entryValue.blockNumber)) {
      throw projectionError('duplicate snapshot block hash')
    }
    fingerprints.set(
      entryValue.blockNumber,
      entryValue.blockHash.toLowerCase() as Hash,
    )
  }
  return [...fingerprints]
    .map(([blockNumber, blockHash]) => ({ blockHash, blockNumber }))
    .toSorted(compareBlockFingerprints)
}

function normalizeSnapshot(value: unknown): PostReactionProjectionSnapshot {
  if (!isRecord(value)) throw projectionError('snapshot')
  if (value.schemaVersion !== POST_REACTION_PROJECTION_SNAPSHOT_VERSION) {
    throw projectionError('snapshot schema version')
  }
  if (!isRecord(value.progress)) throw projectionError('snapshot progress')
  const progress = {
    likes: normalizePosition(value.progress.likes, 'like'),
    reposts: normalizePosition(value.progress.reposts, 'repost'),
  }
  const activeLikes = normalizeActiveLikes(value.activeLikes)
  const blockHashes = normalizeBlockHashes(value.blockHashes)
  const repostCounts = normalizeRepostCounts(value.repostCounts)
  if (activeLikes.length > 0 && !progress.likes) {
    throw projectionError('active likes snapshot progress')
  }
  if (repostCounts.length > 0 && !progress.reposts) {
    throw projectionError('repost counts snapshot progress')
  }
  if (progress.reposts && repostCounts.length === 0) {
    throw projectionError('repost progress snapshot counts')
  }
  const fingerprints = new Map(
    blockHashes.map(({ blockHash, blockNumber }) => [blockNumber, blockHash]),
  )
  const likeBlock = progress.likes?.blockNumber
  const repostBlock = progress.reposts?.blockNumber
  const frontierStart =
    likeBlock !== undefined && repostBlock !== undefined
      ? likeBlock < repostBlock
        ? likeBlock
        : repostBlock
      : undefined
  const frontierEnd =
    likeBlock === undefined
      ? repostBlock
      : repostBlock === undefined || likeBlock > repostBlock
        ? likeBlock
        : repostBlock
  if (
    blockHashes.some(
      ({ blockNumber }) =>
        frontierEnd === undefined ||
        blockNumber > frontierEnd ||
        (frontierStart !== undefined && blockNumber <= frontierStart),
    )
  ) {
    throw projectionError('snapshot block hash boundary')
  }
  const frontierPosition =
    likeBlock === undefined
      ? progress.reposts
      : repostBlock === undefined || likeBlock > repostBlock
        ? progress.likes
        : repostBlock > likeBlock
          ? progress.reposts
          : undefined
  if (
    frontierPosition &&
    fingerprints.get(frontierPosition.blockNumber) !==
      frontierPosition.blockHash
  ) {
    throw projectionError('snapshot progress block fingerprint')
  }
  if (
    progress.likes &&
    progress.reposts &&
    progress.likes.blockNumber === progress.reposts.blockNumber &&
    progress.likes.blockHash !== progress.reposts.blockHash
  ) {
    throw projectionError('snapshot progress block hash')
  }
  return {
    activeLikes,
    blockHashes,
    progress,
    repostCounts,
    schemaVersion: POST_REACTION_PROJECTION_SNAPSHOT_VERSION,
  }
}

function serializeSnapshot(snapshot: PostReactionProjectionSnapshot) {
  return JSON.stringify([
    'lifeinvader.post-reaction-projection.snapshot.v1',
    snapshot.blockHashes.map(({ blockHash, blockNumber }) => [
      blockNumber.toString(16),
      blockHash,
    ]),
    snapshot.activeLikes.map(({ account, postId }) => [
      postId.toString(16),
      account.toLowerCase(),
    ]),
    snapshot.repostCounts.map(({ count, postId }) => [
      postId.toString(16),
      count.toString(16),
    ]),
    snapshot.progress.likes
      ? [
          snapshot.progress.likes.blockNumber.toString(16),
          snapshot.progress.likes.logIndex.toString(16),
          snapshot.progress.likes.blockHash,
        ]
      : null,
    snapshot.progress.reposts
      ? [
          snapshot.progress.reposts.blockNumber.toString(16),
          snapshot.progress.reposts.logIndex.toString(16),
          snapshot.progress.reposts.blockHash,
        ]
      : null,
  ])
}

export function getPostReactionProjectionSnapshotDigest(value: unknown) {
  return keccak256(stringToHex(serializeSnapshot(normalizeSnapshot(value))))
}

export class PostReactionProjection {
  readonly #activeLikes = new Set<string>()
  readonly #blockHashes = new Map<bigint, Hash>()
  readonly #likeCounts = new Map<string, bigint>()
  readonly #repostCounts = new Map<string, bigint>()
  #lastLike?: PostReactionProjectionPosition
  #lastRepost?: PostReactionProjectionPosition

  static fromSnapshot(value: unknown) {
    const snapshot = normalizeSnapshot(value)
    const projection = new PostReactionProjection()
    for (const { account, postId } of snapshot.activeLikes) {
      const postKey = getPostKey(postId)
      projection.#activeLikes.add(getLikeKey(postId, account))
      projection.#likeCounts.set(
        postKey,
        (projection.#likeCounts.get(postKey) ?? 0n) + 1n,
      )
    }
    for (const { blockHash, blockNumber } of snapshot.blockHashes) {
      projection.#blockHashes.set(blockNumber, blockHash)
    }
    for (const { count, postId } of snapshot.repostCounts) {
      projection.#repostCounts.set(getPostKey(postId), count)
    }
    projection.#lastLike = snapshot.progress.likes
    projection.#lastRepost = snapshot.progress.reposts
    return projection
  }

  get progress(): PostReactionProjectionProgress {
    return {
      likes: this.#lastLike ? copyPosition(this.#lastLike) : undefined,
      reposts: this.#lastRepost ? copyPosition(this.#lastRepost) : undefined,
    }
  }

  get snapshot(): PostReactionProjectionSnapshot {
    const activeLikes = [...this.#activeLikes]
      .map(decodeLikeKey)
      .toSorted(compareActiveLikes)
    const repostCounts = [...this.#repostCounts].map(([postKey, count]) => ({
      count,
      postId: BigInt(`0x${postKey}`),
    }))
    repostCounts.sort(compareRepostCounts)
    const blockHashes = [...this.#blockHashes]
      .map(([blockNumber, blockHash]) => ({ blockHash, blockNumber }))
      .toSorted(compareBlockFingerprints)
    return {
      activeLikes,
      blockHashes,
      progress: this.progress,
      repostCounts,
      schemaVersion: POST_REACTION_PROJECTION_SNAPSHOT_VERSION,
    }
  }

  reset() {
    this.#activeLikes.clear()
    this.#blockHashes.clear()
    this.#likeCounts.clear()
    this.#repostCounts.clear()
    this.#lastLike = undefined
    this.#lastRepost = undefined
  }

  #pruneBlockHashes() {
    if (!this.#lastLike || !this.#lastRepost) return
    const completeThrough =
      this.#lastLike.blockNumber < this.#lastRepost.blockNumber
        ? this.#lastLike.blockNumber
        : this.#lastRepost.blockNumber
    for (const blockNumber of this.#blockHashes.keys()) {
      if (blockNumber <= completeThrough) this.#blockHashes.delete(blockNumber)
    }
  }

  applyLikeLogs(value: unknown) {
    const page = decodePage<PostLikeSet>(
      value,
      this.#lastLike,
      decodePostLikeSet,
      'like',
    )
    const activeChanges = new Map<string, boolean>()
    const countChanges = new Map<string, bigint>()
    for (const event of page.events) {
      const postKey = getPostKey(event.postId)
      const likeKey = getLikeKey(event.postId, event.account)
      const wasLiked = activeChanges.has(likeKey)
        ? activeChanges.get(likeKey)!
        : this.#activeLikes.has(likeKey)
      let count =
        countChanges.get(postKey) ?? this.#likeCounts.get(postKey) ?? 0n
      if (event.liked !== wasLiked) {
        count += event.liked ? 1n : -1n
        if (count < 0n) throw projectionError('like count')
      }
      activeChanges.set(likeKey, event.liked)
      countChanges.set(postKey, count)
    }
    assertCompatibleProjectionPage(page, this.#blockHashes)
    for (const [likeKey, liked] of activeChanges) {
      if (liked) this.#activeLikes.add(likeKey)
      else this.#activeLikes.delete(likeKey)
    }
    for (const [postKey, count] of countChanges) {
      if (count === 0n) this.#likeCounts.delete(postKey)
      else this.#likeCounts.set(postKey, count)
    }
    for (const [blockNumber, blockHash] of page.blockHashes) {
      this.#blockHashes.set(blockNumber, blockHash)
    }
    if (page.last) this.#lastLike = page.last
    this.#pruneBlockHashes()
  }

  applyRepostLogs(value: unknown) {
    const page = decodePage<PublishedRepost>(
      value,
      this.#lastRepost,
      decodePublishedRepost,
      'repost',
    )
    const countChanges = new Map<string, bigint>()
    for (const event of page.events) {
      const postKey = getPostKey(event.postId)
      const count =
        countChanges.get(postKey) ?? this.#repostCounts.get(postKey) ?? 0n
      countChanges.set(postKey, count + 1n)
    }
    assertCompatibleProjectionPage(page, this.#blockHashes)
    for (const [postKey, count] of countChanges) {
      this.#repostCounts.set(postKey, count)
    }
    for (const [blockNumber, blockHash] of page.blockHashes) {
      this.#blockHashes.set(blockNumber, blockHash)
    }
    if (page.last) this.#lastRepost = page.last
    this.#pruneBlockHashes()
  }

  getSummary(
    postIdValue: unknown,
    accountValue?: unknown,
  ): PostReactionSummary {
    const postId = normalizePostId(postIdValue)
    const postKey = getPostKey(postId)
    const summary: PostReactionSummary = {
      likeCount: this.#likeCounts.get(postKey) ?? 0n,
      repostCount: this.#repostCounts.get(postKey) ?? 0n,
    }
    if (accountValue !== undefined) {
      const account = normalizeAccount(accountValue)
      summary.likedByAccount = this.#activeLikes.has(
        getLikeKey(postId, account),
      )
    }
    return summary
  }
}
