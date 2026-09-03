import {
  decodeEventLog,
  getAddress,
  padHex,
  size,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import type { EventLogFilter, IndexedEventLog } from './event-indexer'
import {
  getPostBodyByteLength,
  MAX_MEDIA_CID_BYTES,
  MAX_POST_BODY_BYTES,
  LIKE_SET_EVENT_ABI,
  LIKE_SET_TOPIC,
  POST_CONTENT_KIND,
  POST_PUBLISHED_EVENT_ABI,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
  REPOST_PUBLISHED_EVENT_ABI,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'

export const POST_CONTENT_KIND_TOPIC = padHex(toHex(POST_CONTENT_KIND), {
  size: 32,
})

export const POST_LIKE_SET_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [LIKE_SET_TOPIC, POST_CONTENT_KIND_TOPIC],
} as const satisfies EventLogFilter

export const PUBLISHED_REPOST_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [REPOST_PUBLISHED_TOPIC],
} as const satisfies EventLogFilter

export const PUBLISHED_POST_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [POST_PUBLISHED_TOPIC],
} as const satisfies EventLogFilter

export type PublishedPost = {
  author: Address
  blockHash: Hash
  blockNumber: bigint
  body: string
  logIndex: number
  mediaCid: Hex
  postId: bigint
  transactionHash: Hash
  transactionIndex: number
}

export type PostLikeSet = {
  account: Address
  blockHash: Hash
  blockNumber: bigint
  liked: boolean
  logIndex: number
  postId: bigint
  transactionHash: Hash
  transactionIndex: number
}

export type PublishedRepost = {
  account: Address
  blockHash: Hash
  blockNumber: bigint
  logIndex: number
  postId: bigint
  transactionHash: Hash
  transactionIndex: number
}

function invalidPostEvent() {
  return new Error('The chain returned an invalid PostPublished event.')
}

function invalidPostLikeEvent() {
  return new Error('The chain returned an invalid post LikeSet event.')
}

function invalidRepostEvent() {
  return new Error('The chain returned an invalid RepostPublished event.')
}

export function decodePublishedPost(
  log: IndexedEventLog,
): PublishedPost | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== POST_PUBLISHED_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 3) throw invalidPostEvent()
  try {
    const decoded = decodeEventLog({
      abi: POST_PUBLISHED_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { author, body, mediaCid, postId } = decoded.args
    const bodyLength = getPostBodyByteLength(body)
    const mediaCidLength = size(mediaCid)
    if (
      postId === 0n ||
      (bodyLength === 0 && mediaCidLength === 0) ||
      bodyLength > MAX_POST_BODY_BYTES ||
      mediaCidLength > MAX_MEDIA_CID_BYTES
    ) {
      throw invalidPostEvent()
    }
    return {
      author: getAddress(author),
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      body,
      logIndex: log.logIndex,
      mediaCid,
      postId,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidPostEvent()
  }
}

export function decodePostLikeSet(
  log: IndexedEventLog,
): PostLikeSet | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== LIKE_SET_TOPIC.toLowerCase() ||
    log.topics[1]?.toLowerCase() !== POST_CONTENT_KIND_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 4) throw invalidPostLikeEvent()
  try {
    if (size(log.data) !== 32) throw invalidPostLikeEvent()
    const decoded = decodeEventLog({
      abi: LIKE_SET_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { account, contentId, contentKind, liked } = decoded.args
    const normalizedAccount = getAddress(account)
    if (
      contentKind !== POST_CONTENT_KIND ||
      contentId === 0n ||
      log.topics[2]?.toLowerCase() !==
        padHex(toHex(contentId), { size: 32 }).toLowerCase() ||
      log.topics[3]?.toLowerCase() !==
        padHex(normalizedAccount, { size: 32 }).toLowerCase()
    ) {
      throw invalidPostLikeEvent()
    }
    return {
      account: normalizedAccount,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      liked,
      logIndex: log.logIndex,
      postId: contentId,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidPostLikeEvent()
  }
}

export function decodePublishedRepost(
  log: IndexedEventLog,
): PublishedRepost | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== REPOST_PUBLISHED_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 3 || log.data !== '0x') {
    throw invalidRepostEvent()
  }
  try {
    const decoded = decodeEventLog({
      abi: REPOST_PUBLISHED_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { account, postId } = decoded.args
    const normalizedAccount = getAddress(account)
    if (
      postId === 0n ||
      log.topics[1]?.toLowerCase() !==
        padHex(toHex(postId), { size: 32 }).toLowerCase() ||
      log.topics[2]?.toLowerCase() !==
        padHex(normalizedAccount, { size: 32 }).toLowerCase()
    ) {
      throw invalidRepostEvent()
    }
    return {
      account: normalizedAccount,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      postId,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidRepostEvent()
  }
}
