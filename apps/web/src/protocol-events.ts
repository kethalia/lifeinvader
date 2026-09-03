import {
  decodeEventLog,
  encodeAbiParameters,
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
  COMMENT_PUBLISHED_EVENT_ABI,
  COMMENT_PUBLISHED_TOPIC,
  getPostBodyByteLength,
  getUtf8ByteLength,
  MAX_MEDIA_CID_BYTES,
  MAX_POST_BODY_BYTES,
  MAX_PROFILE_BIO_BYTES,
  MAX_PROFILE_DISPLAY_NAME_BYTES,
  LIKE_SET_EVENT_ABI,
  LIKE_SET_TOPIC,
  POST_CONTENT_KIND,
  POST_PUBLISHED_EVENT_ABI,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
  PROFILE_SET_EVENT_ABI,
  PROFILE_SET_TOPIC,
  REPOST_PUBLISHED_EVENT_ABI,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'

const PUBLICATION_DATA_PARAMETERS = [
  { type: 'string' },
  { type: 'bytes' },
] as const

const PROFILE_DATA_PARAMETERS = [
  { type: 'string' },
  { type: 'string' },
  { type: 'bytes' },
] as const

export const POST_CONTENT_KIND_TOPIC = padHex(toHex(POST_CONTENT_KIND), {
  size: 32,
})

export const POST_LIKE_SET_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [LIKE_SET_TOPIC, POST_CONTENT_KIND_TOPIC],
} as const satisfies EventLogFilter

export const PUBLISHED_COMMENT_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [COMMENT_PUBLISHED_TOPIC],
} as const satisfies EventLogFilter

export const PUBLISHED_REPOST_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [REPOST_PUBLISHED_TOPIC],
} as const satisfies EventLogFilter

export const PUBLISHED_POST_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [POST_PUBLISHED_TOPIC],
} as const satisfies EventLogFilter

export const PROFILE_SET_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [PROFILE_SET_TOPIC],
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

export type PublishedComment = {
  author: Address
  blockHash: Hash
  blockNumber: bigint
  body: string
  commentId: bigint
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

export type ProfileSet = {
  account: Address
  avatarCid: Hex
  bio: string
  blockHash: Hash
  blockNumber: bigint
  displayName: string
  logIndex: number
  transactionHash: Hash
  transactionIndex: number
}

function invalidPostEvent() {
  return new Error('The chain returned an invalid PostPublished event.')
}

function invalidCommentEvent() {
  return new Error('The chain returned an invalid CommentPublished event.')
}

function invalidPostLikeEvent() {
  return new Error('The chain returned an invalid post LikeSet event.')
}

function invalidRepostEvent() {
  return new Error('The chain returned an invalid RepostPublished event.')
}

function invalidProfileEvent() {
  return new Error('The chain returned an invalid ProfileSet event.')
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

export function decodePublishedComment(
  log: IndexedEventLog,
): PublishedComment | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== COMMENT_PUBLISHED_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 4) throw invalidCommentEvent()
  try {
    const decoded = decodeEventLog({
      abi: COMMENT_PUBLISHED_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { author, body, commentId, mediaCid, postId } = decoded.args
    const normalizedAuthor = getAddress(author)
    const bodyLength = getPostBodyByteLength(body)
    const mediaCidLength = size(mediaCid)
    if (
      commentId === 0n ||
      postId === 0n ||
      (bodyLength === 0 && mediaCidLength === 0) ||
      bodyLength > MAX_POST_BODY_BYTES ||
      mediaCidLength > MAX_MEDIA_CID_BYTES ||
      log.data.toLowerCase() !==
        encodeAbiParameters(PUBLICATION_DATA_PARAMETERS, [
          body,
          mediaCid,
        ]).toLowerCase() ||
      log.topics[1]?.toLowerCase() !==
        padHex(toHex(commentId), { size: 32 }).toLowerCase() ||
      log.topics[2]?.toLowerCase() !==
        padHex(toHex(postId), { size: 32 }).toLowerCase() ||
      log.topics[3]?.toLowerCase() !==
        padHex(normalizedAuthor, { size: 32 }).toLowerCase()
    ) {
      throw invalidCommentEvent()
    }
    return {
      author: normalizedAuthor,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      body,
      commentId,
      logIndex: log.logIndex,
      mediaCid,
      postId,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidCommentEvent()
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

export function decodeProfileSet(log: IndexedEventLog): ProfileSet | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== PROFILE_SET_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 2) throw invalidProfileEvent()
  try {
    const decoded = decodeEventLog({
      abi: PROFILE_SET_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { account, avatarCid, bio, displayName } = decoded.args
    const normalizedAccount = getAddress(account)
    if (
      getUtf8ByteLength(displayName) > MAX_PROFILE_DISPLAY_NAME_BYTES ||
      getUtf8ByteLength(bio) > MAX_PROFILE_BIO_BYTES ||
      size(avatarCid) > MAX_MEDIA_CID_BYTES ||
      log.data.toLowerCase() !==
        encodeAbiParameters(PROFILE_DATA_PARAMETERS, [
          displayName,
          bio,
          avatarCid,
        ]).toLowerCase() ||
      log.topics[1]?.toLowerCase() !==
        padHex(normalizedAccount, { size: 32 }).toLowerCase()
    ) {
      throw invalidProfileEvent()
    }
    return {
      account: normalizedAccount,
      avatarCid,
      bio,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      displayName,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidProfileEvent()
  }
}
