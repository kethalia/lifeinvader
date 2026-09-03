import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import type { IndexedEventLog } from './event-indexer'
import { decodePublishedPost } from './protocol-events'
import { POST_PUBLISHED_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const AUTHOR = '0x000000000000000000000000000000000000b0b0' as Address
const DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const

function postLog(
  options: {
    body?: string
    data?: Hex
    mediaCid?: Hex
    postId?: bigint
    topic?: Hex
  } = {},
): IndexedEventLog {
  const body = options.body ?? 'Privacy was a bug.'
  const mediaCid = options.mediaCid ?? '0x01701220'
  const postId = options.postId ?? 7n
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: keccak256(stringToHex('block')),
    blockNumber: 12n,
    data:
      options.data ?? encodeAbiParameters(DATA_PARAMETERS, [body, mediaCid]),
    logIndex: 2,
    topics: [
      options.topic ?? POST_PUBLISHED_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(AUTHOR, { size: 32 }),
    ],
    transactionHash: keccak256(stringToHex('transaction')),
    transactionIndex: 1,
  }
}

describe('PostPublished decoding', () => {
  it('decodes indexed identity and bounded publication data', () => {
    expect(decodePublishedPost(postLog())).toEqual({
      author: AUTHOR,
      blockHash: keccak256(stringToHex('block')),
      blockNumber: 12n,
      body: 'Privacy was a bug.',
      logIndex: 2,
      mediaCid: '0x01701220',
      postId: 7n,
      transactionHash: keccak256(stringToHex('transaction')),
      transactionIndex: 1,
    })
  })

  it('ignores another event family', () => {
    expect(
      decodePublishedPost(
        postLog({ topic: keccak256(stringToHex('AnotherEvent()')) }),
      ),
    ).toBeUndefined()
  })

  it('ignores the same signature from another contract', () => {
    expect(
      decodePublishedPost({
        ...postLog(),
        address: AUTHOR,
      }),
    ).toBeUndefined()
  })

  it('rejects surplus indexed topics on the matching event family', () => {
    const log = postLog()
    expect(() =>
      decodePublishedPost({
        ...log,
        topics: [...log.topics, keccak256(stringToHex('surplus'))],
      }),
    ).toThrow(/invalid PostPublished/i)
  })

  it.each([
    ['malformed ABI data', postLog({ data: '0x01' })],
    ['zero post identifier', postLog({ postId: 0n })],
    ['empty publication', postLog({ body: '', mediaCid: '0x' })],
    ['oversized body', postLog({ body: 'x'.repeat(4_097) })],
    [
      'oversized media CID',
      postLog({ mediaCid: `0x${'00'.repeat(129)}` as Hex }),
    ],
  ])('rejects %s', (_description, log) => {
    expect(() => decodePublishedPost(log)).toThrow(/invalid PostPublished/i)
  })
})
