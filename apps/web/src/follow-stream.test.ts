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
  FOLLOW_EVENT_START_BLOCK,
  assertIssuedFollowProjectionAnchor,
  authenticateIssuedFollowProjectionAnchor,
  resetFollowStreamCache,
  synchronizeFollowStream,
  type FollowStreamStorageOptions,
} from './follow-stream'
import {
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import { BrowserEventCache, openEventCache } from './event-cache'
import { createEventCursor, type IndexedEventLog } from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { openFollowProjectionRun } from './follow-projection-run'
import { getFollowersFilter, getFollowingFilter } from './protocol-events'
import {
  FOLLOW_SET_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000cccc' as Address
const FOLLOW_DATA_PARAMETERS = [{ type: 'bool' }] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint) {
  return keccak256(stringToHex(`transaction:${blockNumber.toString()}`))
}

function rawFollow(
  blockNumber: bigint,
  follower: Address,
  followed: Address,
  following: boolean,
  options: { data?: Hex; logIndex?: number } = {},
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data:
      options.data ?? encodeAbiParameters(FOLLOW_DATA_PARAMETERS, [following]),
    logIndex: toHex(options.logIndex ?? 0),
    removed: false,
    topics: [
      FOLLOW_SET_TOPIC,
      padHex(follower, { size: 32 }),
      padHex(followed, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function cachedFollow(
  blockNumber: bigint,
  follower: Address,
  followed: Address,
  following = true,
): IndexedEventLog {
  const follow = rawFollow(blockNumber, follower, followed, following)
  return {
    address: follow.address as Address,
    blockHash: follow.blockHash,
    blockNumber,
    data: follow.data,
    logIndex: 0,
    topics: follow.topics as readonly Hex[],
    transactionHash: follow.transactionHash,
    transactionIndex: 0,
  }
}

function storage(factory = new IDBFactory()): FollowStreamStorageOptions {
  return {
    databaseName: `follows-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

function providerFor(
  logs: readonly ReturnType<typeof rawFollow>[] = [],
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('follow stream synchronization', () => {
  it('rejects invalid scopes before RPC or storage work', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider

    await expect(
      synchronizeFollowStream(
        provider,
        1n,
        `0x${'00'.repeat(20)}`,
        'following',
      ),
    ).rejects.toThrow(/follow account is invalid/i)
    await expect(
      synchronizeFollowStream(
        provider,
        1n,
        ACCOUNT_A,
        'sideways' as 'following',
      ),
    ).rejects.toThrow(/follow direction is invalid/i)
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('resumes exact incoming and outgoing scopes through one bounded range per call', async () => {
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

    const partial = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: cacheStorage },
    )
    expect(partial).toMatchObject({
      account: getAddress(ACCOUNT_A),
      caughtUp: false,
      direction: 'following',
      indexedThrough: 1_999n,
      projectionAnchor: undefined,
      scannedRanges: 1,
    })
    const complete = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: cacheStorage },
    )
    expect(complete).toMatchObject({
      account: getAddress(ACCOUNT_A),
      caughtUp: true,
      direction: 'following',
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(complete.projectionAnchor).toMatchObject({
      account: getAddress(ACCOUNT_A),
      chainId: 1n,
      direction: 'following',
      head: 5_000n,
      safeHead: 4_988n,
    })
    assertIssuedFollowProjectionAnchor(complete.projectionAnchor)
    await synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'followers', {
      storage: cacheStorage,
    })

    expect(logQueries).toEqual([
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [FOLLOW_SET_TOPIC, padHex(ACCOUNT_A, { size: 32 })],
      },
      {
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: [FOLLOW_SET_TOPIC, padHex(ACCOUNT_A, { size: 32 })],
      },
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [FOLLOW_SET_TOPIC, null, padHex(ACCOUNT_A, { size: 32 })],
      },
    ])
  })

  it('starts at the verified deployment block and projects that cache scope', async () => {
    const deploymentBlock = 3_456n
    const logQueries: Array<{ fromBlock: string; toBlock: string }> = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getCode') {
          const [, blockTag] = params as [string, string]
          return blockTag === 'latest' || BigInt(blockTag) >= deploymentBlock
            ? PROTOCOL_RUNTIME_CODE
            : '0x'
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string; toBlock: string }]
          logQueries.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          })
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: cacheStorage },
    )

    expect(snapshot).toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      startBlock: deploymentBlock,
    })
    expect(snapshot.projectionAnchor?.follows.cursor.startBlock).toBe(
      deploymentBlock,
    )
    expect(logQueries).toEqual([
      { fromBlock: toHex(deploymentBlock), toBlock: toHex(4_988n) },
    ])

    const projection = await openFollowProjectionRun(
      snapshot.projectionAnchor!,
      cacheStorage,
    )
    expect(projection.startBlock).toBe(deploymentBlock)
    await expect(projection.advance()).resolves.toMatchObject({
      phase: 'authenticate',
    })
    await expect(projection.advance()).resolves.toMatchObject({
      phase: 'complete',
    })
  })

  it('rediscovers a replaced history anchor before mutating the event cache', async () => {
    let branch = 'a'
    let deploymentBlock = 37n
    let reorganized = false
    let scanned = false
    const logQueries: Array<{ fromBlock: string; toBlock: string }> = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_chainId') {
          if (scanned && !reorganized) {
            branch = 'b'
            deploymentBlock = 41n
            reorganized = true
          }
          return '0x1'
        }
        if (method === 'eth_blockNumber') return '0x64'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          const blockNumber = BigInt(number)
          return { hash: blockHash(blockNumber, branch), number }
        }
        if (method === 'eth_getCode') {
          const [, blockTag] = params as [string, string]
          return blockTag === 'latest' || BigInt(blockTag) >= deploymentBlock
            ? PROTOCOL_RUNTIME_CODE
            : '0x'
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string; toBlock: string }]
          logQueries.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          })
          scanned = true
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const apply = vi.spyOn(BrowserEventCache.prototype, 'apply')

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      startBlock: 41n,
    })
    expect(logQueries).toEqual([
      { fromBlock: '0x25', toBlock: '0x58' },
      { fromBlock: '0x29', toBlock: '0x58' },
    ])
    expect(apply).toHaveBeenCalledOnce()
  })

  it('falls back to genesis when the RPC cannot serve historical code', async () => {
    let fromBlock = ''
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getCode') {
          const [, blockTag] = params as [string, string]
          if (blockTag === 'latest') return PROTOCOL_RUNTIME_CODE
          throw new Error('missing trie node')
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string }]
          fromBlock = filter.fromBlock
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: storage(),
      }),
    ).resolves.toMatchObject({ caughtUp: true, startBlock: 0n })
    expect(fromBlock).toBe('0x0')
  })

  it('does not start a genesis scan while a historical code request is timed out', async () => {
    vi.useFakeTimers()
    const requests: ProviderRequest[] = []
    const provider: Eip1193Provider = {
      async request(request) {
        requests.push(request)
        const { method, params } = request
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getCode') {
          const [, blockTag] = params as [string, string]
          if (blockTag === 'latest') return PROTOCOL_RUNTIME_CODE
          return new Promise<unknown>(() => undefined)
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const outcome = synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WALLET_READ_TIMEOUT_MS)
    const error = await outcome

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/history discovery timed out/i)
    expect(requests).not.toContainEqual(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('waits to project a deployment newer than the confirmed head', async () => {
    let head = 20n
    const logQueries: Array<{ fromBlock: string; toBlock: string }> = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(head)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getCode') {
          const [, blockTag] = params as [string, string]
          return blockTag === 'latest' || BigInt(blockTag) >= 14n
            ? PROTOCOL_RUNTIME_CODE
            : '0x'
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string; toBlock: string }]
          logQueries.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          })
          return [rawFollow(14n, ACCOUNT_A, ACCOUNT_B, true)]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: undefined,
      projectionAnchor: undefined,
      safeHead: 8n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    expect(logQueries).toEqual([])

    head = 32n
    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 20n,
      projectionAnchor: {
        follows: { cursor: { startBlock: 14n } },
      },
      recentSignals: [{ blockNumber: 14n, following: true }],
      safeHead: 20n,
      scannedRanges: 1,
      startBlock: 14n,
    })
    expect(logQueries).toEqual([{ fromBlock: '0xe', toBlock: '0x14' }])
  })

  it('returns public follow and unfollow signals newest first', async () => {
    const provider = providerFor([
      rawFollow(2n, ACCOUNT_A, ACCOUNT_B, true),
      rawFollow(3n, ACCOUNT_A, ACCOUNT_C, true),
      rawFollow(4n, ACCOUNT_A, ACCOUNT_B, false),
    ])

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      recentSignals: [
        {
          followed: getAddress(ACCOUNT_B),
          follower: getAddress(ACCOUNT_A),
          following: false,
        },
        {
          followed: getAddress(ACCOUNT_C),
          follower: getAddress(ACCOUNT_A),
          following: true,
        },
        {
          followed: getAddress(ACCOUNT_B),
          follower: getAddress(ACCOUNT_A),
          following: true,
        },
      ],
    })
  })

  it.each([
    ['following', rawFollow(2n, ACCOUNT_B, ACCOUNT_A, true)],
    ['followers', rawFollow(2n, ACCOUNT_A, ACCOUNT_B, true)],
  ] as const)(
    'rejects a %s response for another account',
    async (direction, log) => {
      await expect(
        synchronizeFollowStream(providerFor([log]), 1n, ACCOUNT_A, direction, {
          storage: storage(),
        }),
      ).rejects.toThrow(/invalid event log topics|another account/i)
    },
  )

  it('validates a dense boundary block before returning only 200 signals', async () => {
    const logs = Array.from({ length: 201 }, (_, index) =>
      rawFollow(2n, ACCOUNT_A, ACCOUNT_B, index % 2 === 0, {
        logIndex: index,
      }),
    )
    const snapshot = await synchronizeFollowStream(
      providerFor(logs),
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )

    expect(snapshot.recentSignals).toHaveLength(200)
    expect(snapshot.recentSignals[0]?.logIndex).toBe(200)
    expect(snapshot.recentSignals.at(-1)?.logIndex).toBe(1)
  })

  it('does not advance when fresh follow data is malformed', async () => {
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
          const log = rawFollow(2n, ACCOUNT_A, ACCOUNT_B, true)
          return [valid ? log : { ...log, data: '0x01' }]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: cacheStorage,
      }),
    ).rejects.toThrow(/invalid FollowSet/i)
    valid = true
    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({ recentSignals: [{ following: true }] })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('repairs malformed cached follow before restarting at genesis', async () => {
    const cacheStorage = storage()
    const filter = getFollowingFilter(ACCOUNT_A)
    const seed = createEventCursor({
      chainId: 1n,
      filter,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: FOLLOW_EVENT_START_BLOCK,
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
            ...cachedFollow(1n, ACCOUNT_A, ACCOUNT_B),
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
          return [rawFollow(2n, ACCOUNT_A, ACCOUNT_B, true)]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      cacheReset: true,
      recentSignals: [
        {
          followed: getAddress(ACCOUNT_B),
          follower: getAddress(ACCOUNT_A),
          following: true,
        },
      ],
    })
    expect(fromBlock).toBe('0x0')
  })

  it('clears only the selected follow scope', async () => {
    const cacheStorage = storage()
    const filterA = getFollowingFilter(ACCOUNT_A)
    const filterB = getFollowersFilter(ACCOUNT_A)
    const seedA = createEventCursor({
      chainId: 1n,
      filter: filterA,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: FOLLOW_EVENT_START_BLOCK,
    })
    const seedB = createEventCursor({
      chainId: 1n,
      filter: filterB,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: FOLLOW_EVENT_START_BLOCK,
    })
    for (const [filter, seed, log] of [
      [filterA, seedA, cachedFollow(1n, ACCOUNT_A, ACCOUNT_B)],
      [filterB, seedB, cachedFollow(1n, ACCOUNT_B, ACCOUNT_A)],
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

    await resetFollowStreamCache(1n, ACCOUNT_A, 'following', cacheStorage)

    const cleared = await openEventCache({ ...cacheStorage, filter: filterA })
    try {
      await expect(cleared.readLatest(seedA)).resolves.toMatchObject({
        cursor: seedA,
        logs: [],
        revision: 2n,
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
        logs: [{ data: cachedFollow(1n, ACCOUNT_B, ACCOUNT_A).data }],
        revision: 1n,
      })
    } finally {
      preserved.close()
    }
  })

  it('rejects unverified code without requesting follow logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        storage: storage(),
      }),
    ).rejects.toThrow(/verified Lifeinvader v1/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('fails closed when confirmation depth is lost or the safe head advances', async () => {
    const regressingHeads = [100n, 100n, 100n, 89n]
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
      synchronizeFollowStream(regressing, 1n, ACCOUNT_A, 'following', {
        storage: storage(),
      }),
    ).rejects.toThrow(/head moved behind the confirmed follows/i)

    const advancingHeads = [20n, 20n, 20n, 21n]
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
      synchronizeFollowStream(advancing, 1n, ACCOUNT_A, 'following', {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: 8n,
      projectionAnchor: undefined,
      safeHead: 9n,
    })
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
      synchronizeFollowStream(providerFor(), 1n, ACCOUNT_A, 'following', {
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
      synchronizeFollowStream(provider, 1n, ACCOUNT_A, 'following', {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(listeners.size).toBe(0)
  })
})

describe('follow projection anchors', () => {
  it('issues an immutable page-local capability and rejects copies', async () => {
    const snapshot = await synchronizeFollowStream(
      providerFor(),
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    const anchor = snapshot.projectionAnchor!

    expect(Object.isFrozen(anchor)).toBe(true)
    expect(Object.isFrozen(anchor.follows)).toBe(true)
    expect(Object.isFrozen(anchor.follows.cursor)).toBe(true)
    expect(Object.isFrozen(anchor.follows.cursor.checkpoints)).toBe(true)
    assertIssuedFollowProjectionAnchor(anchor)
    expect(() => assertIssuedFollowProjectionAnchor({ ...anchor })).toThrow(
      /not issued by this page/i,
    )
  })

  it('brackets cache authentication with canonical wallet checks', async () => {
    const provider = providerFor()
    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    const authenticateCache = vi.fn(async () => undefined)

    await expect(
      authenticateIssuedFollowProjectionAnchor(
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
    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    const readsBeforeAuthentication = vi.mocked(provider.request).mock.calls
      .length
    const authenticateCache = vi.fn(async () => undefined)
    const controller = new AbortController()
    controller.abort()

    await expect(
      authenticateIssuedFollowProjectionAnchor(
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
    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    const authenticateCache = vi.fn(async () => {
      head = 15n
    })

    await expect(
      authenticateIssuedFollowProjectionAnchor(
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
    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    const controller = new AbortController()
    const authenticateCache = vi.fn(
      () =>
        new Promise<void>(() => {
          queueMicrotask(() => controller.abort())
        }),
    )

    await expect(
      authenticateIssuedFollowProjectionAnchor(
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
    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    const authenticateCache = vi.fn(
      () =>
        new Promise<void>(() => {
          queueMicrotask(() => listeners.get('chainChanged')?.('0x2'))
        }),
    )

    await expect(
      authenticateIssuedFollowProjectionAnchor(
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
    const snapshot = await synchronizeFollowStream(
      provider,
      1n,
      ACCOUNT_A,
      'following',
      { storage: storage() },
    )
    branch = 'b'
    const authenticateCache = vi.fn(async () => undefined)

    await expect(
      authenticateIssuedFollowProjectionAnchor(
        snapshot.projectionAnchor!,
        authenticateCache,
      ),
    ).rejects.toThrow(/checkpoint changed/i)
    expect(authenticateCache).not.toHaveBeenCalled()
  })
})
