import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import {
  DIRECT_MESSAGE_START_BLOCK,
  resetDirectMessageStreamCache,
  synchronizeDirectMessageStream,
  type DirectMessageStreamStorageOptions,
} from './direct-message-stream'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { BrowserEventCache, openEventCache } from './event-cache'
import { createEventCursor, type IndexedEventLog } from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { getDirectMessageConversationFilter } from './protocol-events'
import {
  DIRECT_MESSAGE_SENT_TOPIC,
  getDirectConversationId,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000cccc' as Address
const MESSAGE_DATA_PARAMETERS = [
  { type: 'uint256' },
  { type: 'string' },
  { type: 'bytes' },
] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint) {
  return keccak256(stringToHex(`transaction:${blockNumber.toString()}`))
}

function rawMessage(
  blockNumber: bigint,
  messageId: bigint,
  sender: Address,
  recipient: Address,
  body: string,
  options: { data?: Hex; mediaCid?: Hex } = {},
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data:
      options.data ??
      encodeAbiParameters(MESSAGE_DATA_PARAMETERS, [
        messageId,
        body,
        options.mediaCid ?? '0x',
      ]),
    logIndex: '0x0',
    removed: false,
    topics: [
      DIRECT_MESSAGE_SENT_TOPIC,
      getDirectConversationId(sender, recipient),
      padHex(sender, { size: 32 }),
      padHex(recipient, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function cachedMessage(
  blockNumber: bigint,
  messageId: bigint,
  sender: Address,
  recipient: Address,
  body = 'Cached public message.',
): IndexedEventLog {
  const message = rawMessage(blockNumber, messageId, sender, recipient, body)
  return {
    address: message.address as Address,
    blockHash: message.blockHash,
    blockNumber,
    data: message.data,
    logIndex: 0,
    topics: message.topics as readonly Hex[],
    transactionHash: message.transactionHash,
    transactionIndex: 0,
  }
}

function storage(
  factory = new IDBFactory(),
): DirectMessageStreamStorageOptions {
  return {
    databaseName: `direct-messages-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('direct-message stream synchronization', () => {
  it('rejects invalid participants before doing RPC or storage work', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    await expect(
      synchronizeDirectMessageStream(
        provider,
        1n,
        '0x1234' as Address,
        ACCOUNT_B,
      ),
    ).rejects.toThrow(/participant is invalid/i)
    await expect(
      synchronizeDirectMessageStream(
        provider,
        1n,
        '0x0000000000000000000000000000000000000000',
        ACCOUNT_B,
      ),
    ).rejects.toThrow(/two nonzero accounts/i)
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('resumes one exact conversation through one bounded range per call', async () => {
    const logQueries: Array<{
      fromBlock: string
      toBlock: string
      topics: readonly unknown[]
    }> = []
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }: ProviderRequest) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [
            {
              fromBlock: string
              toBlock: string
              topics: readonly unknown[]
            },
          ]
          logQueries.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
            topics: filter.topics,
          })
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }
    const cacheStorage = storage()
    const conversationId = getDirectConversationId(ACCOUNT_A, ACCOUNT_B)

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      conversationId,
      indexedThrough: 1_999n,
      scannedRanges: 1,
    })
    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_B, ACCOUNT_A, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      conversationId,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    await synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_C, {
      storage: cacheStorage,
    })

    expect(logQueries).toEqual([
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [DIRECT_MESSAGE_SENT_TOPIC, conversationId],
      },
      {
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: [DIRECT_MESSAGE_SENT_TOPIC, conversationId],
      },
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [
          DIRECT_MESSAGE_SENT_TOPIC,
          getDirectConversationId(ACCOUNT_A, ACCOUNT_C),
        ],
      },
    ])
  })

  it('returns both directions as decoded confirmed messages newest first', async () => {
    const logs = [
      rawMessage(2n, 1n, ACCOUNT_A, ACCOUNT_B, 'First public message.'),
      rawMessage(3n, 2n, ACCOUNT_B, ACCOUNT_A, 'Newest public reply.', {
        mediaCid: '0x01701220',
      }),
    ]
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') return logs
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 8n,
      recentMessages: [
        {
          body: 'Newest public reply.',
          mediaCid: '0x01701220',
          messageId: 2n,
          recipient: getAddress(ACCOUNT_A),
          sender: getAddress(ACCOUNT_B),
        },
        {
          body: 'First public message.',
          mediaCid: '0x',
          messageId: 1n,
          recipient: getAddress(ACCOUNT_B),
          sender: getAddress(ACCOUNT_A),
        },
      ],
    })
  })

  it('does not advance when fresh message data cannot be decoded', async () => {
    let valid = false
    const fromBlocks: string[] = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string }]
          fromBlocks.push(filter.fromBlock)
          const log = rawMessage(
            2n,
            1n,
            ACCOUNT_A,
            ACCOUNT_B,
            'A valid public message.',
          )
          return [valid ? log : { ...log, data: '0x01' }]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: cacheStorage,
      }),
    ).rejects.toThrow(/invalid DirectMessageSent/i)
    valid = true
    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      recentMessages: [{ body: 'A valid public message.', messageId: 1n }],
    })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('repairs a malformed cached message before resuming from genesis', async () => {
    const cacheStorage = storage()
    const filter = getDirectMessageConversationFilter(ACCOUNT_A, ACCOUNT_B)
    const seed = createEventCursor({
      chainId: 1n,
      filter,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: DIRECT_MESSAGE_START_BLOCK,
    })
    const cache = await openEventCache({ ...cacheStorage, filter })
    try {
      await cache.apply(await cache.readLatest(seed), {
        caughtUp: true,
        cursor: {
          ...seed,
          checkpoints: [{ blockHash: blockHash(1n), blockNumber: 1n }],
          nextBlock: 2n,
        },
        head: 13n,
        logs: [
          { ...cachedMessage(1n, 1n, ACCOUNT_A, ACCOUNT_B), data: '0x01' },
        ],
        safeHead: 1n,
        scannedRanges: 1,
      })
    } finally {
      cache.close()
    }
    let fromBlock = ''
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          const [request] = params as [{ fromBlock: string }]
          fromBlock = request.fromBlock
          return [
            rawMessage(
              2n,
              1n,
              ACCOUNT_A,
              ACCOUNT_B,
              'Recovered from the chain.',
            ),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      cacheReset: true,
      recentMessages: [{ body: 'Recovered from the chain.' }],
    })
    expect(fromBlock).toBe('0x0')
  })

  it('clears only the selected conversation cache scope', async () => {
    const cacheStorage = storage()
    const filterAB = getDirectMessageConversationFilter(ACCOUNT_A, ACCOUNT_B)
    const filterAC = getDirectMessageConversationFilter(ACCOUNT_A, ACCOUNT_C)
    const seedAB = createEventCursor({
      chainId: 1n,
      filter: filterAB,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: DIRECT_MESSAGE_START_BLOCK,
    })
    const seedAC = createEventCursor({
      chainId: 1n,
      filter: filterAC,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: DIRECT_MESSAGE_START_BLOCK,
    })
    for (const [filter, seed, log] of [
      [filterAB, seedAB, cachedMessage(1n, 1n, ACCOUNT_A, ACCOUNT_B)],
      [filterAC, seedAC, cachedMessage(1n, 2n, ACCOUNT_A, ACCOUNT_C)],
    ] as const) {
      const cache = await openEventCache({ ...cacheStorage, filter })
      try {
        await cache.apply(await cache.readLatest(seed), {
          caughtUp: true,
          cursor: {
            ...seed,
            checkpoints: [{ blockHash: blockHash(1n), blockNumber: 1n }],
            nextBlock: 2n,
          },
          head: 13n,
          logs: [log],
          safeHead: 1n,
          scannedRanges: 1,
        })
      } finally {
        cache.close()
      }
    }

    await resetDirectMessageStreamCache(1n, ACCOUNT_B, ACCOUNT_A, cacheStorage)

    const cleared = await openEventCache({ ...cacheStorage, filter: filterAB })
    try {
      await expect(cleared.readLatest(seedAB)).resolves.toMatchObject({
        cursor: seedAB,
        logs: [],
        reset: false,
        revision: 2n,
      })
    } finally {
      cleared.close()
    }
    const preserved = await openEventCache({
      ...cacheStorage,
      filter: filterAC,
    })
    try {
      await expect(preserved.readLatest(seedAC)).resolves.toMatchObject({
        logs: [{ data: cachedMessage(1n, 2n, ACCOUNT_A, ACCOUNT_C).data }],
        revision: 1n,
      })
    } finally {
      preserved.close()
    }
  })

  it('rejects unverified code without requesting message logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).rejects.toThrow(/verified Lifeinvader v1/i)
    expect(provider.request).toHaveBeenCalledTimes(3)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('binds protocol inspection to the selected chain', async () => {
    let chainReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') {
          chainReads += 1
          return chainReads === 1 ? '0x1' : '0x2'
        }
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).rejects.toThrow(/another wallet chain/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('observes wallet chain changes during protocol verification', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') {
          listeners.get('chainChanged')?.('0x2')
          return PROTOCOL_RUNTIME_CODE
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).rejects.toThrow(/chain changed during direct-message verification/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(listeners.size).toBe(0)
  })

  it('rejects a committed range that loses confirmation depth', async () => {
    const heads = [100n, 89n]
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(heads.shift() ?? 89n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).rejects.toThrow(/head moved behind the confirmed direct messages/i)
    expect(
      vi
        .mocked(provider.request)
        .mock.calls.filter(([request]) => request.method === 'eth_getLogs'),
    ).toHaveLength(1)
  })

  it('does not claim catch-up when the final safe head moves ahead', async () => {
    const heads = [20n, 21n]
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(heads.shift() ?? 21n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: 8n,
      safeHead: 9n,
    })
  })

  it('rejects a committed checkpoint replaced during cache work', async () => {
    let endpointReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }: ProviderRequest) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(100n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          const blockNumber = BigInt(number)
          if (blockNumber === 88n) endpointReads += 1
          return {
            hash: blockHash(
              blockNumber,
              blockNumber === 88n && endpointReads > 4 ? 'b' : 'a',
            ),
            number,
          }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).rejects.toThrow(/confirmed direct-message checkpoint changed/i)
    expect(endpointReads).toBe(5)
  })

  it('rejects a post-apply page from a newer cache position', async () => {
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const readLatest = BrowserEventCache.prototype.readLatest
    let reads = 0
    vi.spyOn(BrowserEventCache.prototype, 'readLatest').mockImplementation(
      async function (this: BrowserEventCache, seed, limit) {
        const page = await readLatest.call(this, seed, limit)
        reads += 1
        return reads === 2 ? { ...page, revision: page.revision + 1n } : page
      },
    )

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        storage: storage(),
      }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('interrupts a stalled context read and removes every listener', async () => {
    const controller = new AbortController()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn(
        () =>
          new Promise<unknown>(() => {
            queueMicrotask(() => controller.abort())
          }),
      ),
    }

    await expect(
      synchronizeDirectMessageStream(provider, 1n, ACCOUNT_A, ACCOUNT_B, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})
