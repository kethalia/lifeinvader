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
  DIRECT_MESSAGE_SENT_EVENT_ABI,
  DIRECT_MESSAGE_SENT_TOPIC,
  GROUP_CREATED_EVENT_ABI,
  GROUP_CREATED_TOPIC,
  GROUP_MEMBERSHIP_SET_EVENT_ABI,
  GROUP_MEMBERSHIP_SET_TOPIC,
  GROUP_MESSAGE_SENT_EVENT_ABI,
  GROUP_MESSAGE_SENT_TOPIC,
  getDirectConversationId,
  getPostBodyByteLength,
  getUtf8ByteLength,
  MAX_GROUP_NAME_BYTES,
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

const DIRECT_MESSAGE_DATA_PARAMETERS = [
  { type: 'uint256' },
  { type: 'string' },
  { type: 'bytes' },
] as const

const GROUP_CREATED_DATA_PARAMETERS = [
  { type: 'string' },
  { type: 'bytes' },
] as const

const GROUP_MEMBERSHIP_DATA_PARAMETERS = [{ type: 'bool' }] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MAX_UINT256 = (1n << 256n) - 1n

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

export const DIRECT_MESSAGE_SENT_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [DIRECT_MESSAGE_SENT_TOPIC],
} as const satisfies EventLogFilter

export const GROUP_CREATED_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [GROUP_CREATED_TOPIC],
} as const satisfies EventLogFilter

export const GROUP_MEMBERSHIP_SET_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [GROUP_MEMBERSHIP_SET_TOPIC],
} as const satisfies EventLogFilter

export const GROUP_MESSAGE_SENT_FILTER = {
  address: PROTOCOL_ADDRESS,
  topics: [GROUP_MESSAGE_SENT_TOPIC],
} as const satisfies EventLogFilter

function getGroupIdTopic(groupId: bigint) {
  if (groupId < 1n || groupId > MAX_UINT256) {
    throw new Error('The selected group identifier is invalid.')
  }
  return padHex(toHex(groupId), { size: 32 })
}

export function getGroupMembershipFilter(groupId: bigint): EventLogFilter {
  return {
    address: PROTOCOL_ADDRESS,
    topics: [GROUP_MEMBERSHIP_SET_TOPIC, getGroupIdTopic(groupId)],
  }
}

export function getGroupMessageFilter(groupId: bigint): EventLogFilter {
  return {
    address: PROTOCOL_ADDRESS,
    topics: [GROUP_MESSAGE_SENT_TOPIC, getGroupIdTopic(groupId)],
  }
}

export function getDirectMessageConversationFilter(
  firstAccount: Address,
  secondAccount: Address,
): EventLogFilter {
  return {
    address: PROTOCOL_ADDRESS,
    topics: [
      DIRECT_MESSAGE_SENT_TOPIC,
      getDirectConversationId(firstAccount, secondAccount),
    ],
  }
}

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

export type PublishedDirectMessage = {
  blockHash: Hash
  blockNumber: bigint
  body: string
  conversationId: Hash
  logIndex: number
  mediaCid: Hex
  messageId: bigint
  recipient: Address
  sender: Address
  transactionHash: Hash
  transactionIndex: number
}

export type PublishedGroup = {
  blockHash: Hash
  blockNumber: bigint
  creator: Address
  groupId: bigint
  logIndex: number
  metadataCid: Hex
  name: string
  transactionHash: Hash
  transactionIndex: number
}

export type GroupMembershipSet = {
  account: Address
  blockHash: Hash
  blockNumber: bigint
  groupId: bigint
  joined: boolean
  logIndex: number
  transactionHash: Hash
  transactionIndex: number
}

export type PublishedGroupMessage = {
  blockHash: Hash
  blockNumber: bigint
  body: string
  groupId: bigint
  logIndex: number
  mediaCid: Hex
  messageId: bigint
  sender: Address
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

function invalidDirectMessageEvent() {
  return new Error('The chain returned an invalid DirectMessageSent event.')
}

function invalidGroupCreatedEvent() {
  return new Error('The chain returned an invalid GroupCreated event.')
}

function invalidGroupMembershipEvent() {
  return new Error('The chain returned an invalid GroupMembershipSet event.')
}

function invalidGroupMessageEvent() {
  return new Error('The chain returned an invalid GroupMessageSent event.')
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

export function decodePublishedDirectMessage(
  log: IndexedEventLog,
): PublishedDirectMessage | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== DIRECT_MESSAGE_SENT_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 4) throw invalidDirectMessageEvent()
  try {
    const decoded = decodeEventLog({
      abi: DIRECT_MESSAGE_SENT_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { body, conversationId, mediaCid, messageId, recipient, sender } =
      decoded.args
    const normalizedSender = getAddress(sender)
    const normalizedRecipient = getAddress(recipient)
    const canonicalConversationId = getDirectConversationId(
      normalizedSender,
      normalizedRecipient,
    )
    const bodyLength = getPostBodyByteLength(body)
    const mediaCidLength = size(mediaCid)
    if (
      messageId === 0n ||
      normalizedSender.toLowerCase() === ZERO_ADDRESS ||
      normalizedRecipient.toLowerCase() === ZERO_ADDRESS ||
      (bodyLength === 0 && mediaCidLength === 0) ||
      bodyLength > MAX_POST_BODY_BYTES ||
      mediaCidLength > MAX_MEDIA_CID_BYTES ||
      conversationId.toLowerCase() !== canonicalConversationId.toLowerCase() ||
      log.data.toLowerCase() !==
        encodeAbiParameters(DIRECT_MESSAGE_DATA_PARAMETERS, [
          messageId,
          body,
          mediaCid,
        ]).toLowerCase() ||
      log.topics[1]?.toLowerCase() !== canonicalConversationId.toLowerCase() ||
      log.topics[2]?.toLowerCase() !==
        padHex(normalizedSender, { size: 32 }).toLowerCase() ||
      log.topics[3]?.toLowerCase() !==
        padHex(normalizedRecipient, { size: 32 }).toLowerCase()
    ) {
      throw invalidDirectMessageEvent()
    }
    return {
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      body,
      conversationId: canonicalConversationId,
      logIndex: log.logIndex,
      mediaCid,
      messageId,
      recipient: normalizedRecipient,
      sender: normalizedSender,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidDirectMessageEvent()
  }
}

export function decodePublishedGroup(
  log: IndexedEventLog,
): PublishedGroup | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== GROUP_CREATED_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 3) throw invalidGroupCreatedEvent()
  try {
    const decoded = decodeEventLog({
      abi: GROUP_CREATED_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { creator, groupId, metadataCid, name } = decoded.args
    const normalizedCreator = getAddress(creator)
    const nameLength = getUtf8ByteLength(name)
    if (
      groupId === 0n ||
      normalizedCreator.toLowerCase() === ZERO_ADDRESS ||
      nameLength === 0 ||
      nameLength > MAX_GROUP_NAME_BYTES ||
      size(metadataCid) > MAX_MEDIA_CID_BYTES ||
      log.data.toLowerCase() !==
        encodeAbiParameters(GROUP_CREATED_DATA_PARAMETERS, [
          name,
          metadataCid,
        ]).toLowerCase() ||
      log.topics[1]?.toLowerCase() !== getGroupIdTopic(groupId).toLowerCase() ||
      log.topics[2]?.toLowerCase() !==
        padHex(normalizedCreator, { size: 32 }).toLowerCase()
    ) {
      throw invalidGroupCreatedEvent()
    }
    return {
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      creator: normalizedCreator,
      groupId,
      logIndex: log.logIndex,
      metadataCid,
      name,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidGroupCreatedEvent()
  }
}

export function decodeGroupMembershipSet(
  log: IndexedEventLog,
): GroupMembershipSet | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== GROUP_MEMBERSHIP_SET_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 3) throw invalidGroupMembershipEvent()
  try {
    const decoded = decodeEventLog({
      abi: GROUP_MEMBERSHIP_SET_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { account, groupId, joined } = decoded.args
    const normalizedAccount = getAddress(account)
    if (
      groupId === 0n ||
      normalizedAccount.toLowerCase() === ZERO_ADDRESS ||
      log.data.toLowerCase() !==
        encodeAbiParameters(GROUP_MEMBERSHIP_DATA_PARAMETERS, [
          joined,
        ]).toLowerCase() ||
      log.topics[1]?.toLowerCase() !== getGroupIdTopic(groupId).toLowerCase() ||
      log.topics[2]?.toLowerCase() !==
        padHex(normalizedAccount, { size: 32 }).toLowerCase()
    ) {
      throw invalidGroupMembershipEvent()
    }
    return {
      account: normalizedAccount,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      groupId,
      joined,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidGroupMembershipEvent()
  }
}

export function decodePublishedGroupMessage(
  log: IndexedEventLog,
): PublishedGroupMessage | undefined {
  if (
    log.address.toLowerCase() !== PROTOCOL_ADDRESS.toLowerCase() ||
    log.topics[0]?.toLowerCase() !== GROUP_MESSAGE_SENT_TOPIC.toLowerCase()
  ) {
    return undefined
  }
  if (log.topics.length !== 4) throw invalidGroupMessageEvent()
  try {
    const decoded = decodeEventLog({
      abi: GROUP_MESSAGE_SENT_EVENT_ABI,
      data: log.data,
      strict: true,
      topics: log.topics as [Hex, ...Hex[]],
    })
    const { body, groupId, mediaCid, messageId, sender } = decoded.args
    const normalizedSender = getAddress(sender)
    const bodyLength = getPostBodyByteLength(body)
    const mediaCidLength = size(mediaCid)
    if (
      groupId === 0n ||
      messageId === 0n ||
      normalizedSender.toLowerCase() === ZERO_ADDRESS ||
      (bodyLength === 0 && mediaCidLength === 0) ||
      bodyLength > MAX_POST_BODY_BYTES ||
      mediaCidLength > MAX_MEDIA_CID_BYTES ||
      log.data.toLowerCase() !==
        encodeAbiParameters(PUBLICATION_DATA_PARAMETERS, [
          body,
          mediaCid,
        ]).toLowerCase() ||
      log.topics[1]?.toLowerCase() !== getGroupIdTopic(groupId).toLowerCase() ||
      log.topics[2]?.toLowerCase() !==
        padHex(normalizedSender, { size: 32 }).toLowerCase() ||
      log.topics[3]?.toLowerCase() !==
        padHex(toHex(messageId), { size: 32 }).toLowerCase()
    ) {
      throw invalidGroupMessageEvent()
    }
    return {
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      body,
      groupId,
      logIndex: log.logIndex,
      mediaCid,
      messageId,
      sender: normalizedSender,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }
  } catch {
    throw invalidGroupMessageEvent()
  }
}
