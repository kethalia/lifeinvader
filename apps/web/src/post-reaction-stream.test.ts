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
import type { Eip1193Provider } from './ethereum'
import {
  POST_CONTENT_KIND_TOPIC,
  POST_LIKE_SET_FILTER,
  PUBLISHED_REPOST_FILTER,
} from './protocol-events'
import { synchronizePostReactionStream } from './post-reaction-stream'
import {
  LIFEINVADER_INIT_CODE,
  LIKE_SET_TOPIC,
  PROTOCOL_ADDRESS,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'

const ACCOUNT = '0x000000000000000000000000000000000000c0c0' as Address
const LIKE_DATA_PARAMETERS = [{ type: 'bool' }] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint, family: string) {
  return keccak256(
    stringToHex(`transaction:${blockNumber.toString()}:${family}`),
  )
}

function rawLike(
  blockNumber: bigint,
  postId: bigint,
  liked: boolean,
  data?: Hex,
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data: data ?? encodeAbiParameters(LIKE_DATA_PARAMETERS, [liked]),
    logIndex: '0x0',
    removed: false,
    topics: [
      LIKE_SET_TOPIC,
      POST_CONTENT_KIND_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(ACCOUNT, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber, 'like'),
    transactionIndex: '0x0',
  }
}

function rawRepost(blockNumber: bigint, postId: bigint) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data: '0x',
    logIndex: '0x0',
    removed: false,
    topics: [
      REPOST_PUBLISHED_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(ACCOUNT, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber, 'repost'),
    transactionIndex: '0x0',
  }
}

function storage(factory = new IDBFactory()) {
  return {
    databaseName: `post-reactions-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('post reaction stream synchronization', () => {
  it('resumes two isolated streams through one bounded range each', async () => {
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

    const first = await synchronizePostReactionStream(provider, 1n, {
      storage: cacheStorage,
    })
    expect(first.projectionAnchor).toBeUndefined()
    expect(first.likes).toMatchObject({
      caughtUp: false,
      indexedThrough: 1_999n,
      scannedRanges: 1,
    })
    expect(first.reposts).toMatchObject({
      caughtUp: false,
      indexedThrough: 1_999n,
      scannedRanges: 1,
    })

    const second = await synchronizePostReactionStream(provider, 1n, {
      storage: cacheStorage,
    })
    expect(second.projectionAnchor).toMatchObject({
      chainId: 1n,
      head: 5_000n,
      likes: {
        cursor: { nextBlock: 4_989n },
        revision: 2n,
      },
      reposts: {
        cursor: { nextBlock: 4_989n },
        revision: 2n,
      },
      safeHead: 4_988n,
    })
    expect(second.likes).toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(second.reposts).toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(logQueries).toEqual([
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: POST_LIKE_SET_FILTER.topics,
      },
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: PUBLISHED_REPOST_FILTER.topics,
      },
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: POST_LIKE_SET_FILTER.topics,
      },
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: PUBLISHED_REPOST_FILTER.topics,
      },
    ])
  })

  it('refuses to anchor reaction streams from different safe-head forks', async () => {
    const branches = [
      ...Array<string>(5).fill('a'),
      ...Array<string>(5).fill('b'),
      'a',
      'b',
      'a',
      'b',
    ]
    let blockReads = 0
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getLogs') return []
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          const branch = branches[blockReads]
          blockReads += 1
          if (!branch) throw new Error('Unexpected safe-head block read.')
          return { hash: blockHash(BigInt(number), branch), number }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizePostReactionStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/do not share one confirmed safe-head block/i)
    expect(blockReads).toBe(branches.length)
  })

  it('returns validated recent signals without presenting aggregate counts', async () => {
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
          const [filter] = params as [{ topics: readonly Hex[] }]
          return filter.topics[0] === LIKE_SET_TOPIC
            ? [rawLike(2n, 7n, true)]
            : [rawRepost(3n, 7n)]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    const snapshot = await synchronizePostReactionStream(provider, 1n, {
      storage: storage(),
    })
    expect(snapshot).toMatchObject({
      projectionAnchor: {
        chainId: 1n,
        head: 20n,
        likes: { cursor: { nextBlock: 9n } },
        reposts: { cursor: { nextBlock: 9n } },
        safeHead: 8n,
      },
      likes: {
        caughtUp: true,
        indexedThrough: 8n,
        recentSignals: [
          {
            account: getAddress(ACCOUNT),
            liked: true,
            postId: 7n,
          },
        ],
      },
      reposts: {
        caughtUp: true,
        indexedThrough: 8n,
        recentReposts: [
          {
            account: getAddress(ACCOUNT),
            postId: 7n,
          },
        ],
      },
    })
  })

  it('does not advance a stream when fresh reaction data is invalid', async () => {
    let valid = false
    const likeFromBlocks: string[] = []
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
          const [filter] = params as [
            { fromBlock: string; topics: readonly Hex[] },
          ]
          if (filter.topics[0] === LIKE_SET_TOPIC) {
            likeFromBlocks.push(filter.fromBlock)
            return [rawLike(2n, 7n, true, valid ? undefined : '0x01')]
          }
          return [rawRepost(3n, 7n)]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizePostReactionStream(provider, 1n, {
        storage: cacheStorage,
      }),
    ).rejects.toThrow(/invalid post LikeSet/i)
    valid = true
    await expect(
      synchronizePostReactionStream(provider, 1n, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      likes: { recentSignals: [{ postId: 7n }] },
      reposts: { recentReposts: [{ postId: 7n }] },
    })
    expect(likeFromBlocks).toEqual(['0x0', '0x0'])
  })

  it('revalidates the like checkpoint after the repost scan', async () => {
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
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ topics: readonly Hex[] }]
          if (filter.topics[0] === REPOST_PUBLISHED_TOPIC) branch = 'b'
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizePostReactionStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/confirmed post-like stream checkpoint changed/i)
  })

  it('rejects an unverified contract without requesting reaction logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizePostReactionStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/verified Lifeinvader v1/i)
    expect(provider.request).toHaveBeenCalledTimes(3)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('observes wallet chain changes across both streams', async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    let logCalls = 0
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => {
        const current = listeners.get(event) ?? new Set()
        current.add(listener)
        listeners.set(event, current)
      }),
      removeListener: vi.fn((event, listener) => {
        const current = listeners.get(event)
        current?.delete(listener)
        if (current?.size === 0) listeners.delete(event)
      }),
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          logCalls += 1
          if (logCalls === 2) {
            for (const listener of listeners.get('chainChanged') ?? []) {
              listener('0x2')
            }
          }
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizePostReactionStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/chain changed during post reaction verification/i)
    expect(logCalls).toBe(2)
    expect(listeners.size).toBe(0)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizePostReactionStream(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).not.toHaveBeenCalled()
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
      synchronizePostReactionStream(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/reaction synchronization was cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(2)
  })
})
