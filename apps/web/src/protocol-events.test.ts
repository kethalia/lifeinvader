import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import type { IndexedEventLog } from './event-indexer'
import {
  decodePublishedDirectMessage,
  decodeProfileSet,
  decodePostLikeSet,
  decodePublishedComment,
  decodePublishedPost,
  decodePublishedRepost,
  DIRECT_MESSAGE_SENT_FILTER,
  getDirectMessageConversationFilter,
  POST_CONTENT_KIND_TOPIC,
  POST_LIKE_SET_FILTER,
  PROFILE_SET_FILTER,
  PUBLISHED_COMMENT_FILTER,
  PUBLISHED_REPOST_FILTER,
} from './protocol-events'
import {
  COMMENT_PUBLISHED_TOPIC,
  DIRECT_MESSAGE_SENT_TOPIC,
  getDirectConversationId,
  LIKE_SET_TOPIC,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
  PROFILE_SET_TOPIC,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'

const AUTHOR = '0x000000000000000000000000000000000000b0b0' as Address
const ACCOUNT = '0x000000000000000000000000000000000000c0c0' as Address
const RECIPIENT = '0x000000000000000000000000000000000000d0d0' as Address
const DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const LIKE_DATA_PARAMETERS = [{ type: 'bool' }] as const
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

function likeLog(
  options: {
    accountTopic?: Hex
    contentKindTopic?: Hex
    data?: Hex
    liked?: boolean
    postId?: bigint
    topic?: Hex
    topics?: readonly Hex[]
  } = {},
): IndexedEventLog {
  const postId = options.postId ?? 7n
  return {
    ...postLog(),
    data:
      options.data ??
      encodeAbiParameters(LIKE_DATA_PARAMETERS, [options.liked ?? true]),
    topics: options.topics ?? [
      options.topic ?? LIKE_SET_TOPIC,
      options.contentKindTopic ?? POST_CONTENT_KIND_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      options.accountTopic ?? padHex(ACCOUNT, { size: 32 }),
    ],
  }
}

function commentLog(
  options: {
    authorTopic?: Hex
    body?: string
    commentId?: bigint
    data?: Hex
    mediaCid?: Hex
    postId?: bigint
    topic?: Hex
    topics?: readonly Hex[]
  } = {},
): IndexedEventLog {
  const body = options.body ?? 'Privacy is still a bug.'
  const commentId = options.commentId ?? 11n
  const mediaCid = options.mediaCid ?? '0x01701220'
  const postId = options.postId ?? 7n
  return {
    ...postLog(),
    data:
      options.data ?? encodeAbiParameters(DATA_PARAMETERS, [body, mediaCid]),
    topics: options.topics ?? [
      options.topic ?? COMMENT_PUBLISHED_TOPIC,
      padHex(toHex(commentId), { size: 32 }),
      padHex(toHex(postId), { size: 32 }),
      options.authorTopic ?? padHex(AUTHOR, { size: 32 }),
    ],
  }
}

function repostLog(
  options: {
    accountTopic?: Hex
    data?: Hex
    postId?: bigint
    topic?: Hex
    topics?: readonly Hex[]
  } = {},
): IndexedEventLog {
  const postId = options.postId ?? 7n
  return {
    ...postLog(),
    data: options.data ?? '0x',
    topics: options.topics ?? [
      options.topic ?? REPOST_PUBLISHED_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      options.accountTopic ?? padHex(ACCOUNT, { size: 32 }),
    ],
  }
}

function profileLog(
  options: {
    accountTopic?: Hex
    avatarCid?: Hex
    bio?: string
    data?: Hex
    displayName?: string
    topic?: Hex
    topics?: readonly Hex[]
  } = {},
): IndexedEventLog {
  const avatarCid = options.avatarCid ?? '0x01701220'
  const bio = options.bio ?? 'Deliberately public since block one.'
  const displayName = options.displayName ?? 'Tracey'
  return {
    ...postLog(),
    data:
      options.data ??
      encodeAbiParameters(PROFILE_DATA_PARAMETERS, [
        displayName,
        bio,
        avatarCid,
      ]),
    topics: options.topics ?? [
      options.topic ?? PROFILE_SET_TOPIC,
      options.accountTopic ?? padHex(ACCOUNT, { size: 32 }),
    ],
  }
}

function directMessageLog(
  options: {
    body?: string
    conversationTopic?: Hex
    data?: Hex
    mediaCid?: Hex
    messageId?: bigint
    recipient?: Address
    recipientTopic?: Hex
    sender?: Address
    senderTopic?: Hex
    topic?: Hex
    topics?: readonly Hex[]
  } = {},
): IndexedEventLog {
  const body = options.body ?? 'This direct message is public.'
  const mediaCid = options.mediaCid ?? '0x01701220'
  const messageId = options.messageId ?? 13n
  const recipient = options.recipient ?? RECIPIENT
  const sender = options.sender ?? AUTHOR
  const conversationId = getDirectConversationId(sender, recipient)
  return {
    ...postLog(),
    data:
      options.data ??
      encodeAbiParameters(DIRECT_MESSAGE_DATA_PARAMETERS, [
        messageId,
        body,
        mediaCid,
      ]),
    topics: options.topics ?? [
      options.topic ?? DIRECT_MESSAGE_SENT_TOPIC,
      options.conversationTopic ?? conversationId,
      options.senderTopic ?? padHex(sender, { size: 32 }),
      options.recipientTopic ?? padHex(recipient, { size: 32 }),
    ],
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

describe('ProfileSet decoding', () => {
  it('decodes a complete bounded profile snapshot', () => {
    expect(decodeProfileSet(profileLog())).toEqual({
      account: getAddress(ACCOUNT),
      avatarCid: '0x01701220',
      bio: 'Deliberately public since block one.',
      blockHash: keccak256(stringToHex('block')),
      blockNumber: 12n,
      displayName: 'Tracey',
      logIndex: 2,
      transactionHash: keccak256(stringToHex('transaction')),
      transactionIndex: 1,
    })
  })

  it('accepts the all-empty snapshot used to clear a profile', () => {
    expect(
      decodeProfileSet(
        profileLog({ avatarCid: '0x', bio: '', displayName: '' }),
      ),
    ).toMatchObject({ avatarCid: '0x', bio: '', displayName: '' })
  })

  it.each([
    ['another event family', profileLog({ topic: POST_PUBLISHED_TOPIC })],
    [
      'the same signature from another contract',
      { ...profileLog(), address: AUTHOR },
    ],
  ])('ignores %s', (_description, log) => {
    expect(decodeProfileSet(log)).toBeUndefined()
  })

  it.each([
    ['missing indexed topics', profileLog({ topics: [PROFILE_SET_TOPIC] })],
    [
      'surplus indexed topics',
      profileLog({
        topics: [...profileLog().topics, keccak256(stringToHex('surplus'))],
      }),
    ],
    [
      'oversized UTF-8 display name',
      profileLog({ displayName: '🫥'.repeat(17) }),
    ],
    ['oversized UTF-8 bio', profileLog({ bio: '🫥'.repeat(257) })],
    [
      'oversized avatar CID',
      profileLog({ avatarCid: `0x${'00'.repeat(129)}` as Hex }),
    ],
    [
      'non-canonical account padding',
      profileLog({ accountTopic: `0x01${'00'.repeat(31)}` }),
    ],
    ['malformed ABI data', profileLog({ data: '0x01' })],
    [
      'surplus ABI data',
      profileLog({
        data: `${profileLog().data}${'00'.repeat(32)}` as Hex,
      }),
    ],
  ])('rejects %s', (_description, log) => {
    expect(() => decodeProfileSet(log)).toThrow(/invalid ProfileSet/i)
  })

  it('uses one global event-family filter', () => {
    expect(PROFILE_SET_FILTER).toEqual({
      address: PROTOCOL_ADDRESS,
      topics: [PROFILE_SET_TOPIC],
    })
  })
})

describe('CommentPublished decoding', () => {
  it('decodes both identifiers, author, and bounded publication data', () => {
    expect(decodePublishedComment(commentLog())).toEqual({
      author: AUTHOR,
      blockHash: keccak256(stringToHex('block')),
      blockNumber: 12n,
      body: 'Privacy is still a bug.',
      commentId: 11n,
      logIndex: 2,
      mediaCid: '0x01701220',
      postId: 7n,
      transactionHash: keccak256(stringToHex('transaction')),
      transactionIndex: 1,
    })
  })

  it.each([
    ['another event family', commentLog({ topic: POST_PUBLISHED_TOPIC })],
    [
      'the same signature from another contract',
      { ...commentLog(), address: AUTHOR },
    ],
  ])('ignores %s', (_description, log) => {
    expect(decodePublishedComment(log)).toBeUndefined()
  })

  it.each([
    [
      'missing indexed topics',
      commentLog({ topics: [COMMENT_PUBLISHED_TOPIC] }),
    ],
    [
      'surplus indexed topics',
      commentLog({
        topics: [...commentLog().topics, keccak256(stringToHex('surplus'))],
      }),
    ],
    ['zero comment identifier', commentLog({ commentId: 0n })],
    ['zero post identifier', commentLog({ postId: 0n })],
    ['empty publication', commentLog({ body: '', mediaCid: '0x' })],
    ['oversized body', commentLog({ body: 'x'.repeat(4_097) })],
    [
      'oversized media CID',
      commentLog({ mediaCid: `0x${'00'.repeat(129)}` as Hex }),
    ],
    [
      'non-canonical author padding',
      commentLog({ authorTopic: `0x01${'00'.repeat(31)}` }),
    ],
    ['malformed ABI data', commentLog({ data: '0x01' })],
    [
      'surplus ABI data',
      commentLog({
        data: `${commentLog().data}${'00'.repeat(32)}` as Hex,
      }),
    ],
  ])('rejects %s', (_description, log) => {
    expect(() => decodePublishedComment(log)).toThrow(
      /invalid CommentPublished/i,
    )
  })
})

describe('post reaction filters', () => {
  it('keeps all comments in one independent global RPC filter', () => {
    expect(PUBLISHED_COMMENT_FILTER).toEqual({
      address: PROTOCOL_ADDRESS,
      topics: [COMMENT_PUBLISHED_TOPIC],
    })
  })

  it('isolates post likes from comment likes in the RPC filter', () => {
    expect(POST_LIKE_SET_FILTER).toEqual({
      address: PROTOCOL_ADDRESS,
      topics: [LIKE_SET_TOPIC, `0x${'00'.repeat(32)}`],
    })
  })

  it('keeps reposts in an independent RPC filter', () => {
    expect(PUBLISHED_REPOST_FILTER).toEqual({
      address: PROTOCOL_ADDRESS,
      topics: [REPOST_PUBLISHED_TOPIC],
    })
  })
})

describe('post LikeSet decoding', () => {
  it.each([true, false])('decodes a canonical liked=%s signal', (liked) => {
    expect(decodePostLikeSet(likeLog({ liked }))).toEqual({
      account: getAddress(ACCOUNT),
      blockHash: keccak256(stringToHex('block')),
      blockNumber: 12n,
      liked,
      logIndex: 2,
      postId: 7n,
      transactionHash: keccak256(stringToHex('transaction')),
      transactionIndex: 1,
    })
  })

  it.each([
    ['another event family', likeLog({ topic: REPOST_PUBLISHED_TOPIC })],
    [
      'a comment-like signal',
      likeLog({ contentKindTopic: padHex(toHex(1), { size: 32 }) }),
    ],
    [
      'the same signature from another contract',
      { ...likeLog(), address: AUTHOR },
    ],
  ])('ignores %s', (_description, log) => {
    expect(decodePostLikeSet(log)).toBeUndefined()
  })

  it.each([
    [
      'missing indexed topics',
      likeLog({ topics: [LIKE_SET_TOPIC, POST_CONTENT_KIND_TOPIC] }),
    ],
    [
      'surplus indexed topics',
      likeLog({
        topics: [...likeLog().topics, keccak256(stringToHex('surplus'))],
      }),
    ],
    ['zero post identifier', likeLog({ postId: 0n })],
    ['missing boolean data', likeLog({ data: '0x' })],
    ['surplus boolean data', likeLog({ data: `0x${'00'.repeat(64)}` as Hex })],
    [
      'non-canonical boolean data',
      likeLog({ data: padHex(toHex(2), { size: 32 }) }),
    ],
    [
      'non-canonical account padding',
      likeLog({ accountTopic: `0x01${'00'.repeat(31)}` }),
    ],
    ['odd-length ABI data', likeLog({ data: '0x0' })],
    ['malformed account topic', likeLog({ accountTopic: '0x01' })],
  ])('rejects %s', (_description, log) => {
    expect(() => decodePostLikeSet(log)).toThrow(/invalid post LikeSet/i)
  })
})

describe('RepostPublished decoding', () => {
  it('decodes a canonical repost identity', () => {
    expect(decodePublishedRepost(repostLog())).toEqual({
      account: getAddress(ACCOUNT),
      blockHash: keccak256(stringToHex('block')),
      blockNumber: 12n,
      logIndex: 2,
      postId: 7n,
      transactionHash: keccak256(stringToHex('transaction')),
      transactionIndex: 1,
    })
  })

  it.each([
    ['another event family', repostLog({ topic: LIKE_SET_TOPIC })],
    [
      'the same signature from another contract',
      { ...repostLog(), address: AUTHOR },
    ],
  ])('ignores %s', (_description, log) => {
    expect(decodePublishedRepost(log)).toBeUndefined()
  })

  it.each([
    ['missing indexed topics', repostLog({ topics: [REPOST_PUBLISHED_TOPIC] })],
    [
      'surplus indexed topics',
      repostLog({
        topics: [...repostLog().topics, keccak256(stringToHex('surplus'))],
      }),
    ],
    ['zero post identifier', repostLog({ postId: 0n })],
    [
      'unexpected ABI data',
      repostLog({ data: padHex(toHex(1), { size: 32 }) }),
    ],
    [
      'non-canonical account padding',
      repostLog({ accountTopic: `0x01${'00'.repeat(31)}` }),
    ],
    ['malformed account topic', repostLog({ accountTopic: '0x01' })],
  ])('rejects %s', (_description, log) => {
    expect(() => decodePublishedRepost(log)).toThrow(/invalid RepostPublished/i)
  })
})

describe('DirectMessageSent decoding', () => {
  it('decodes a canonical deliberately public direct message', () => {
    expect(decodePublishedDirectMessage(directMessageLog())).toEqual({
      blockHash: keccak256(stringToHex('block')),
      blockNumber: 12n,
      body: 'This direct message is public.',
      conversationId: getDirectConversationId(AUTHOR, RECIPIENT),
      logIndex: 2,
      mediaCid: '0x01701220',
      messageId: 13n,
      recipient: getAddress(RECIPIENT),
      sender: getAddress(AUTHOR),
      transactionHash: keccak256(stringToHex('transaction')),
      transactionIndex: 1,
    })
  })

  it.each([
    ['another event family', directMessageLog({ topic: POST_PUBLISHED_TOPIC })],
    [
      'the same signature from another contract',
      { ...directMessageLog(), address: AUTHOR },
    ],
  ])('ignores %s', (_description, log) => {
    expect(decodePublishedDirectMessage(log)).toBeUndefined()
  })

  it.each([
    [
      'missing indexed topics',
      directMessageLog({ topics: [DIRECT_MESSAGE_SENT_TOPIC] }),
    ],
    [
      'surplus indexed topics',
      directMessageLog({
        topics: [
          ...directMessageLog().topics,
          keccak256(stringToHex('surplus')),
        ],
      }),
    ],
    ['zero message identifier', directMessageLog({ messageId: 0n })],
    [
      'a zero sender',
      directMessageLog({
        sender: '0x0000000000000000000000000000000000000000',
      }),
    ],
    [
      'a zero recipient',
      directMessageLog({
        recipient: '0x0000000000000000000000000000000000000000',
      }),
    ],
    ['an empty message', directMessageLog({ body: '', mediaCid: '0x' })],
    ['an oversized body', directMessageLog({ body: 'x'.repeat(4_097) })],
    [
      'an oversized media CID',
      directMessageLog({ mediaCid: `0x${'00'.repeat(129)}` as Hex }),
    ],
    [
      'a substituted conversation',
      directMessageLog({
        conversationTopic: keccak256(stringToHex('another conversation')),
      }),
    ],
    [
      'non-canonical sender padding',
      directMessageLog({ senderTopic: `0x01${'00'.repeat(31)}` }),
    ],
    [
      'non-canonical recipient padding',
      directMessageLog({ recipientTopic: `0x01${'00'.repeat(31)}` }),
    ],
    ['malformed ABI data', directMessageLog({ data: '0x01' })],
    [
      'surplus ABI data',
      directMessageLog({
        data: `${directMessageLog().data}${'00'.repeat(32)}` as Hex,
      }),
    ],
  ])('rejects %s', (_description, log) => {
    expect(() => decodePublishedDirectMessage(log)).toThrow(
      /invalid DirectMessageSent/i,
    )
  })

  it('offers a global family filter and a symmetric exact conversation filter', () => {
    const conversationId = getDirectConversationId(AUTHOR, RECIPIENT)
    expect(DIRECT_MESSAGE_SENT_FILTER).toEqual({
      address: PROTOCOL_ADDRESS,
      topics: [DIRECT_MESSAGE_SENT_TOPIC],
    })
    expect(getDirectMessageConversationFilter(AUTHOR, RECIPIENT)).toEqual({
      address: PROTOCOL_ADDRESS,
      topics: [DIRECT_MESSAGE_SENT_TOPIC, conversationId],
    })
    expect(getDirectMessageConversationFilter(RECIPIENT, AUTHOR)).toEqual(
      getDirectMessageConversationFilter(AUTHOR, RECIPIENT),
    )
  })
})
