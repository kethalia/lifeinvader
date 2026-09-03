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
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { BrowserEventCache, openEventCache } from './event-cache'
import { createEventCursor, type IndexedEventLog } from './event-indexer'
import {
  assertIssuedProfileProjectionAnchor,
  authenticateIssuedProfileProjectionAnchor,
  PROFILE_EVENT_START_BLOCK,
  resetProfileStreamCache,
  synchronizeProfileStream,
  type ProfileStreamStorageOptions,
} from './profile-stream'
import { PROFILE_SET_FILTER } from './protocol-events'
import {
  PROFILE_SET_TOPIC,
  LIFEINVADER_INIT_CODE,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const PROFILE_DATA_PARAMETERS = [
  { type: 'string' },
  { type: 'string' },
  { type: 'bytes' },
] as const
const PUBLICATION_DATA_PARAMETERS = [
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

function rawProfile(
  blockNumber: bigint,
  options: {
    account?: Address
    avatarCid?: Hex
    bio?: string
    data?: Hex
    displayName?: string
  } = {},
) {
  const account = options.account ?? ACCOUNT_A
  const avatarCid = options.avatarCid ?? '0x01701220'
  const bio = options.bio ?? `Public bio at block ${blockNumber.toString()}`
  const displayName = options.displayName ?? 'Tracey'
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data:
      options.data ??
      encodeAbiParameters(PROFILE_DATA_PARAMETERS, [
        displayName,
        bio,
        avatarCid,
      ]),
    logIndex: '0x0',
    removed: false,
    topics: [PROFILE_SET_TOPIC, padHex(account, { size: 32 })],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function cachedPost(): IndexedEventLog {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(2n),
    blockNumber: 2n,
    data: encodeAbiParameters(PUBLICATION_DATA_PARAMETERS, [
      'Another event.',
      '0x',
    ]),
    logIndex: 0,
    topics: [
      POST_PUBLISHED_TOPIC,
      padHex(toHex(1n), { size: 32 }),
      padHex(ACCOUNT_A, { size: 32 }),
    ],
    transactionHash: transactionHash(2n),
    transactionIndex: 0,
  }
}

function cachedProfile(blockNumber: bigint): IndexedEventLog {
  const profile = rawProfile(blockNumber)
  return {
    address: profile.address as Address,
    blockHash: profile.blockHash,
    blockNumber,
    data: profile.data as Hex,
    logIndex: 0,
    topics: profile.topics as readonly Hex[],
    transactionHash: profile.transactionHash,
    transactionIndex: 0,
  }
}

function storage(factory = new IDBFactory()): ProfileStreamStorageOptions {
  return {
    databaseName: `profiles-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())

describe('profile stream synchronization', () => {
  it('clears the profile scope for a bounded projection-corruption repair', async () => {
    const cacheStorage = storage()
    const seed = createEventCursor({
      chainId: 1n,
      filter: PROFILE_SET_FILTER,
      finalityDepth: 12n,
      startBlock: PROFILE_EVENT_START_BLOCK,
    })
    const cache = await openEventCache({
      ...cacheStorage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      const cursor = {
        ...seed,
        checkpoints: [{ blockHash: blockHash(1n), blockNumber: 1n }],
        nextBlock: 2n,
      }
      await cache.apply(await cache.readLatest(seed), {
        caughtUp: true,
        cursor,
        head: 13n,
        logs: [cachedProfile(1n)],
        safeHead: 1n,
        scannedRanges: 1,
      })
    } finally {
      cache.close()
    }

    await resetProfileStreamCache(1n, cacheStorage)

    const reopened = await openEventCache({
      ...cacheStorage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      await expect(reopened.readLatest(seed)).resolves.toMatchObject({
        cursor: seed,
        logs: [],
        reset: false,
        revision: 2n,
      })
    } finally {
      reopened.close()
    }
  })

  it('resumes one global stream through exactly one bounded range per call', async () => {
    const logQueries: Array<{
      address: Address
      fromBlock: string
      toBlock: string
      topics: readonly unknown[]
    }> = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
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
              address: Address
              fromBlock: string
              toBlock: string
              topics: readonly unknown[]
            },
          ]
          logQueries.push(filter)
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    const first = await synchronizeProfileStream(provider, 1n, {
      storage: cacheStorage,
    })
    expect(first).toMatchObject({
      caughtUp: false,
      indexedThrough: 1_999n,
      projectionAnchor: undefined,
      scannedRanges: 1,
    })

    const second = await synchronizeProfileStream(provider, 1n, {
      storage: cacheStorage,
    })
    expect(second).toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      projectionAnchor: {
        chainId: 1n,
        profiles: {
          cursor: { nextBlock: 4_989n },
          revision: 2n,
        },
        head: 5_000n,
        safeHead: 4_988n,
      },
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(logQueries).toEqual([
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: PROFILE_SET_FILTER.topics,
      },
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: PROFILE_SET_FILTER.topics,
      },
    ])
  })

  it('issues immutable anchors bound to an authenticated provider context', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    let head = 20n
    let safeHeadHash = blockHash(8n)
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(head)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          const blockNumber = BigInt(number)
          return {
            hash: blockNumber === 8n ? safeHeadHash : blockHash(blockNumber),
            number,
          }
        }
        if (method === 'eth_getLogs') return []
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }
    const synchronized = await synchronizeProfileStream(provider, 1n, {
      storage: storage(),
    })
    const anchor = synchronized.projectionAnchor
    if (!anchor) throw new Error('The profile stream did not issue an anchor.')

    expect(Object.isFrozen(anchor)).toBe(true)
    expect(Object.isFrozen(anchor.profiles)).toBe(true)
    expect(Object.isFrozen(anchor.profiles.cursor)).toBe(true)
    expect(Object.isFrozen(anchor.profiles.cursor.checkpoints[0])).toBe(true)
    expect(() => assertIssuedProfileProjectionAnchor({ ...anchor })).toThrow(
      /not issued by this page/i,
    )
    expect(() => assertIssuedProfileProjectionAnchor(anchor)).not.toThrow()

    const authenticateCache = vi.fn(async () => undefined)
    await authenticateIssuedProfileProjectionAnchor(anchor, authenticateCache)
    expect(authenticateCache).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)

    const cancelled = new AbortController()
    cancelled.abort()
    const requestsBeforeCancellation = vi.mocked(provider.request).mock.calls
      .length
    await expect(
      authenticateIssuedProfileProjectionAnchor(
        anchor,
        authenticateCache,
        cancelled.signal,
      ),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(requestsBeforeCancellation)
    expect(authenticateCache).toHaveBeenCalledOnce()

    safeHeadHash = blockHash(8n, 'replacement')
    await expect(
      authenticateIssuedProfileProjectionAnchor(anchor, authenticateCache),
    ).rejects.toThrow(/checkpoint changed/i)
    expect(authenticateCache).toHaveBeenCalledOnce()

    safeHeadHash = blockHash(8n)
    head = 19n
    await expect(
      authenticateIssuedProfileProjectionAnchor(anchor, authenticateCache),
    ).rejects.toThrow(/head moved behind/i)
    expect(authenticateCache).toHaveBeenCalledOnce()

    head = 20n
    await expect(
      authenticateIssuedProfileProjectionAnchor(anchor, async () => {
        listeners.get('chainChanged')?.('0x2')
      }),
    ).rejects.toThrow(/chain changed during profile anchor authentication/i)
    expect(listeners.size).toBe(0)
  })

  it('returns validated recent profile events newest first without claiming complete state', async () => {
    const logs = [
      rawProfile(2n, {
        bio: 'First public bio.',
        displayName: 'First profile',
      }),
      rawProfile(3n, {
        account: ACCOUNT_B,
        avatarCid: '0x',
        bio: 'Newest public bio.',
        displayName: 'Newest profile',
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
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 8n,
      projectionAnchor: {
        chainId: 1n,
        profiles: { cursor: { nextBlock: 9n }, revision: 1n },
        head: 20n,
        safeHead: 8n,
      },
      recentProfiles: [
        {
          account: getAddress(ACCOUNT_B),
          avatarCid: '0x',
          bio: 'Newest public bio.',
          displayName: 'Newest profile',
        },
        {
          account: getAddress(ACCOUNT_A),
          avatarCid: '0x01701220',
          bio: 'First public bio.',
          displayName: 'First profile',
        },
      ],
    })
  })

  it('does not advance when fresh profile data is invalid', async () => {
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
          return [
            rawProfile(2n, {
              data: valid ? undefined : '0x01',
              displayName: 'A valid profile',
            }),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeProfileStream(provider, 1n, { storage: cacheStorage }),
    ).rejects.toThrow(/invalid ProfileSet/i)
    valid = true
    await expect(
      synchronizeProfileStream(provider, 1n, { storage: cacheStorage }),
    ).resolves.toMatchObject({
      recentProfiles: [{ displayName: 'A valid profile' }],
    })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('rejects unverified code without requesting profile logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/verified Lifeinvader v1/i)
    expect(provider.request).toHaveBeenCalledTimes(3)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('binds protocol inspection to the selected chain without provider events', async () => {
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
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/different wallet chain/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('rechecks the chain after the concurrent final-head sample', async () => {
    let blockReads = 0
    let selectedChain = '0x1'
    const provider: Eip1193Provider = {
      async request({ method }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return selectedChain
        if (method === 'eth_blockNumber') {
          blockReads += 1
          if (blockReads === 2) selectedChain = '0x2'
          return '0x5'
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/different wallet chain/i)
    expect(blockReads).toBe(2)
  })

  it('observes a wallet chain change during stream verification', async () => {
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
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/chain changed during profile verification/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(listeners.size).toBe(0)
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
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/confirmed profile checkpoint changed/i)
    expect(endpointReads).toBe(5)
  })

  it('withholds a projection anchor when the final safe head moves ahead', async () => {
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
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: 8n,
      projectionAnchor: undefined,
      safeHead: 9n,
    })
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
      synchronizeProfileStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizeProfileStream(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).not.toHaveBeenCalled()
  })

  it('honors cancellation after a cache read before recovery mutation', async () => {
    const controller = new AbortController()
    const enteredRead = deferred<void>()
    const releaseRead = deferred<void>()
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }
    const readLatest = BrowserEventCache.prototype.readLatest
    vi.spyOn(BrowserEventCache.prototype, 'readLatest').mockImplementationOnce(
      async function (this: BrowserEventCache, seed, limit) {
        const page = await readLatest.call(this, seed, limit)
        enteredRead.resolve()
        await releaseRead.promise
        return { ...page, logs: [cachedPost()] }
      },
    )
    const clear = vi.spyOn(BrowserEventCache.prototype, 'clear')

    const pending = synchronizeProfileStream(provider, 1n, {
      signal: controller.signal,
      storage: storage(),
    })
    await enteredRead.promise
    controller.abort()
    releaseRead.resolve()

    await expect(pending).rejects.toThrow(
      /profile synchronization was cancelled/i,
    )
    expect(clear).not.toHaveBeenCalled()
  })

  it('cancels a stalled protocol inspection without waiting for timeout', async () => {
    const controller = new AbortController()
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') {
          queueMicrotask(() => controller.abort())
          return new Promise<unknown>(() => undefined)
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeProfileStream(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/profile synchronization was cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(2)
  })
})
