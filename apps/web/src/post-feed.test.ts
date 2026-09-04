import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
} from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { BrowserEventCache } from './event-cache'
import { synchronizePostFeed } from './post-feed'
import {
  LIFEINVADER_INIT_CODE,
  LOCAL_CHAIN_ID,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
} from './protocol'

const AUTHOR = '0x000000000000000000000000000000000000b0b0' as Address
const DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint) {
  return keccak256(stringToHex(`transaction:${blockNumber.toString()}`))
}

function rawPost(blockNumber: bigint, postId: bigint, body: string) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data: encodeAbiParameters(DATA_PARAMETERS, [body, '0x']),
    logIndex: '0x0',
    removed: false,
    topics: [
      POST_PUBLISHED_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(AUTHOR, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function storage(factory = new IDBFactory()) {
  return {
    databaseName: `post-feed-${crypto.randomUUID()}`,
    factory,
    keyRange: IDBKeyRange,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('post feed synchronization', () => {
  it('resumes through exactly one bounded RPC range per invocation', async () => {
    const logRanges: Array<{ fromBlock: string; toBlock: string }> = []
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
          const [filter] = params as [{ fromBlock: string; toBlock: string }]
          logRanges.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          })
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }
    const cacheStorage = storage()

    const first = await synchronizePostFeed(provider, 1n, {
      storage: cacheStorage,
    })
    expect(first).toMatchObject({
      caughtUp: false,
      indexedThrough: 1_999n,
      scannedRanges: 1,
    })

    const second = await synchronizePostFeed(provider, 1n, {
      storage: cacheStorage,
    })
    expect(second).toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(logRanges).toEqual([
      { fromBlock: '0x0', toBlock: '0x7cf' },
      { fromBlock: '0x7d0', toBlock: '0x137c' },
    ])
  })

  it('starts at the verified deployment block', async () => {
    const deploymentBlock = 3_456n
    const logRanges: Array<{ fromBlock: string; toBlock: string }> = []
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
          logRanges.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          })
          return []
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      startBlock: deploymentBlock,
    })
    expect(logRanges).toEqual([
      { fromBlock: toHex(deploymentBlock), toBlock: toHex(4_988n) },
    ])
  })

  it('falls back to genesis when the RPC rejects historical code reads', async () => {
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({ caughtUp: true, startBlock: 0n })
    expect(fromBlock).toBe('0x0')
  })

  it('waits to scan until a new deployment reaches the safe head', async () => {
    let head = 20n
    const logRanges: Array<{ fromBlock: string; toBlock: string }> = []
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
          logRanges.push({
            fromBlock: filter.fromBlock,
            toBlock: filter.toBlock,
          })
          return [rawPost(14n, 1n, 'Confirmed after waiting.')]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizePostFeed(provider, 1n, { storage: cacheStorage }),
    ).resolves.toMatchObject({
      caughtUp: false,
      indexedThrough: undefined,
      safeHead: 8n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    expect(logRanges).toEqual([])

    head = 32n
    await expect(
      synchronizePostFeed(provider, 1n, { storage: cacheStorage }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 20n,
      posts: [{ body: 'Confirmed after waiting.', postId: 1n }],
      safeHead: 20n,
      scannedRanges: 1,
      startBlock: 9n,
    })
    expect(logRanges).toEqual([{ fromBlock: '0x9', toBlock: '0x14' }])
  })

  it('rediscovers a replaced history anchor before mutating the event cache', async () => {
    let branch = 'a'
    let deploymentBlock = 37n
    let reorganized = false
    let scanned = false
    const logRanges: Array<{ fromBlock: string; toBlock: string }> = []
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
          logRanges.push({
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({ caughtUp: true, startBlock: 41n })
    expect(logRanges).toEqual([
      { fromBlock: '0x25', toBlock: '0x58' },
      { fromBlock: '0x29', toBlock: '0x58' },
    ])
    expect(apply).toHaveBeenCalledOnce()
  })

  it('returns decoded confirmed posts newest first', async () => {
    const logs = [
      rawPost(2n, 1n, 'First permanent thought.'),
      rawPost(3n, 2n, 'Newest permanent thought.'),
    ]
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return toHex(LOCAL_CHAIN_ID)
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
      synchronizePostFeed(provider, LOCAL_CHAIN_ID, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 8n,
      posts: [
        { body: 'Newest permanent thought.', postId: 2n },
        { body: 'First permanent thought.', postId: 1n },
      ],
    })
  })

  it('does not advance the cursor when fresh post data cannot be decoded', async () => {
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
          const log = rawPost(2n, 1n, 'A valid post.')
          return [valid ? log : { ...log, data: '0x01' }]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizePostFeed(provider, 1n, { storage: cacheStorage }),
    ).rejects.toThrow(/invalid PostPublished/i)
    valid = true
    await expect(
      synchronizePostFeed(provider, 1n, { storage: cacheStorage }),
    ).resolves.toMatchObject({ posts: [{ body: 'A valid post.' }] })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('rejects an unverified contract without requesting its logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizePostFeed(provider, 1n, { storage: storage() }),
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/different wallet chain/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
  })

  it('observes chain changes from before bytecode inspection', async () => {
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/chain changed during feed verification/i)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(listeners.size).toBe(0)
  })

  it('rejects a committed range that loses confirmation depth', async () => {
    const heads = [100n, 100n, 100n, 89n]
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/head moved behind the confirmed post feed/i)
    expect(
      vi
        .mocked(provider.request)
        .mock.calls.filter(([request]) => request.method === 'eth_getLogs'),
    ).toHaveLength(1)
  })

  it('rejects a committed checkpoint replaced during cache work', async () => {
    let endpointReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/confirmed post feed checkpoint changed/i)
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
      synchronizePostFeed(provider, 1n, { storage: storage() }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizePostFeed(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).not.toHaveBeenCalled()
  })
})
