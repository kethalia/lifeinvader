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
  GROUP_MEMBERSHIP_EVENT_START_BLOCK,
  assertIssuedGroupMembershipProjectionAnchor,
  authenticateIssuedGroupMembershipProjectionAnchor,
  resetGroupMembershipStreamCache,
  synchronizeGroupMembershipStream,
  type GroupMembershipStreamStorageOptions,
  type SynchronizeGroupMembershipStreamOptions,
} from './group-membership-stream'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { BrowserEventCache, openEventCache } from './event-cache'
import { createEventCursor, type IndexedEventLog } from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { getGroupMembershipFilter } from './protocol-events'
import {
  GROUP_MEMBERSHIP_SET_TOPIC,
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
const MEMBERSHIP_DATA_PARAMETERS = [{ type: 'bool' }] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint) {
  return keccak256(stringToHex(`transaction:${blockNumber.toString()}`))
}

function rawMembership(
  blockNumber: bigint,
  groupId: bigint,
  account: Address,
  joined: boolean,
  options: { data?: Hex; logIndex?: number } = {},
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data:
      options.data ?? encodeAbiParameters(MEMBERSHIP_DATA_PARAMETERS, [joined]),
    logIndex: toHex(options.logIndex ?? 0),
    removed: false,
    topics: [
      GROUP_MEMBERSHIP_SET_TOPIC,
      padHex(toHex(groupId), { size: 32 }),
      padHex(account, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function cachedMembership(
  blockNumber: bigint,
  groupId: bigint,
  account: Address,
  joined = true,
): IndexedEventLog {
  const membership = rawMembership(blockNumber, groupId, account, joined)
  return {
    address: membership.address as Address,
    blockHash: membership.blockHash,
    blockNumber,
    data: membership.data,
    logIndex: 0,
    topics: membership.topics as readonly Hex[],
    transactionHash: membership.transactionHash,
    transactionIndex: 0,
  }
}

function storage(
  factory = new IDBFactory(),
): GroupMembershipStreamStorageOptions {
  return {
    databaseName: `group-memberships-${crypto.randomUUID()}`,
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
  options: SynchronizeGroupMembershipStreamOptions = {},
) {
  return synchronizeGroupMembershipStream(provider, chainId, groupId, {
    resolveHistoryBoundary: unsupportedHistory,
    ...options,
  })
}

function providerFor(
  logs: readonly ReturnType<typeof rawMembership>[] = [],
  head = 20n,
) {
  return {
    async request({ method, params }: ProviderRequest) {
      if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') return toHex(head)
      if (method === 'eth_getBlockByNumber') {
        const [number] = params as [string]
        return { hash: blockHash(BigInt(number)), number }
      }
      if (method === 'eth_getLogs') return logs
      throw new Error(`Unexpected RPC method: ${method}`)
    },
  } satisfies Eip1193Provider
}

afterEach(() => vi.restoreAllMocks())

describe('group-membership stream synchronization', () => {
  it('rejects invalid group identifiers before RPC or storage work', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider

    await expect(
      synchronizeGroupMembershipStream(provider, 1n, 0n),
    ).rejects.toThrow(/group identifier is invalid/i)
    await expect(
      synchronizeGroupMembershipStream(provider, 1n, 1n << 256n),
    ).rejects.toThrow(/group identifier is invalid/i)
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('resumes exact independent groups through one bounded range per call', async () => {
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

    const partial = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: cacheStorage,
    })
    expect(partial).toMatchObject({
      caughtUp: false,
      groupId: GROUP_A,
      historyBoundaryKind: 'genesis-fallback',
      indexedThrough: 1_999n,
      projectionAnchor: undefined,
      scannedRanges: 1,
      startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
    })
    const complete = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: cacheStorage,
    })
    expect(complete).toMatchObject({
      caughtUp: true,
      groupId: GROUP_A,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(complete.projectionAnchor).toMatchObject({
      chainId: 1n,
      groupId: GROUP_A,
      head: 5_000n,
      safeHead: 4_988n,
    })
    assertIssuedGroupMembershipProjectionAnchor(complete.projectionAnchor)
    await synchronizeWithFallback(provider, 1n, GROUP_B, {
      storage: cacheStorage,
    })

    expect(logQueries).toEqual([
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [
          GROUP_MEMBERSHIP_SET_TOPIC,
          padHex(toHex(GROUP_A), { size: 32 }),
        ],
      },
      {
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: [
          GROUP_MEMBERSHIP_SET_TOPIC,
          padHex(toHex(GROUP_A), { size: 32 }),
        ],
      },
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [
          GROUP_MEMBERSHIP_SET_TOPIC,
          padHex(toHex(GROUP_B), { size: 32 }),
        ],
      },
    ])
  })

  it('starts an exact-group stream at the verified deployment boundary', async () => {
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
          return [rawMembership(3_001n, GROUP_A, ACCOUNT_A, true)]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    const snapshot = await synchronizeGroupMembershipStream(
      provider,
      1n,
      GROUP_A,
      { resolveHistoryBoundary, storage: storage() },
    )

    expect(snapshot).toMatchObject({
      caughtUp: true,
      historyBoundaryKind: 'confirmed',
      indexedThrough: 4_988n,
      recentSignals: [{ account: getAddress(ACCOUNT_A), joined: true }],
      scannedRanges: 1,
      startBlock: 3_000n,
    })
    expect(snapshot.projectionAnchor?.memberships.cursor.startBlock).toBe(
      3_000n,
    )
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
          GROUP_MEMBERSHIP_SET_TOPIC,
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

  it('fails closed when history discovery does not explicitly reject historical state', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMembershipStream(provider, 1n, GROUP_A, {
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

  it('discards one fetched range when the history anchor was replaced', async () => {
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
      synchronizeGroupMembershipStream(provider, 1n, GROUP_A, {
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

  it('waits without requesting logs or opening cache work while deployment confirmation is pending', async () => {
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
          throw new Error('A pending membership stream must not read logs.')
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMembershipStream(provider, 1n, GROUP_A, {
        resolveHistoryBoundary: async () => historyBoundary(4_990n),
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      projectionAnchor: undefined,
      recentSignals: [],
      safeHead: 4_988n,
      scannedRanges: 0,
      startBlock: 4_990n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(readLatest).not.toHaveBeenCalled()
  })

  it('stays pending when the safe head only reaches confirmed emptiness', async () => {
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
      synchronizeGroupMembershipStream(provider, 1n, GROUP_A, {
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
      projectionAnchor: undefined,
      safeHead: 9n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(readLatest).not.toHaveBeenCalled()
  })

  it('returns public join and leave signals newest first', async () => {
    const provider = providerFor([
      rawMembership(2n, GROUP_A, ACCOUNT_A, true),
      rawMembership(3n, GROUP_A, ACCOUNT_B, true),
      rawMembership(4n, GROUP_A, ACCOUNT_A, false),
    ])

    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      recentSignals: [
        {
          account: getAddress(ACCOUNT_A),
          groupId: GROUP_A,
          joined: false,
        },
        {
          account: getAddress(ACCOUNT_B),
          groupId: GROUP_A,
          joined: true,
        },
        {
          account: getAddress(ACCOUNT_A),
          groupId: GROUP_A,
          joined: true,
        },
      ],
    })
  })

  it('validates a dense boundary block before returning only 200 signals', async () => {
    const logs = Array.from({ length: 201 }, (_, index) =>
      rawMembership(2n, GROUP_A, ACCOUNT_A, index % 2 === 0, {
        logIndex: index,
      }),
    )
    const snapshot = await synchronizeWithFallback(
      providerFor(logs),
      1n,
      GROUP_A,
      { storage: storage() },
    )

    expect(snapshot.recentSignals).toHaveLength(200)
    expect(snapshot.recentSignals[0]?.logIndex).toBe(200)
    expect(snapshot.recentSignals.at(-1)?.logIndex).toBe(1)
  })

  it('does not advance when fresh membership data is malformed', async () => {
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
          const log = rawMembership(2n, GROUP_A, ACCOUNT_A, true)
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
    ).rejects.toThrow(/invalid GroupMembershipSet/i)
    valid = true
    await expect(
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({ recentSignals: [{ joined: true }] })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('repairs malformed cached membership before restarting at genesis', async () => {
    const cacheStorage = storage()
    const filter = getGroupMembershipFilter(GROUP_A)
    const seed = createEventCursor({
      chainId: 1n,
      filter,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
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
          {
            ...cachedMembership(1n, GROUP_A, ACCOUNT_A),
            data: '0x01',
          },
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
          return [rawMembership(2n, GROUP_A, ACCOUNT_A, true)]
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
      recentSignals: [{ account: getAddress(ACCOUNT_A), joined: true }],
    })
    expect(fromBlock).toBe('0x0')
  })

  it('clears only the selected group and history-boundary cache scope', async () => {
    const cacheStorage = storage()
    const filterA = getGroupMembershipFilter(GROUP_A)
    const filterB = getGroupMembershipFilter(GROUP_B)
    const seedA = createEventCursor({
      chainId: 1n,
      filter: filterA,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
    })
    const seedB = createEventCursor({
      chainId: 1n,
      filter: filterB,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
    })
    const boundaryStart = 10n
    const seedAtBoundary = createEventCursor({
      chainId: 1n,
      filter: filterA,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: boundaryStart,
    })
    for (const [filter, seed, log] of [
      [filterA, seedA, cachedMembership(1n, GROUP_A, ACCOUNT_A)],
      [filterB, seedB, cachedMembership(1n, GROUP_B, ACCOUNT_B)],
      [
        filterA,
        seedAtBoundary,
        cachedMembership(boundaryStart, GROUP_A, ACCOUNT_B),
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

    await resetGroupMembershipStreamCache(
      1n,
      GROUP_A,
      cacheStorage,
      boundaryStart,
    )

    const cleared = await openEventCache({ ...cacheStorage, filter: filterA })
    try {
      await expect(cleared.readLatest(seedAtBoundary)).resolves.toMatchObject({
        cursor: seedAtBoundary,
        logs: [],
        revision: 2n,
      })
      await expect(cleared.readLatest(seedA)).resolves.toMatchObject({
        logs: [{ data: cachedMembership(1n, GROUP_A, ACCOUNT_A).data }],
        revision: 1n,
      })
    } finally {
      cleared.close()
    }
    const preserved = await openEventCache({
      ...cacheStorage,
      filter: filterB,
    })
    try {
      await expect(preserved.readLatest(seedB)).resolves.toMatchObject({
        logs: [{ data: cachedMembership(1n, GROUP_B, ACCOUNT_B).data }],
        revision: 1n,
      })
    } finally {
      preserved.close()
    }
  })

  it('rejects unverified code without requesting membership logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupMembershipStream(provider, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/verified Lifeinvader v1/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('fails closed when confirmation depth is lost or the safe head advances', async () => {
    const regressingHeads = [100n, 89n]
    const regressing = providerFor()
    regressing.request = vi.fn(async ({ method, params }) => {
      if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') {
        return toHex(regressingHeads.shift() ?? 89n)
      }
      if (method === 'eth_getBlockByNumber') {
        const [number] = params as [string]
        return { hash: blockHash(BigInt(number)), number }
      }
      if (method === 'eth_getLogs') return []
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    await expect(
      synchronizeWithFallback(regressing, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/head moved behind the confirmed group memberships/i)

    const advancingHeads = [20n, 21n]
    const advancing = providerFor()
    advancing.request = vi.fn(async ({ method, params }) => {
      if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') {
        return toHex(advancingHeads.shift() ?? 21n)
      }
      if (method === 'eth_getBlockByNumber') {
        const [number] = params as [string]
        return { hash: blockHash(BigInt(number)), number }
      }
      if (method === 'eth_getLogs') return []
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    await expect(
      synchronizeWithFallback(advancing, 1n, GROUP_A, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: 8n,
      projectionAnchor: undefined,
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
      projectionAnchor: undefined,
      safeHead: undefined,
      scannedRanges: 0,
      startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('rejects a post-apply page from another cache revision', async () => {
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
      synchronizeWithFallback(providerFor(), 1n, GROUP_A, {
        storage: storage(),
      }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('cancels stalled context work and removes wallet listeners', async () => {
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
      synchronizeWithFallback(provider, 1n, GROUP_A, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(listeners.size).toBe(0)
  })
})

describe('group-membership projection anchors', () => {
  it('issues an immutable page-local capability and rejects copies', async () => {
    const snapshot = await synchronizeWithFallback(providerFor(), 1n, GROUP_A, {
      storage: storage(),
    })
    const anchor = snapshot.projectionAnchor!

    expect(Object.isFrozen(anchor)).toBe(true)
    expect(Object.isFrozen(anchor.memberships)).toBe(true)
    expect(Object.isFrozen(anchor.memberships.cursor)).toBe(true)
    expect(Object.isFrozen(anchor.memberships.cursor.checkpoints)).toBe(true)
    assertIssuedGroupMembershipProjectionAnchor(anchor)
    expect(() =>
      assertIssuedGroupMembershipProjectionAnchor({ ...anchor }),
    ).toThrow(/not issued by this page/i)
  })

  it('brackets cache authentication with canonical wallet checks', async () => {
    const provider = providerFor()
    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })
    const authenticateCache = vi.fn(async () => undefined)

    await expect(
      authenticateIssuedGroupMembershipProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
      ),
    ).resolves.toBeUndefined()
    expect(authenticateCache).toHaveBeenCalledTimes(1)
  })

  it('does no wallet or cache work for an already aborted authentication', async () => {
    const base = providerFor()
    const provider: Eip1193Provider = {
      request: vi.fn((request) => base.request(request)),
    }
    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })
    const readsBeforeAuthentication = vi.mocked(provider.request).mock.calls
      .length
    const authenticateCache = vi.fn(async () => undefined)
    const controller = new AbortController()
    controller.abort()

    await expect(
      authenticateIssuedGroupMembershipProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(readsBeforeAuthentication)
    expect(authenticateCache).not.toHaveBeenCalled()
  })

  it('rechecks confirmation depth after cache authentication', async () => {
    let head = 20n
    const base = providerFor()
    const provider: Eip1193Provider = {
      request: vi.fn((request) => {
        if (request.method === 'eth_blockNumber')
          return Promise.resolve(toHex(head))
        return base.request(request)
      }),
    }
    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })
    const authenticateCache = vi.fn(async () => {
      head = 15n
    })

    await expect(
      authenticateIssuedGroupMembershipProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
      ),
    ).rejects.toThrow(/head moved behind/i)
    expect(authenticateCache).toHaveBeenCalledTimes(1)
  })

  it('cancels a stalled cache authentication and releases listeners', async () => {
    const base = providerFor()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn((request) => base.request(request)),
    }
    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })
    const controller = new AbortController()
    const authenticateCache = vi.fn(
      () =>
        new Promise<void>(() => {
          queueMicrotask(() => controller.abort())
        }),
    )

    await expect(
      authenticateIssuedGroupMembershipProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/i)
    expect(authenticateCache).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('interrupts stalled cache authentication when the wallet chain changes', async () => {
    const base = providerFor()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn((request) => base.request(request)),
    }
    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })
    const authenticateCache = vi.fn(
      () =>
        new Promise<void>(() => {
          queueMicrotask(() => listeners.get('chainChanged')?.('0x2'))
        }),
    )

    await expect(
      authenticateIssuedGroupMembershipProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
      ),
    ).rejects.toThrow(/chain changed/i)
    expect(authenticateCache).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('rejects a replaced checkpoint before authenticating the cache', async () => {
    let branch = 'a'
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number), branch), number }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const snapshot = await synchronizeWithFallback(provider, 1n, GROUP_A, {
      storage: storage(),
    })
    branch = 'b'
    const authenticateCache = vi.fn(async () => undefined)

    await expect(
      authenticateIssuedGroupMembershipProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
      ),
    ).rejects.toThrow(/checkpoint changed/i)
    expect(authenticateCache).not.toHaveBeenCalled()
  })
})
