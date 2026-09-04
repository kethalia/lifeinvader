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
  GROUP_MESSAGE_START_BLOCK,
  resetGroupMessageStreamCache,
  synchronizeGroupMessageStream,
  type GroupMessageStreamStorageOptions,
  type SynchronizeGroupMessageStreamOptions,
} from './group-message-stream'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { BrowserEventCache, openEventCache } from './event-cache'
import { createEventCursor, type IndexedEventLog } from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { getGroupMessageFilter } from './protocol-events'
import {
  GROUP_MESSAGE_SENT_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'
import {
  ProtocolHistoryUnavailableError,
  type ProtocolHistoryBoundary,
} from './protocol-history'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const GROUP_A = 17n
const GROUP_B = 18n
const MESSAGE_DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
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
  groupId: bigint,
  sender: Address,
  body: string,
  options: { data?: Hex; logIndex?: number; mediaCid?: Hex } = {},
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data:
      options.data ??
      encodeAbiParameters(MESSAGE_DATA_PARAMETERS, [
        body,
        options.mediaCid ?? '0x',
      ]),
    logIndex: toHex(options.logIndex ?? 0),
    removed: false,
    topics: [
      GROUP_MESSAGE_SENT_TOPIC,
      padHex(toHex(groupId), { size: 32 }),
      padHex(sender, { size: 32 }),
      padHex(toHex(messageId), { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function cachedMessage(
  blockNumber: bigint,
  messageId: bigint,
  groupId: bigint,
  sender: Address,
  body = 'Cached public message.',
): IndexedEventLog {
  const message = rawMessage(blockNumber, messageId, groupId, sender, body)
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

function storage(factory = new IDBFactory()): GroupMessageStreamStorageOptions {
  return {
    databaseName: `group-messages-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

async function unsupportedHistory(): Promise<never> {
  throw new ProtocolHistoryUnavailableError(
    0n,
    new Error('Historical state is unavailable.'),
  )
}

function historyBoundary(
  startBlock: bigint,
  headBlock = 5_000n,
): ProtocolHistoryBoundary {
  const safeBlock = headBlock - POST_FEED_CONFIRMATION_DEPTH
  return {
    chainId: 1n,
    codeProbes: 1,
    confirmedThrough: {
      blockHash: blockHash(safeBlock),
      blockNumber: safeBlock,
    },
    deployment: {
      blockHash: blockHash(startBlock),
      blockNumber: startBlock,
    },
    head: {
      blockHash: blockHash(headBlock),
      blockNumber: headBlock,
    },
    kind: startBlock > safeBlock ? 'pending-confirmation' : 'confirmed',
    startBlock,
  }
}

function synchronizeWithFallback(
  provider: Eip1193Provider,
  chainId: bigint,
  groupId: bigint,
  options: SynchronizeGroupMessageStreamOptions = {},
) {
  return synchronizeGroupMessageStream(provider, chainId, groupId, {
    resolveHistoryBoundary: unsupportedHistory,
    ...options,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('group-message stream synchronization', () => {
  it('rejects invalid group identifiers before doing RPC or storage work', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    await expect(
      synchronizeGroupMessageStream(provider, 1n, 0n),
    ).rejects.toThrow(/group identifier is invalid/i)
    await expect(
      synchronizeGroupMessageStream(provider, 1n, 1n << 256n),
    ).rejects.toThrow(/group identifier is invalid/i)
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('resumes one exact group through one bounded range per call', async () => {
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

    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      groupId: GROUP_A,
      historyBoundaryKind: 'genesis-fallback',
      indexedThrough: 1_999n,
      scannedRanges: 1,
      startBlock: GROUP_MESSAGE_START_BLOCK,
    })
    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      groupId: GROUP_A,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    await synchronizeWithFallback(provider, 1n, GROUP_B, {
      storage: cacheStorage,
    })

    expect(logQueries).toEqual([
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [
          GROUP_MESSAGE_SENT_TOPIC,
          padHex(toHex(GROUP_A), { size: 32 }),
        ],
      },
      {
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: [
          GROUP_MESSAGE_SENT_TOPIC,
          padHex(toHex(GROUP_A), { size: 32 }),
        ],
      },
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [
          GROUP_MESSAGE_SENT_TOPIC,
          padHex(toHex(GROUP_B), { size: 32 }),
        ],
      },
    ])
  })

  it('starts an exact-group message stream at the verified deployment boundary', async () => {
    const requests: ProviderRequest[] = []
    const resolveHistoryBoundary = vi.fn(async () => historyBoundary(3_000n))
    const provider: Eip1193Provider = {
      request: vi.fn(async (request: ProviderRequest) => {
        requests.push(request)
        const { method, params } = request
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          return [
            rawMessage(
              3_001n,
              1n,
              GROUP_A,
              ACCOUNT_A,
              'Started after deployment.',
            ),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
        resolveHistoryBoundary,
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      historyBoundaryKind: 'confirmed',
      indexedThrough: 4_988n,
      recentMessages: [{ body: 'Started after deployment.', messageId: 1n }],
      scannedRanges: 1,
      startBlock: 3_000n,
    })
    expect(resolveHistoryBoundary).toHaveBeenCalledWith(
      provider,
      1n,
      expect.objectContaining({
        finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
        signal: expect.any(AbortSignal),
      }),
    )
    const logRequestIndex = requests.findIndex(
      ({ method }) => method === 'eth_getLogs',
    )
    expect(requests[logRequestIndex]?.params).toEqual([
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0xbb8',
        toBlock: '0x137c',
        topics: [
          GROUP_MESSAGE_SENT_TOPIC,
          padHex(toHex(GROUP_A), { size: 32 }),
        ],
      },
    ])
    expect(
      requests.findIndex(
        ({ method, params }, index) =>
          index > logRequestIndex &&
          method === 'eth_getBlockByNumber' &&
          (params as [string])[0] === '0x1388',
      ),
    ).toBeGreaterThan(logRequestIndex)
  })

  it('fails closed when message history discovery does not explicitly reject archival state', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
        resolveHistoryBoundary: async () => {
          throw new Error('Protocol history discovery timed out.')
        },
        storage: storage(),
      }),
    ).rejects.toThrow(/history discovery timed out/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('discards one fetched message range when the history anchor was replaced', async () => {
    const apply = vi.spyOn(BrowserEventCache.prototype, 'apply')
    const resolveHistoryBoundary = vi.fn(async () => historyBoundary(3_000n))
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          const blockNumber = BigInt(number)
          return {
            hash: blockHash(blockNumber, blockNumber === 5_000n ? 'b' : 'a'),
            number,
          }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
        resolveHistoryBoundary,
        storage: storage(),
      }),
    ).rejects.toThrow(/protocol history anchor changed/i)
    expect(resolveHistoryBoundary).toHaveBeenCalledTimes(1)
    expect(
      vi
        .mocked(provider.request)
        .mock.calls.filter(([request]) => request.method === 'eth_getLogs'),
    ).toHaveLength(1)
    expect(apply).not.toHaveBeenCalled()
  })

  it('waits without requesting message logs or cache work while deployment confirmation is pending', async () => {
    const readLatest = vi.spyOn(BrowserEventCache.prototype, 'readLatest')
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          throw new Error('A pending group-message stream must not read logs.')
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
        resolveHistoryBoundary: async () => historyBoundary(4_990n),
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      recentMessages: [],
      safeHead: 4_988n,
      scannedRanges: 0,
      startBlock: 4_990n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(readLatest).not.toHaveBeenCalled()
  })

  it('keeps message history pending when the safe head only reaches confirmed emptiness', async () => {
    const readLatest = vi.spyOn(BrowserEventCache.prototype, 'readLatest')
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(21n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          throw new Error('Confirmed emptiness is not deployment proof.')
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
        resolveHistoryBoundary: async () => ({
          chainId: 1n,
          codeProbes: 4,
          confirmedThrough: {
            blockHash: blockHash(8n),
            blockNumber: 8n,
          },
          head: { blockHash: blockHash(20n), blockNumber: 20n },
          kind: 'pending-confirmation',
          preceding: { blockHash: blockHash(8n), blockNumber: 8n },
          startBlock: 9n,
        }),
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      head: 21n,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      recentMessages: [],
      safeHead: 9n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(readLatest).not.toHaveBeenCalled()
  })

  it('returns messages from multiple senders newest first', async () => {
    const logs = [
      rawMessage(2n, 1n, GROUP_A, ACCOUNT_A, 'First public message.'),
      rawMessage(3n, 2n, GROUP_A, ACCOUNT_B, 'Newest public reply.', {
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 8n,
      recentMessages: [
        {
          body: 'Newest public reply.',
          groupId: GROUP_A,
          mediaCid: '0x01701220',
          messageId: 2n,
          sender: getAddress(ACCOUNT_B),
        },
        {
          body: 'First public message.',
          groupId: GROUP_A,
          mediaCid: '0x',
          messageId: 1n,
          sender: getAddress(ACCOUNT_A),
        },
      ],
    })
  })

  it('decodes a whole dense boundary block but returns only 100 messages', async () => {
    const logs = Array.from({ length: 101 }, (_, index) =>
      rawMessage(
        2n,
        BigInt(index + 1),
        GROUP_A,
        ACCOUNT_A,
        `Public message ${index + 1}.`,
        { logIndex: index },
      ),
    )
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

    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })

    expect(snapshot.recentMessages).toHaveLength(100)
    expect(snapshot.recentMessages[0]?.messageId).toBe(101n)
    expect(snapshot.recentMessages.at(-1)?.messageId).toBe(2n)
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
            GROUP_A,
            ACCOUNT_A,
            'A valid public message.',
          )
          return [valid ? log : { ...log, data: '0x01' }]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: cacheStorage,
      }),
    ).rejects.toThrow(/invalid GroupMessageSent/i)
    valid = true
    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      recentMessages: [{ body: 'A valid public message.', messageId: 1n }],
    })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('repairs a malformed cached message before resuming from genesis', async () => {
    const cacheStorage = storage()
    const filter = getGroupMessageFilter(GROUP_A)
    const seed = createEventCursor({
      chainId: 1n,
      filter,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MESSAGE_START_BLOCK,
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
        logs: [{ ...cachedMessage(1n, 1n, GROUP_A, ACCOUNT_A), data: '0x01' }],
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
            rawMessage(2n, 1n, GROUP_A, ACCOUNT_A, 'Recovered from the chain.'),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      cacheReset: true,
      recentMessages: [{ body: 'Recovered from the chain.' }],
    })
    expect(fromBlock).toBe('0x0')
  })

  it('clears only the selected group and history-boundary cache scope', async () => {
    const cacheStorage = storage()
    const filterAB = getGroupMessageFilter(GROUP_A)
    const filterAC = getGroupMessageFilter(GROUP_B)
    const seedAB = createEventCursor({
      chainId: 1n,
      filter: filterAB,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MESSAGE_START_BLOCK,
    })
    const seedAC = createEventCursor({
      chainId: 1n,
      filter: filterAC,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MESSAGE_START_BLOCK,
    })
    const boundaryStart = 10n
    const seedAtBoundary = createEventCursor({
      chainId: 1n,
      filter: filterAB,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: boundaryStart,
    })
    for (const [filter, seed, log] of [
      [filterAB, seedAB, cachedMessage(1n, 1n, GROUP_A, ACCOUNT_A)],
      [filterAC, seedAC, cachedMessage(1n, 2n, GROUP_B, ACCOUNT_B)],
      [
        filterAB,
        seedAtBoundary,
        cachedMessage(boundaryStart, 3n, GROUP_A, ACCOUNT_B),
      ],
    ] as const) {
      const cache = await openEventCache({ ...cacheStorage, filter })
      try {
        await cache.apply(await cache.readLatest(seed), {
          caughtUp: true,
          cursor: {
            ...seed,
            checkpoints: [
              {
                blockHash: blockHash(log.blockNumber),
                blockNumber: log.blockNumber,
              },
            ],
            nextBlock: log.blockNumber + 1n,
          },
          head: log.blockNumber + POST_FEED_CONFIRMATION_DEPTH,
          logs: [log],
          safeHead: log.blockNumber,
          scannedRanges: 1,
        })
      } finally {
        cache.close()
      }
    }

    await resetGroupMessageStreamCache(1n, GROUP_A, cacheStorage, boundaryStart)

    const cleared = await openEventCache({ ...cacheStorage, filter: filterAB })
    try {
      await expect(cleared.readLatest(seedAtBoundary)).resolves.toMatchObject({
        cursor: seedAtBoundary,
        logs: [],
        reset: false,
        revision: 2n,
      })
      await expect(cleared.readLatest(seedAB)).resolves.toMatchObject({
        logs: [{ data: cachedMessage(1n, 1n, GROUP_A, ACCOUNT_A).data }],
        revision: 1n,
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
        logs: [{ data: cachedMessage(1n, 2n, GROUP_B, ACCOUNT_B).data }],
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/chain changed during group-message verification/i)
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/head moved behind the confirmed group messages/i)
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: 8n,
      safeHead: 9n,
    })
  })

  it('keeps a genesis fallback incomplete before a safe head exists', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          throw new Error('A pre-finality fallback has no confirmed history.')
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      head: 5n,
      historyBoundaryKind: 'genesis-fallback',
      indexedThrough: undefined,
      recentMessages: [],
      safeHead: undefined,
      scannedRanges: 0,
      startBlock: GROUP_MESSAGE_START_BLOCK,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/confirmed group-message checkpoint changed/i)
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
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
      synchronizeGroupMessageStream(provider, 1n, GROUP_A, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})
