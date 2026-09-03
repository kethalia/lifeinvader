import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, padHex, toHex, type Address } from 'viem'
import {
  parseAccounts,
  parseChainId,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  assertExpectedDirectMessage,
  assertExpectedProfile,
  assertExpectedPostAction,
  assertProtocolConfiguration,
  COMMENT_PUBLISHED_TOPIC,
  deployProtocol,
  DIRECT_MESSAGE_SENT_TOPIC,
  FACTORY_ADDRESS,
  FACTORY_CODE_HASH,
  getDirectConversationId,
  getPostBodyByteLength,
  inspectProtocol,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  LIFEINVADER_INIT_CODE,
  LIKE_SET_TOPIC,
  MAX_POST_BODY_BYTES,
  MAX_PROFILE_BIO_BYTES,
  MAX_PROFILE_DISPLAY_NAME_BYTES,
  PROTOCOL_ADDRESS,
  PROFILE_SET_TOPIC,
  publishComment,
  publishRepost,
  publishPost,
  REPOST_PUBLISHED_TOPIC,
  sendDirectMessage,
  setPostLike,
  setProfile,
  switchToLocalChain,
  verifyLocalChain,
  waitForTransactionReceipt,
} from './protocol'
const FACTORY_RUNTIME_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`
const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BLOCK_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER_BLOCK_HASH =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const ACCOUNT = '0x000000000000000000000000000000000000a11c' as Address
const RECIPIENT = '0x000000000000000000000000000000000000b0b0' as Address
function providerFrom(
  request: (args: ProviderRequest) => Promise<unknown>,
): Eip1193Provider {
  return { request }
}
function fingerprintProvider(
  blockHash = BLOCK_HASH,
  chainId = '0x7a69',
): Eip1193Provider {
  return providerFrom(async ({ method, params }) => {
    if (method === 'eth_chainId') return chainId
    if (method === 'eth_blockNumber') return '0x2a'
    if (method === 'eth_getBlockByNumber') {
      expect(params).toEqual(['0x2a', false])
      return { hash: blockHash, number: '0x2a' }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
}
function receiptProvider(
  status = '0x1',
  transactionHash = TRANSACTION_HASH,
  canonicalHash = BLOCK_HASH,
  protocolCode = '0x',
) {
  return providerFrom(async ({ method }) => {
    if (method === 'eth_getTransactionReceipt')
      return {
        blockHash: BLOCK_HASH,
        blockNumber: '0x2a',
        status,
        transactionHash,
      }
    if (method === 'eth_getBlockByNumber')
      return { hash: canonicalHash, number: '0x2a' }
    if (method === 'eth_getCode') return protocolCode
    throw new Error(`Unexpected method: ${method}`)
  })
}
describe('protocol configuration', () => {
  it('keeps the browser deployment inputs frozen to the published v1 address', () => {
    expect(() => assertProtocolConfiguration()).not.toThrow()
    expect(FACTORY_CODE_HASH).toMatch(/^0x[0-9a-f]{64}$/)
  })
  it('rejects chain quantities wider than an EVM word', () => {
    expect(() => parseChainId(`0x${'1'.repeat(65)}`)).toThrow(
      /invalid chain identifier/i,
    )
    expect(() => parseAccounts(Array(1_001).fill(ACCOUNT))).toThrow(
      /invalid account list/i,
    )
  })
  it('derives the exact symmetric direct-message conversation identifier', () => {
    expect(getDirectConversationId(ACCOUNT, RECIPIENT)).toBe(
      '0x7506dccaa96eb75e1859d1d5aec685aac9f9281d5a59b00f0f3d40a234e2fe9c',
    )
    expect(getDirectConversationId(RECIPIENT, ACCOUNT)).toBe(
      getDirectConversationId(ACCOUNT, RECIPIENT),
    )
    expect(() =>
      getDirectConversationId('0x1234' as Address, RECIPIENT),
    ).toThrow(/participant is invalid/i)
  })
  it('recognizes a chain where the canonical factory can deploy v1', async () => {
    const provider = providerFrom(async ({ method, params }) => {
      expect(method).toBe('eth_getCode')
      const [address] = params as readonly string[]
      if (address === PROTOCOL_ADDRESS) return '0x'
      if (address === FACTORY_ADDRESS) return FACTORY_RUNTIME_CODE.toUpperCase()
      throw new Error(`Unexpected address: ${address}`)
    })
    await expect(inspectProtocol(provider)).resolves.toEqual({
      kind: 'deployable',
    })
  })
  it.each([
    ['missing-factory', '0x'],
    ['unsafe-factory', '0x00'],
  ] as const)(
    'reports %s without enabling deployment',
    async (kind, factoryCode) => {
      const provider = providerFrom(async ({ params }) => {
        const [address] = params as readonly string[]
        return address === PROTOCOL_ADDRESS ? '0x' : factoryCode
      })
      await expect(inspectProtocol(provider)).resolves.toEqual({ kind })
    },
  )
  it('rejects unexpected or oversized code at the protocol address', async () => {
    const request = vi.fn(async () => '0x00')
    await expect(inspectProtocol(providerFrom(request))).resolves.toEqual({
      kind: 'address-conflict',
    })
    expect(request).toHaveBeenCalledTimes(1)
    await expect(
      inspectProtocol(providerFrom(async () => `0x${'00'.repeat(24_577)}`)),
    ).rejects.toThrow(/invalid contract code/i)
  })
  it('bounds stalled contract-code reads', async () => {
    const request = vi.fn(() => new Promise<unknown>(() => undefined))
    await expect(inspectProtocol(providerFrom(request), 5)).rejects.toThrow(
      /inspection timed out/i,
    )
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('cancels a stalled contract-code inspection immediately', async () => {
    const controller = new AbortController()
    const request = vi.fn(
      () =>
        new Promise<unknown>(() => {
          queueMicrotask(() => controller.abort())
        }),
    )
    await expect(
      inspectProtocol(providerFrom(request), 60_000, controller.signal),
    ).rejects.toThrow(/inspection was cancelled/i)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
describe('protocol transactions', () => {
  it('measures the same UTF-8 bytes the contract limits', () => {
    expect(getPostBodyByteLength('invade')).toBe(6)
    expect(getPostBodyByteLength('👁️')).toBe(7)
  })
  it('parses a successful transaction receipt', async () => {
    await expect(
      waitForTransactionReceipt(receiptProvider(), TRANSACTION_HASH),
    ).resolves.toEqual({
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    })
    await expect(
      waitForTransactionReceipt(receiptProvider(), TRANSACTION_HASH, {
        expectProtocol: true,
      }),
    ).rejects.toThrow(/did not deploy/i)
  })
  it('rejects an oversized UTF-8 body before opening the wallet', async () => {
    const request = vi.fn()
    await expect(
      publishPost(providerFrom(request), ACCOUNT, 1n, {
        body: '🫥'.repeat(MAX_POST_BODY_BYTES),
        mediaCid: '0x',
      }),
    ).rejects.toThrow(/4096 UTF-8 bytes/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects an empty publication before opening the wallet', async () => {
    const request = vi.fn()
    await expect(
      publishPost(providerFrom(request), ACCOUNT, 1n, {
        body: '',
        mediaCid: '0x',
      }),
    ).rejects.toThrow(/write something or add a media CID/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects malformed media CID bytes before opening the wallet', async () => {
    const request = vi.fn()
    await expect(
      publishPost(providerFrom(request), ACCOUNT, 1n, {
        body: 'This must not silently drop the attachment.',
        mediaCid: '0x01',
      }),
    ).rejects.toThrow(/media CID/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects invalid profile fields before opening the wallet', async () => {
    const request = vi.fn()
    const provider = providerFrom(request)
    await expect(
      setProfile(provider, ACCOUNT, 1n, {
        avatarCid: '0x',
        bio: '',
        displayName: '🫥'.repeat(MAX_PROFILE_DISPLAY_NAME_BYTES),
      }),
    ).rejects.toThrow(/64 UTF-8 bytes/i)
    await expect(
      setProfile(provider, ACCOUNT, 1n, {
        avatarCid: '0x',
        bio: '🫥'.repeat(MAX_PROFILE_BIO_BYTES),
        displayName: '',
      }),
    ).rejects.toThrow(/1024 UTF-8 bytes/i)
    await expect(
      setProfile(provider, ACCOUNT, 1n, {
        avatarCid: '0x01',
        bio: '',
        displayName: '',
      }),
    ).rejects.toThrow(/media CID/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects invalid public direct messages before opening the wallet', async () => {
    const request = vi.fn()
    const provider = providerFrom(request)
    const send = (recipient: Address, body: string, mediaCid = '0x' as const) =>
      sendDirectMessage(provider, ACCOUNT, 1n, recipient, { body, mediaCid })

    await expect(send('0x1234' as Address, 'hello')).rejects.toThrow(
      /recipient is invalid/i,
    )
    await expect(
      send('0x0000000000000000000000000000000000000000', 'hello'),
    ).rejects.toThrow(/nonzero recipient/i)
    await expect(
      sendDirectMessage(
        provider,
        '0x0000000000000000000000000000000000000000',
        1n,
        RECIPIENT,
        { body: 'hello', mediaCid: '0x' },
      ),
    ).rejects.toThrow(/nonzero sender/i)
    await expect(send(RECIPIENT, '')).rejects.toThrow(
      /write a public message or add a media CID/i,
    )
    await expect(
      send(RECIPIENT, '🫥'.repeat(MAX_POST_BODY_BYTES)),
    ).rejects.toThrow(/4096 UTF-8 bytes/i)
    await expect(
      sendDirectMessage(provider, ACCOUNT, 1n, RECIPIENT, {
        body: 'This attachment is not a CID.',
        mediaCid: '0x01',
      }),
    ).rejects.toThrow(/media CID/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('requires an exact public direct-message event and accepts its assigned ID', () => {
    const receipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    } as const
    const conversationId = getDirectConversationId(ACCOUNT, RECIPIENT)
    const expected = {
      body: 'There are no secrets here.',
      conversationId,
      mediaCid: '0x01701220' as const,
      recipient: RECIPIENT,
      sender: ACCOUNT,
    }
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'string' }, { type: 'bytes' }],
      [91n, expected.body, expected.mediaCid],
    )
    const log = {
      address: PROTOCOL_ADDRESS,
      blockHash: BLOCK_HASH,
      blockNumber: '0x2a',
      data,
      topics: [
        DIRECT_MESSAGE_SENT_TOPIC,
        conversationId,
        padHex(ACCOUNT, { size: 32 }),
        padHex(RECIPIENT, { size: 32 }),
      ],
      transactionHash: TRANSACTION_HASH,
    }

    expect(assertExpectedDirectMessage([log], expected, receipt)).toBe(91n)
    for (const invalidLog of [
      {
        ...log,
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'string' }, { type: 'bytes' }],
          [0n, expected.body, expected.mediaCid],
        ),
      },
      {
        ...log,
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'string' }, { type: 'bytes' }],
          [91n, 'A substituted body.', expected.mediaCid],
        ),
      },
      { ...log, data: `${data}${'00'.repeat(32)}` },
      { ...log, blockHash: OTHER_BLOCK_HASH },
      {
        ...log,
        topics: [
          DIRECT_MESSAGE_SENT_TOPIC,
          conversationId,
          padHex(ACCOUNT, { size: 32 }),
          padHex(ACCOUNT, { size: 32 }),
        ],
      },
    ]) {
      expect(() =>
        assertExpectedDirectMessage([invalidLog], expected, receipt),
      ).toThrow(/expected direct-message event/i)
    }
    expect(() =>
      assertExpectedDirectMessage(
        [log],
        {
          ...expected,
          conversationId:
            '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
        receipt,
      ),
    ).toThrow(/expected direct-message event/i)
  })
  it('requires the exact complete profile snapshot in its receipt', () => {
    const profileReceipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    } as const
    const profileLog = {
      address: PROTOCOL_ADDRESS,
      blockHash: BLOCK_HASH,
      blockNumber: '0x2a',
      data: encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'bytes' }],
        ['Tracey', 'Everything is public.', '0x'],
      ),
      topics: [PROFILE_SET_TOPIC, padHex(ACCOUNT, { size: 32 })],
      transactionHash: TRANSACTION_HASH,
    }
    expect(() =>
      assertExpectedProfile(
        [profileLog],
        {
          account: ACCOUNT,
          avatarCid: '0x',
          bio: 'Everything is public.',
          displayName: 'Tracey',
        },
        profileReceipt,
      ),
    ).not.toThrow()
    expect(() =>
      assertExpectedProfile(
        [profileLog],
        {
          account: ACCOUNT,
          avatarCid: '0x',
          bio: 'A substituted bio.',
          displayName: 'Tracey',
        },
        profileReceipt,
      ),
    ).toThrow(/expected profile event/i)
    expect(() =>
      assertExpectedProfile(
        [{ ...profileLog, blockHash: OTHER_BLOCK_HASH }],
        {
          account: ACCOUNT,
          avatarCid: '0x',
          bio: 'Everything is public.',
          displayName: 'Tracey',
        },
        profileReceipt,
      ),
    ).toThrow(/expected profile event/i)
  })
  it('rejects invalid reaction targets before opening the wallet', async () => {
    const request = vi.fn()
    const provider = providerFrom(request)
    await expect(publishRepost(provider, ACCOUNT, 1n, 0n)).rejects.toThrow(
      /post identifier is invalid/i,
    )
    await expect(
      setPostLike(provider, ACCOUNT, 1n, 1n << 256n, true),
    ).rejects.toThrow(/post identifier is invalid/i)
    await expect(
      publishComment(provider, ACCOUNT, 1n, 0n, {
        body: 'Nobody can comment on post zero.',
        mediaCid: '0x',
      }),
    ).rejects.toThrow(/post identifier is invalid/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects invalid comment payloads before opening the wallet', async () => {
    const request = vi.fn()
    const provider = providerFrom(request)
    await expect(
      publishComment(provider, ACCOUNT, 1n, 1n, {
        body: '',
        mediaCid: '0x',
      }),
    ).rejects.toThrow(/before commenting/i)
    await expect(
      publishComment(provider, ACCOUNT, 1n, 1n, {
        body: 'This attachment is not a CID.',
        mediaCid: '0x01',
      }),
    ).rejects.toThrow(/media CID/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('requires exact comment, like, and repost events in action receipts', () => {
    const postId = 7n
    const actionReceipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    } as const
    const accountTopic = padHex(ACCOUNT, { size: 32 })
    const postTopic = padHex(toHex(postId), { size: 32 })
    const likeLog = {
      address: PROTOCOL_ADDRESS,
      blockHash: BLOCK_HASH,
      blockNumber: '0x2a',
      data: encodeAbiParameters([{ type: 'bool' }], [true]),
      topics: [
        LIKE_SET_TOPIC,
        padHex(toHex(0n), { size: 32 }),
        postTopic,
        accountTopic,
      ],
      transactionHash: TRANSACTION_HASH,
    }
    const repostLog = {
      address: PROTOCOL_ADDRESS,
      blockHash: BLOCK_HASH,
      blockNumber: '0x2a',
      data: '0x',
      topics: [REPOST_PUBLISHED_TOPIC, postTopic, accountTopic],
      transactionHash: TRANSACTION_HASH,
    }
    const commentLog = {
      address: PROTOCOL_ADDRESS,
      blockHash: BLOCK_HASH,
      blockNumber: '0x2a',
      data: encodeAbiParameters(
        [{ type: 'string' }, { type: 'bytes' }],
        ['Everything is public.', '0x'],
      ),
      topics: [
        COMMENT_PUBLISHED_TOPIC,
        padHex(toHex(9n), { size: 32 }),
        postTopic,
        accountTopic,
      ],
      transactionHash: TRANSACTION_HASH,
    }

    expect(() =>
      assertExpectedPostAction(
        [commentLog],
        {
          account: ACCOUNT,
          body: 'Everything is public.',
          kind: 'comment',
          mediaCid: '0x',
          postId,
        },
        actionReceipt,
      ),
    ).not.toThrow()
    expect(() =>
      assertExpectedPostAction(
        [likeLog],
        {
          account: ACCOUNT,
          kind: 'like',
          liked: true,
          postId,
        },
        actionReceipt,
      ),
    ).not.toThrow()
    expect(() =>
      assertExpectedPostAction(
        [repostLog],
        {
          account: ACCOUNT,
          kind: 'repost',
          postId,
        },
        actionReceipt,
      ),
    ).not.toThrow()
    expect(() =>
      assertExpectedPostAction(
        [likeLog],
        {
          account: ACCOUNT,
          kind: 'like',
          liked: false,
          postId,
        },
        actionReceipt,
      ),
    ).toThrow(/expected like event/i)
    expect(() =>
      assertExpectedPostAction(
        [{ ...repostLog, transactionHash: OTHER_BLOCK_HASH }],
        { account: ACCOUNT, kind: 'repost', postId },
        actionReceipt,
      ),
    ).toThrow(/expected repost event/i)
    expect(() =>
      assertExpectedPostAction(
        [commentLog],
        {
          account: ACCOUNT,
          body: 'A substituted body.',
          kind: 'comment',
          mediaCid: '0x',
          postId,
        },
        actionReceipt,
      ),
    ).toThrow(/expected comment event/i)
  })
  it('rejects matching event payloads copied from another receipt', () => {
    const actionReceipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    } as const
    const expected = {
      account: ACCOUNT,
      kind: 'repost' as const,
      postId: 7n,
    } as const
    const baseLog = {
      address: PROTOCOL_ADDRESS,
      blockHash: BLOCK_HASH,
      blockNumber: '0x2a',
      data: '0x',
      topics: [
        REPOST_PUBLISHED_TOPIC,
        padHex(toHex(7n), { size: 32 }),
        padHex(ACCOUNT, { size: 32 }),
      ],
      transactionHash: TRANSACTION_HASH,
    }

    for (const log of [
      { ...baseLog, blockHash: OTHER_BLOCK_HASH },
      { ...baseLog, blockNumber: '0x29' },
      { ...baseLog, transactionHash: OTHER_BLOCK_HASH },
    ]) {
      expect(() =>
        assertExpectedPostAction([log], expected, actionReceipt),
      ).toThrow(/expected repost event/i)
    }
  })
  it('locks ambiguous wallet submission failures but preserves rejection', async () => {
    const providerThatFailsSend = (failure: Error) =>
      providerFrom(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_accounts') return [ACCOUNT]
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_sendTransaction') throw failure
        throw new Error(`Unexpected method: ${method}`)
      })
    const transportFailure = new Error('Provider response timed out.')
    const ambiguous = await publishRepost(
      providerThatFailsSend(transportFailure),
      ACCOUNT,
      1n,
      1n,
    ).catch((error: unknown) => error)
    expect(isTransactionSubmissionUnknownError(ambiguous)).toBe(true)
    expect((ambiguous as Error).message).toMatch(/may still have broadcast/i)

    const rejection = Object.assign(new Error('User rejected.'), { code: 4001 })
    await expect(
      publishRepost(providerThatFailsSend(rejection), ACCOUNT, 1n, 1n),
    ).rejects.toBe(rejection)
  })
  it('surfaces an on-chain revert from the receipt', async () => {
    const error = await waitForTransactionReceipt(
      receiptProvider('0x0'),
      TRANSACTION_HASH,
    ).catch((error: unknown) => error)
    expect(isTransactionRevertedError(error)).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/reverted on-chain/i)
  })
  it('stops polling when the receipt provider rejects', async () => {
    const request = vi.fn(async () => {
      throw new Error('Wallet disconnected.')
    })
    await expect(
      waitForTransactionReceipt(providerFrom(request), TRANSACTION_HASH),
    ).rejects.toThrow(/wallet disconnected/i)
  })
  it('rejects a receipt for a different transaction', async () => {
    await expect(
      waitForTransactionReceipt(
        receiptProvider('0x1', OTHER_BLOCK_HASH),
        TRANSACTION_HASH,
      ),
    ).rejects.toThrow(/different transaction/i)
  })
  it('does not confirm a receipt from a noncanonical block', async () => {
    await expect(
      waitForTransactionReceipt(
        receiptProvider('0x1', TRANSACTION_HASH, OTHER_BLOCK_HASH),
        TRANSACTION_HASH,
        { pollIntervalMs: 10, timeoutMs: 5 },
      ),
    ).rejects.toThrow(TRANSACTION_HASH)
  })
  it('bounds repeated null receipts without discarding the hash', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => null)
    try {
      const unavailable = expect(
        waitForTransactionReceipt(providerFrom(request), TRANSACTION_HASH, {
          pollIntervalMs: 10,
          timeoutMs: 5,
        }),
      ).rejects.toThrow(TRANSACTION_HASH)
      await vi.advanceTimersByTimeAsync(5)
      await unavailable
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('times out a receipt request that never settles', async () => {
    const request = vi.fn(() => new Promise<unknown>(() => undefined))
    await expect(
      waitForTransactionReceipt(providerFrom(request), TRANSACTION_HASH, {
        timeoutMs: 5,
      }),
    ).rejects.toThrow(TRANSACTION_HASH)
  })
  it('checks synchronous context after the final canonical read', async () => {
    let changed = false
    const assertUnchanged = vi.fn(() => {
      if (changed) throw new Error('Wallet network changed.')
    })
    const provider = providerFrom(async ({ method }) => {
      if (method === 'eth_getTransactionReceipt')
        return {
          blockHash: BLOCK_HASH,
          blockNumber: '0x2a',
          status: '0x1',
          transactionHash: TRANSACTION_HASH,
        }
      if (method === 'eth_getBlockByNumber') {
        changed = true
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      waitForTransactionReceipt(provider, TRANSACTION_HASH, {
        assertUnchanged,
      }),
    ).rejects.toThrow(/network changed/i)
    expect(assertUnchanged).toHaveBeenCalledTimes(1)
  })
})
describe('transaction chain binding', () => {
  it('rejects a chain different from the click-time selection', async () => {
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x2'
      if (method === 'eth_accounts') return [ACCOUNT]
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(providerFrom(request), ACCOUNT, 1n),
    ).rejects.toThrow(/network changed/i)
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getCode' }),
    )
  })
  it('does not open the transaction request after the inspected chain changes', async () => {
    let handleChainChanged: ((...args: unknown[]) => void) | undefined
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_getCode') {
        const [address] = params as readonly string[]
        if (address === PROTOCOL_ADDRESS) return '0x'
        if (address === FACTORY_ADDRESS) {
          handleChainChanged?.('0x2')
          return FACTORY_RUNTIME_CODE
        }
      }
      if (method === 'eth_sendTransaction') return TRANSACTION_HASH
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(
        {
          request,
          on: (event, listener) => {
            if (event === 'chainChanged') handleChainChanged = listener
          },
          removeListener: (event) => {
            if (event === 'chainChanged') handleChainChanged = undefined
          },
        },
        ACCOUNT,
        1n,
      ),
    ).rejects.toThrow(/network changed/i)
    expect(
      request.mock.calls.some(
        ([request]) => request.method === 'eth_sendTransaction',
      ),
    ).toBe(false)
  })
  it('reports the hash when the wallet changes chain during submission', async () => {
    let handleChainChanged: ((...args: unknown[]) => void) | undefined
    const onSubmitted = vi.fn()
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_getCode') {
        const [address] = params as readonly string[]
        return address === PROTOCOL_ADDRESS ? '0x' : FACTORY_RUNTIME_CODE
      }
      if (method === 'eth_sendTransaction') {
        expect(params).toEqual([expect.objectContaining({ chainId: '0x1' })])
        handleChainChanged?.('0x2')
        return TRANSACTION_HASH
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(
        {
          request,
          on: (event, listener) => {
            if (event === 'chainChanged') handleChainChanged = listener
          },
          removeListener: (event) => {
            if (event === 'chainChanged') handleChainChanged = undefined
          },
        },
        ACCOUNT,
        1n,
        onSubmitted,
      ),
    ).rejects.toThrow(/network changed/i)
    expect(onSubmitted).toHaveBeenCalledWith(TRANSACTION_HASH)
    expect(
      request.mock.calls.some(
        ([request]) => request.method === 'eth_getTransactionReceipt',
      ),
    ).toBe(false)
  })
  it('does not submit after the selected account changes', async () => {
    let handleAccountsChanged: ((...args: unknown[]) => void) | undefined
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_getCode') {
        const [address] = params as readonly string[]
        if (address === PROTOCOL_ADDRESS) return '0x'
        handleAccountsChanged?.(['0x000000000000000000000000000000000000b0b0'])
        return FACTORY_RUNTIME_CODE
      }
      if (method === 'eth_sendTransaction') return TRANSACTION_HASH
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(
        {
          request,
          on: (event, listener) => {
            if (event === 'accountsChanged') handleAccountsChanged = listener
          },
          removeListener: (event) => {
            if (event === 'accountsChanged') handleAccountsChanged = undefined
          },
        },
        ACCOUNT,
        1n,
      ),
    ).rejects.toThrow(/account changed/i)
    expect(
      request.mock.calls.some(
        ([request]) => request.method === 'eth_sendTransaction',
      ),
    ).toBe(false)
  })
})
describe('local wallet network', () => {
  it('verifies the wallet against a block fingerprint from loopback Anvil', async () => {
    await expect(
      verifyLocalChain(fingerprintProvider(), fingerprintProvider()),
    ).resolves.toBeUndefined()
  })
  it('rejects a reused chain ID that points at a different RPC', async () => {
    await expect(
      verifyLocalChain(
        fingerprintProvider(OTHER_BLOCK_HASH),
        fingerprintProvider(),
      ),
    ).rejects.toThrow(/does not match Anvil/i)
  })
  it('bounds stalled local fingerprint reads', async () => {
    const stalled = providerFrom(() => new Promise<unknown>(() => undefined))
    await expect(
      verifyLocalChain(fingerprintProvider(), stalled, 5),
    ).rejects.toThrow(/does not match Anvil/i)
  })
  it('rejects oversized block quantities before conversion', async () => {
    const localProvider = providerFrom(async ({ method }) => {
      if (method === 'eth_chainId') return '0x7a69'
      if (method === 'eth_blockNumber') return `0x${'1'.repeat(65)}`
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      verifyLocalChain(fingerprintProvider(), localProvider),
    ).rejects.toThrow(/invalid local block number/i)
  })
  it('adds an unknown Anvil chain and selects it when still required', async () => {
    let firstSwitch = true
    let selected = false
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'wallet_switchEthereumChain' && firstSwitch) {
        firstSwitch = false
        throw Object.assign(new Error('Unknown chain'), { code: 4902 })
      }
      if (method === 'wallet_switchEthereumChain') selected = true
      if (method === 'eth_chainId') return selected ? '0x7a69' : '0x1'
      if (method === 'eth_blockNumber') return '0x2a'
      if (method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      return null
    })
    await switchToLocalChain(providerFrom(request), fingerprintProvider())
    expect(request.mock.calls.map(([request]) => request.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'eth_blockNumber',
      'eth_getBlockByNumber',
    ])
    expect(request.mock.calls[1]?.[0].params).toEqual([
      expect.objectContaining({
        chainId: '0x7a69',
        rpcUrls: ['http://127.0.0.1:8545'],
      }),
    ])
  })
  it('does not repeat the switch when adding the chain selected it', async () => {
    let firstSwitch = true
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'wallet_switchEthereumChain' && firstSwitch) {
        firstSwitch = false
        throw Object.assign(new Error('Unknown chain'), { code: 4902 })
      }
      if (method === 'eth_chainId') return '0x7A69'
      if (method === 'eth_blockNumber') return '0x2a'
      if (method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      return null
    })
    await switchToLocalChain(providerFrom(request), fingerprintProvider())
    expect(request.mock.calls.map(([request]) => request.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'eth_chainId',
      'eth_blockNumber',
      'eth_getBlockByNumber',
    ])
  })
})
