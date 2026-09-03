import {
  decodeEventLog,
  getAddress,
  size,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import type { EventLogFilter, IndexedEventLog } from './event-indexer'
import {
  getPostBodyByteLength,
  MAX_MEDIA_CID_BYTES,
  MAX_POST_BODY_BYTES,
  POST_PUBLISHED_EVENT_ABI,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
} from './protocol'

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

function invalidPostEvent() {
  return new Error('The chain returned an invalid PostPublished event.')
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
