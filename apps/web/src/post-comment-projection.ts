import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Hash,
  type Hex,
} from 'viem'
import {
  eventTransactionsAreConsistent,
  validateIndexedEventLog,
  type EventCheckpoint,
  type IndexedEventLog,
} from './event-indexer'
import {
  decodePublishedComment,
  type PublishedComment,
} from './protocol-events'
import {
  getUtf8ByteLength,
  MAX_MEDIA_CID_BYTES,
  MAX_POST_BODY_BYTES,
  PROTOCOL_ADDRESS,
} from './protocol'

export const MAX_POST_COMMENT_PROJECTION_PAGE_LOGS = 5_199
export const MAX_POST_COMMENT_PROJECTION_POSTS = 50
export const POST_COMMENT_PROJECTION_READ_PAGE_SIZE = 50
export const MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE = 200
export const POST_COMMENT_PROJECTION_SNAPSHOT_VERSION = 1

const MAX_UINT256 = (1n << 256n) - 1n

export type PostCommentProjectionPosition = {
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
}

export type PostCommentProjectionProgress = {
  commentCount: bigint
  confirmedThrough?: EventCheckpoint
  last?: PostCommentProjectionPosition
  retainedCommentCount: bigint
}

export type PostCommentProjectionSnapshot = {
  commentCount: bigint
  comments: readonly PublishedComment[]
  confirmedThrough?: EventCheckpoint
  last?: PostCommentProjectionPosition
  postIds: readonly bigint[]
  schemaVersion: typeof POST_COMMENT_PROJECTION_SNAPSHOT_VERSION
}

export type PostCommentProjectionReadPage = {
  comments: readonly PublishedComment[]
  complete: boolean
  nextOffset?: number
  totalComments: bigint
}

export type PostCommentProjectionReadOptions = {
  limit?: number
  offset?: number
}

type DecodedCommentPage = {
  comments: readonly PublishedComment[]
  last?: PostCommentProjectionPosition
}

function projectionError(message: string) {
  return new Error(`Invalid post comment projection ${message}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function comparePositions(
  first: { blockNumber: bigint; logIndex: number },
  second: { blockNumber: bigint; logIndex: number },
) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  if (first.logIndex === second.logIndex) return 0
  return first.logIndex < second.logIndex ? -1 : 1
}

function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  return comparePositions(first, second)
}

function copyComment(comment: PublishedComment): PublishedComment {
  return { ...comment }
}

function copyPosition(position: PostCommentProjectionPosition) {
  return { ...position }
}

function copyCheckpoint(checkpoint: EventCheckpoint) {
  return { ...checkpoint }
}

function normalizePostId(value: unknown) {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_UINT256) {
    throw projectionError('post identifier')
  }
  return value
}

function normalizeCommentId(value: unknown) {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_UINT256) {
    throw projectionError('snapshot comment identifier')
  }
  return value
}

function normalizeBlockNumber(value: unknown, label: string) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) {
    throw projectionError(label)
  }
  return value
}

function normalizeHash(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw projectionError(label)
  }
  return value.toLowerCase() as Hash
}

function normalizeIndex(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw projectionError(label)
  }
  return value
}

function normalizeAccount(value: unknown) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw projectionError('snapshot comment author')
  }
  return getAddress(value)
}

function normalizeMediaCid(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_MEDIA_CID_BYTES * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw projectionError('snapshot comment media CID')
  }
  return value.toLowerCase() as Hex
}

function normalizeComment(value: unknown): PublishedComment {
  if (!isRecord(value)) throw projectionError('snapshot comment')
  if (
    typeof value.body !== 'string' ||
    value.body.length > MAX_POST_BODY_BYTES ||
    getUtf8ByteLength(value.body) > MAX_POST_BODY_BYTES
  ) {
    throw projectionError('snapshot comment body')
  }
  const mediaCid = normalizeMediaCid(value.mediaCid)
  if (value.body.length === 0 && mediaCid === '0x') {
    throw projectionError('snapshot comment content')
  }
  return {
    author: normalizeAccount(value.author),
    blockHash: normalizeHash(value.blockHash, 'snapshot comment block hash'),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      'snapshot comment block number',
    ),
    body: value.body,
    commentId: normalizeCommentId(value.commentId),
    logIndex: normalizeIndex(value.logIndex, 'snapshot comment log index'),
    mediaCid,
    postId: normalizePostId(value.postId),
    transactionHash: normalizeHash(
      value.transactionHash,
      'snapshot comment transaction hash',
    ),
    transactionIndex: normalizeIndex(
      value.transactionIndex,
      'snapshot comment transaction index',
    ),
  }
}

function normalizeTrackedPostIds(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_POST_COMMENT_PROJECTION_POSTS
  ) {
    throw projectionError('tracked posts')
  }
  const seen = new Set<string>()
  const postIds = value.map((postIdValue) => {
    const postId = normalizePostId(postIdValue)
    const key = postId.toString(16)
    if (seen.has(key)) throw projectionError('duplicate tracked post')
    seen.add(key)
    return postId
  })
  return postIds.toSorted((first, second) =>
    first === second ? 0 : first < second ? -1 : 1,
  )
}

function normalizeReadOptions(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw projectionError('read options')
  }
  const options = value as PostCommentProjectionReadOptions
  const limit = options.limit ?? POST_COMMENT_PROJECTION_READ_PAGE_SIZE
  const offset = options.offset ?? 0
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE
  ) {
    throw projectionError('read limit')
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw projectionError('read offset')
  }
  return { limit, offset }
}

function normalizeCheckpoint(
  value: unknown,
  label = 'confirmation',
): EventCheckpoint {
  if (!isRecord(value)) throw projectionError(label)
  return {
    blockHash: normalizeHash(value.blockHash, `${label} block hash`),
    blockNumber: normalizeBlockNumber(
      value.blockNumber,
      `${label} block number`,
    ),
  }
}

function normalizePosition(
  value: unknown,
): PostCommentProjectionPosition | undefined {
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

function assertTransactionHashesBelongToOneBlock(
  comments: readonly PublishedComment[],
  label: string,
) {
  const blocksByTransactionHash = new Map<Hash, bigint>()
  for (const comment of comments) {
    const knownBlockNumber = blocksByTransactionHash.get(
      comment.transactionHash,
    )
    if (
      knownBlockNumber !== undefined &&
      knownBlockNumber !== comment.blockNumber
    ) {
      throw projectionError(`${label} transaction block`)
    }
    blocksByTransactionHash.set(comment.transactionHash, comment.blockNumber)
  }
}

function assertConsistentCommentMetadata(
  comments: readonly PublishedComment[],
  label: string,
) {
  const commentIds = new Set<string>()
  const positions = new Set<string>()
  for (let index = 0; index < comments.length; index += 1) {
    const comment = comments[index]!
    const commentId = comment.commentId.toString(16)
    if (commentIds.has(commentId)) {
      throw projectionError(`${label} duplicate comment identifier`)
    }
    commentIds.add(commentId)
    const position = `${comment.blockNumber.toString(16)}:${comment.logIndex.toString(16)}`
    if (positions.has(position)) {
      throw projectionError(`${label} duplicate log position`)
    }
    positions.add(position)
    const previous = comments[index - 1]
    if (previous && previous.commentId >= comment.commentId) {
      throw projectionError(`${label} comment identifier order`)
    }
  }
  assertTransactionHashesBelongToOneBlock(comments, label)
  const logs = comments.map((comment): IndexedEventLog => ({
    address: PROTOCOL_ADDRESS,
    blockHash: comment.blockHash,
    blockNumber: comment.blockNumber,
    data: '0x',
    logIndex: comment.logIndex,
    topics: [],
    transactionHash: comment.transactionHash,
    transactionIndex: comment.transactionIndex,
  }))
  if (!eventTransactionsAreConsistent(logs)) {
    throw projectionError(`${label} transaction metadata`)
  }
}

function normalizeSnapshot(value: unknown): PostCommentProjectionSnapshot {
  if (!isRecord(value)) throw projectionError('snapshot')
  if (value.schemaVersion !== POST_COMMENT_PROJECTION_SNAPSHOT_VERSION) {
    throw projectionError('snapshot schema version')
  }
  const postIds = normalizeTrackedPostIds(value.postIds)
  const commentCount = normalizeBlockNumber(
    value.commentCount,
    'snapshot comment count',
  )
  if (!Array.isArray(value.comments)) {
    throw projectionError('snapshot comments')
  }
  if (BigInt(value.comments.length) > commentCount) {
    throw projectionError('snapshot retained comment count')
  }
  const tracked = new Set(postIds.map((postId) => postId.toString(16)))
  const comments = value.comments
    .map(normalizeComment)
    .toSorted(comparePositions)
  for (const comment of comments) {
    if (!tracked.has(comment.postId.toString(16))) {
      throw projectionError('snapshot untracked comment')
    }
    if (comment.commentId > commentCount) {
      throw projectionError('snapshot comment count boundary')
    }
  }
  const last = normalizePosition(value.last)
  const confirmedThrough =
    value.confirmedThrough === undefined
      ? undefined
      : normalizeCheckpoint(value.confirmedThrough, 'snapshot confirmation')
  if (commentCount === 0n && (comments.length > 0 || last)) {
    throw projectionError('snapshot empty progress')
  }
  if (commentCount > 0n && !last) {
    throw projectionError('snapshot comment progress')
  }
  assertConsistentCommentMetadata(comments, 'snapshot')
  if (last) {
    for (const comment of comments) {
      if (
        comparePositions(comment, last) > 0 ||
        (comment.blockNumber === last.blockNumber &&
          comment.blockHash !== last.blockHash)
      ) {
        throw projectionError('snapshot comment boundary')
      }
      const atLastPosition = comparePositions(comment, last) === 0
      if (
        (comment.commentId === commentCount && !atLastPosition) ||
        (atLastPosition && comment.commentId !== commentCount)
      ) {
        throw projectionError('snapshot comment tail')
      }
    }
  }
  if (
    last &&
    confirmedThrough &&
    (last.blockNumber > confirmedThrough.blockNumber ||
      (last.blockNumber === confirmedThrough.blockNumber &&
        last.blockHash !== confirmedThrough.blockHash))
  ) {
    throw projectionError('snapshot confirmation progress')
  }
  assertBlockIdentities(
    [
      ...comments,
      ...(last ? [last] : []),
      ...(confirmedThrough ? [confirmedThrough] : []),
    ],
    'snapshot',
  )
  return {
    commentCount,
    comments,
    ...(confirmedThrough ? { confirmedThrough } : {}),
    ...(last ? { last } : {}),
    postIds,
    schemaVersion: POST_COMMENT_PROJECTION_SNAPSHOT_VERSION,
  }
}

function serializeSnapshot(value: unknown) {
  const snapshot = normalizeSnapshot(value)
  return JSON.stringify([
    'lifeinvader.post-comment-projection.snapshot.v1',
    snapshot.postIds.map((postId) => postId.toString(16)),
    snapshot.commentCount.toString(16),
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
    snapshot.comments.map((comment) => [
      comment.commentId.toString(16),
      comment.postId.toString(16),
      comment.author.toLowerCase(),
      comment.body,
      comment.mediaCid,
      comment.blockNumber.toString(16),
      comment.blockHash,
      comment.logIndex.toString(16),
      comment.transactionHash,
      comment.transactionIndex.toString(16),
    ]),
  ])
}

export function getPostCommentProjectionSnapshotDigest(value: unknown) {
  return keccak256(stringToHex(serializeSnapshot(value)))
}

function getPosition(log: IndexedEventLog): PostCommentProjectionPosition {
  return {
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  }
}

function getBoundary(
  last: PostCommentProjectionPosition | undefined,
  confirmedThrough: EventCheckpoint | undefined,
) {
  if (!confirmedThrough) return last
  if (!last || confirmedThrough.blockNumber >= last.blockNumber) {
    return confirmedThrough
  }
  return last
}

function decodePage(
  value: unknown,
  previous: { blockNumber: bigint } | undefined,
): DecodedCommentPage {
  if (!Array.isArray(value)) throw projectionError('page')
  if (value.length > MAX_POST_COMMENT_PROJECTION_PAGE_LOGS) {
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
  const comments = logs.map((log) => {
    try {
      const comment = decodePublishedComment(log)
      if (!comment) throw projectionError('event family')
      return comment
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid post comment projection ')
      ) {
        throw error
      }
      throw projectionError('event')
    }
  })
  return {
    comments,
    last: logs.length > 0 ? getPosition(logs.at(-1)!) : undefined,
  }
}

export class PostCommentProjection {
  readonly #blockHashesByNumber = new Map<bigint, Hash>()
  readonly #blockNumbersByHash = new Map<Hash, bigint>()
  readonly #comments = new Map<string, PublishedComment[]>()
  readonly #postIds: readonly bigint[]
  readonly #tracked = new Set<string>()
  readonly #transactionBlocksByHash = new Map<Hash, bigint>()
  #commentCount = 0n
  #confirmedThrough?: EventCheckpoint
  #last?: PostCommentProjectionPosition
  #retainedCommentCount = 0n

  constructor(postIdsValue: unknown) {
    this.#postIds = normalizeTrackedPostIds(postIdsValue)
    for (const postId of this.#postIds) {
      this.#tracked.add(postId.toString(16))
    }
  }

  static fromSnapshot(value: unknown) {
    const snapshot = normalizeSnapshot(value)
    const projection = new PostCommentProjection(snapshot.postIds)
    for (const comment of snapshot.comments) {
      const key = comment.postId.toString(16)
      const comments = projection.#comments.get(key) ?? []
      comments.push(copyComment(comment))
      projection.#comments.set(key, comments)
      projection.#retainCommentIdentity(comment)
    }
    projection.#commentCount = snapshot.commentCount
    projection.#confirmedThrough = snapshot.confirmedThrough
      ? copyCheckpoint(snapshot.confirmedThrough)
      : undefined
    projection.#last = snapshot.last ? copyPosition(snapshot.last) : undefined
    projection.#retainedCommentCount = BigInt(snapshot.comments.length)
    return projection
  }

  get progress(): PostCommentProjectionProgress {
    return {
      commentCount: this.#commentCount,
      confirmedThrough: this.#confirmedThrough
        ? copyCheckpoint(this.#confirmedThrough)
        : undefined,
      last: this.#last ? copyPosition(this.#last) : undefined,
      retainedCommentCount: this.#retainedCommentCount,
    }
  }

  get snapshot(): PostCommentProjectionSnapshot {
    const comments = [...this.#comments.values()]
      .flatMap((postComments) => postComments.map(copyComment))
      .toSorted(comparePositions)
    return {
      commentCount: this.#commentCount,
      comments,
      ...(this.#confirmedThrough
        ? { confirmedThrough: copyCheckpoint(this.#confirmedThrough) }
        : {}),
      ...(this.#last ? { last: copyPosition(this.#last) } : {}),
      postIds: [...this.#postIds],
      schemaVersion: POST_COMMENT_PROJECTION_SNAPSHOT_VERSION,
    }
  }

  get trackedPostIds() {
    return [...this.#postIds]
  }

  applyLogs(value: unknown) {
    const page = decodePage(
      value,
      getBoundary(this.#last, this.#confirmedThrough),
    )
    const retained = new Map<string, PublishedComment[]>()
    for (let index = 0; index < page.comments.length; index += 1) {
      const comment = page.comments[index]!
      const expectedCommentId = this.#commentCount + BigInt(index) + 1n
      if (comment.commentId !== expectedCommentId) {
        throw projectionError('comment identifier sequence')
      }
      const key = comment.postId.toString(16)
      if (!this.#tracked.has(key)) continue
      const comments = retained.get(key) ?? []
      comments.push(comment)
      retained.set(key, comments)
    }
    this.#assertCompatiblePage(page.comments)
    for (const [key, comments] of retained) {
      const existing = this.#comments.get(key)
      if (existing) existing.push(...comments)
      else this.#comments.set(key, [...comments])
      for (const comment of comments) this.#retainCommentIdentity(comment)
      this.#retainedCommentCount += BigInt(comments.length)
    }
    this.#commentCount += BigInt(page.comments.length)
    if (page.last) {
      this.#last = page.last
      if (
        this.#confirmedThrough &&
        page.last.blockNumber > this.#confirmedThrough.blockNumber
      ) {
        this.#confirmedThrough = undefined
      }
    }
  }

  confirmThrough(value: unknown) {
    const checkpoint = normalizeCheckpoint(value)
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
    this.#assertCompatibleBlock(checkpoint, 'confirmation')
    this.#confirmedThrough = checkpoint
  }

  readComments(
    postIdValue: unknown,
    optionsValue: PostCommentProjectionReadOptions = {},
  ): PostCommentProjectionReadPage {
    const postId = normalizePostId(postIdValue)
    const key = postId.toString(16)
    if (!this.#tracked.has(key)) {
      throw projectionError('untracked post')
    }
    const { limit, offset } = normalizeReadOptions(optionsValue)
    const comments = this.#comments.get(key) ?? []
    if (offset > comments.length) throw projectionError('read offset')
    const end = Math.min(offset + limit, comments.length)
    const complete = end >= comments.length
    return {
      comments: comments.slice(offset, end).map(copyComment),
      complete,
      nextOffset: complete ? undefined : end,
      totalComments: BigInt(comments.length),
    }
  }

  reset() {
    this.#blockHashesByNumber.clear()
    this.#blockNumbersByHash.clear()
    this.#comments.clear()
    this.#commentCount = 0n
    this.#confirmedThrough = undefined
    this.#last = undefined
    this.#retainedCommentCount = 0n
    this.#transactionBlocksByHash.clear()
  }

  #assertCompatibleBlock(
    fingerprint: { blockHash: Hash; blockNumber: bigint },
    label: string,
  ) {
    const knownHash = this.#blockHashesByNumber.get(fingerprint.blockNumber)
    const knownBlockNumber = this.#blockNumbersByHash.get(fingerprint.blockHash)
    if (
      (knownHash !== undefined && knownHash !== fingerprint.blockHash) ||
      (knownBlockNumber !== undefined &&
        knownBlockNumber !== fingerprint.blockNumber)
    ) {
      throw projectionError(`${label} block identity`)
    }
    for (const boundary of [this.#last, this.#confirmedThrough]) {
      if (
        boundary &&
        ((boundary.blockNumber === fingerprint.blockNumber &&
          boundary.blockHash !== fingerprint.blockHash) ||
          (boundary.blockHash === fingerprint.blockHash &&
            boundary.blockNumber !== fingerprint.blockNumber))
      ) {
        throw projectionError(`${label} block identity`)
      }
    }
  }

  #assertCompatiblePage(comments: readonly PublishedComment[]) {
    assertBlockIdentities(comments, 'page')
    assertTransactionHashesBelongToOneBlock(comments, 'page')
    for (const comment of comments) {
      this.#assertCompatibleBlock(comment, 'history')
      const knownBlockNumber = this.#transactionBlocksByHash.get(
        comment.transactionHash,
      )
      if (
        knownBlockNumber !== undefined &&
        knownBlockNumber !== comment.blockNumber
      ) {
        throw projectionError('history transaction block')
      }
    }
  }

  #retainCommentIdentity(comment: PublishedComment) {
    this.#blockHashesByNumber.set(comment.blockNumber, comment.blockHash)
    this.#blockNumbersByHash.set(comment.blockHash, comment.blockNumber)
    this.#transactionBlocksByHash.set(
      comment.transactionHash,
      comment.blockNumber,
    )
  }
}
