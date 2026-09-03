import { getAddress, isAddress, type Address, type Hash } from 'viem'
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

type DecodedPage<Event> = {
  events: readonly Event[]
  last?: PostReactionProjectionPosition
}

function projectionError(message: string) {
  return new Error(`Invalid post reaction projection ${message}.`)
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

export class PostReactionProjection {
  readonly #activeLikes = new Set<string>()
  readonly #likeCounts = new Map<string, bigint>()
  readonly #repostCounts = new Map<string, bigint>()
  #lastLike?: PostReactionProjectionPosition
  #lastRepost?: PostReactionProjectionPosition

  get progress(): PostReactionProjectionProgress {
    return {
      likes: this.#lastLike ? copyPosition(this.#lastLike) : undefined,
      reposts: this.#lastRepost ? copyPosition(this.#lastRepost) : undefined,
    }
  }

  reset() {
    this.#activeLikes.clear()
    this.#likeCounts.clear()
    this.#repostCounts.clear()
    this.#lastLike = undefined
    this.#lastRepost = undefined
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
    for (const [likeKey, liked] of activeChanges) {
      if (liked) this.#activeLikes.add(likeKey)
      else this.#activeLikes.delete(likeKey)
    }
    for (const [postKey, count] of countChanges) {
      if (count === 0n) this.#likeCounts.delete(postKey)
      else this.#likeCounts.set(postKey, count)
    }
    if (page.last) this.#lastLike = page.last
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
    for (const [postKey, count] of countChanges) {
      this.#repostCounts.set(postKey, count)
    }
    if (page.last) this.#lastRepost = page.last
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
