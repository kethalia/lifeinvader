import { type Hash } from 'viem'
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

export const MAX_POST_COMMENT_PROJECTION_PAGE_LOGS = 5_199
export const MAX_POST_COMMENT_PROJECTION_POSTS = 50
export const POST_COMMENT_PROJECTION_READ_PAGE_SIZE = 50
export const MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE = 200

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

function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  return first.logIndex - second.logIndex
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

function normalizeCheckpoint(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw projectionError('confirmation')
  }
  const checkpoint = value as Record<string, unknown>
  if (
    typeof checkpoint.blockNumber !== 'bigint' ||
    checkpoint.blockNumber < 0n ||
    checkpoint.blockNumber > MAX_UINT256 ||
    typeof checkpoint.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(checkpoint.blockHash)
  ) {
    throw projectionError('confirmation')
  }
  return {
    blockHash: checkpoint.blockHash.toLowerCase() as Hash,
    blockNumber: checkpoint.blockNumber,
  }
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
  readonly #comments = new Map<string, PublishedComment[]>()
  readonly #postIds: readonly bigint[]
  readonly #tracked = new Set<string>()
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
    for (const [key, comments] of retained) {
      const existing = this.#comments.get(key)
      if (existing) existing.push(...comments)
      else this.#comments.set(key, [...comments])
      this.#retainedCommentCount += BigInt(comments.length)
    }
    this.#commentCount += BigInt(page.comments.length)
    if (page.last) this.#last = page.last
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
    this.#comments.clear()
    this.#commentCount = 0n
    this.#confirmedThrough = undefined
    this.#last = undefined
    this.#retainedCommentCount = 0n
  }
}
