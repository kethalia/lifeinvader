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
import { BrowserEventCache } from './event-cache'
import {
  synchronizePostCommentStream,
  type PostCommentStreamStorageOptions,
} from './post-comment-stream'
import { PUBLISHED_COMMENT_FILTER } from './protocol-events'
import {
  COMMENT_PUBLISHED_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const AUTHOR = '0x000000000000000000000000000000000000c0c0' as Address
const DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint) {
  return keccak256(stringToHex(`transaction:${blockNumber.toString()}`))
}

function rawComment(
  blockNumber: bigint,
  commentId: bigint,
  postId: bigint,
  body: string,
  data?: Hex,
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data: data ?? encodeAbiParameters(DATA_PARAMETERS, [body, '0x']),
    logIndex: '0x0',
    removed: false,
    topics: [
      COMMENT_PUBLISHED_TOPIC,
      padHex(toHex(commentId), { size: 32 }),
      padHex(toHex(postId), { size: 32 }),
      padHex(AUTHOR, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function storage(factory = new IDBFactory()): PostCommentStreamStorageOptions {
  return {
    databaseName: `post-comments-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('post comment stream synchronization', () => {
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

    const first = await synchronizePostCommentStream(provider, 1n, {
      storage: cacheStorage,
    })
    expect(first).toMatchObject({
      caughtUp: false,
      indexedThrough: 1_999n,
      projectionAnchor: undefined,
      scannedRanges: 1,
    })

    const second = await synchronizePostCommentStream(provider, 1n, {
      storage: cacheStorage,
    })
    expect(second).toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      projectionAnchor: {
        chainId: 1n,
        comments: {
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
        topics: PUBLISHED_COMMENT_FILTER.topics,
      },
      {
        address: PROTOCOL_ADDRESS,
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: PUBLISHED_COMMENT_FILTER.topics,
      },
    ])
  })

  it('returns validated recent comments newest first without claiming a complete thread', async () => {
    const logs = [
      rawComment(2n, 1n, 7n, 'First public reply.'),
      rawComment(3n, 2n, 8n, 'Newest public reply.'),
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
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 8n,
      projectionAnchor: {
        chainId: 1n,
        comments: { cursor: { nextBlock: 9n }, revision: 1n },
        head: 20n,
        safeHead: 8n,
      },
      recentComments: [
        {
          author: getAddress(AUTHOR),
          body: 'Newest public reply.',
          commentId: 2n,
          postId: 8n,
        },
        {
          author: getAddress(AUTHOR),
          body: 'First public reply.',
          commentId: 1n,
          postId: 7n,
        },
      ],
    })
  })

  it('does not advance when fresh comment data is invalid', async () => {
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
            rawComment(
              2n,
              1n,
              7n,
              'A valid comment.',
              valid ? undefined : '0x01',
            ),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizePostCommentStream(provider, 1n, { storage: cacheStorage }),
    ).rejects.toThrow(/invalid CommentPublished/i)
    valid = true
    await expect(
      synchronizePostCommentStream(provider, 1n, { storage: cacheStorage }),
    ).resolves.toMatchObject({
      recentComments: [{ body: 'A valid comment.', commentId: 1n }],
    })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('rejects unverified code without requesting comment logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
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
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/different wallet chain/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
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
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/chain changed during post comment verification/i)
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
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/confirmed post comment checkpoint changed/i)
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
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
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
      synchronizePostCommentStream(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizePostCommentStream(provider, 1n, {
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
      synchronizePostCommentStream(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/post comment synchronization was cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(2)
  })
})
