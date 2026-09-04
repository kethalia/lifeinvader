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
  GROUP_DIRECTORY_START_BLOCK,
  resetGroupDirectoryCache,
  synchronizeGroupDirectory,
  type GroupDirectoryStorageOptions,
  type SynchronizeGroupDirectoryOptions,
} from './group-directory'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { BrowserEventCache, openEventCache } from './event-cache'
import { createEventCursor, type IndexedEventLog } from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { GROUP_CREATED_FILTER } from './protocol-events'
import {
  GROUP_CREATED_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'
import {
  ProtocolHistoryUnavailableError,
  type ProtocolHistoryBoundary,
} from './protocol-history'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const GROUP_A = 1n
const GROUP_B = 2n
const GROUP_DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`block:${blockNumber.toString()}:${branch}`))
}

function transactionHash(blockNumber: bigint) {
  return keccak256(stringToHex(`transaction:${blockNumber.toString()}`))
}

function uint256Result(value: bigint) {
  return padHex(toHex(value), { size: 32 })
}

function rawGroup(
  blockNumber: bigint,
  groupId: bigint,
  creator: Address,
  name: string,
  options: { data?: Hex; logIndex?: number; metadataCid?: Hex } = {},
) {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber: toHex(blockNumber),
    data:
      options.data ??
      encodeAbiParameters(GROUP_DATA_PARAMETERS, [
        name,
        options.metadataCid ?? '0x',
      ]),
    logIndex: toHex(options.logIndex ?? 0),
    removed: false,
    topics: [
      GROUP_CREATED_TOPIC,
      padHex(toHex(groupId), { size: 32 }),
      padHex(creator, { size: 32 }),
    ],
    transactionHash: transactionHash(blockNumber),
    transactionIndex: '0x0',
  }
}

function cachedGroup(
  blockNumber: bigint,
  groupId: bigint,
  creator: Address,
  name = 'Cached public group',
): IndexedEventLog {
  const group = rawGroup(blockNumber, groupId, creator, name)
  return {
    address: group.address as Address,
    blockHash: group.blockHash,
    blockNumber,
    data: group.data,
    logIndex: 0,
    topics: group.topics as readonly Hex[],
    transactionHash: group.transactionHash,
    transactionIndex: 0,
  }
}

function storage(factory = new IDBFactory()): GroupDirectoryStorageOptions {
  return {
    databaseName: `group-directory-${crypto.randomUUID()}`,
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
  options: SynchronizeGroupDirectoryOptions = {},
) {
  return synchronizeGroupDirectory(provider, chainId, {
    resolveHistoryBoundary: unsupportedHistory,
    ...options,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('group-directory stream synchronization', () => {
  it('falls back to genesis and resumes one bounded range per call', async () => {
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
        if (method === 'eth_call') return uint256Result(1n)
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
      synchronizeWithFallback(provider, 1n, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      groups: [],
      historyBoundaryKind: 'genesis-fallback',
      indexedThrough: 1_999n,
      scannedRanges: 1,
      startBlock: GROUP_DIRECTORY_START_BLOCK,
    })
    await expect(
      synchronizeWithFallback(provider, 1n, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      groups: [],
      indexedThrough: 4_988n,
      safeHead: 4_988n,
      scannedRanges: 1,
    })
    expect(logQueries).toEqual([
      {
        fromBlock: '0x0',
        toBlock: '0x7cf',
        topics: [GROUP_CREATED_TOPIC],
      },
      {
        fromBlock: '0x7d0',
        toBlock: '0x137c',
        topics: [GROUP_CREATED_TOPIC],
      },
    ])
  })

  it('starts global group discovery at the verified deployment boundary', async () => {
    const requests: ProviderRequest[] = []
    const resolveHistoryBoundary = vi.fn(async () => historyBoundary(3_000n))
    const provider: Eip1193Provider = {
      request: vi.fn(async (request: ProviderRequest) => {
        requests.push(request)
        const { method, params } = request
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_call') return uint256Result(2n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          return [
            rawGroup(3_001n, GROUP_A, ACCOUNT_A, 'Started after deployment'),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupDirectory(provider, 1n, {
        resolveHistoryBoundary,
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      groups: [{ groupId: GROUP_A, name: 'Started after deployment' }],
      historyBoundaryKind: 'confirmed',
      indexedThrough: 4_988n,
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
        topics: [GROUP_CREATED_TOPIC],
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
      synchronizeGroupDirectory(provider, 1n, {
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

  it('does not turn a transient history RPC failure into a genesis scan', async () => {
    const transientError = Object.assign(new Error('rate limit exceeded'), {
      code: -32_005,
    })
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(20n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getCode') {
          const [, block] = params as [string, string]
          if (block === 'latest' || block === toHex(20n)) {
            return PROTOCOL_RUNTIME_CODE
          }
          throw transientError
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupDirectory(provider, 1n, { storage: storage() }),
    ).rejects.toBe(transientError)
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
      synchronizeGroupDirectory(provider, 1n, {
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

  it('waits without requesting logs or state while confirmation is pending', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5_000n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs' || method === 'eth_call') {
          throw new Error('A pending directory must not read group history.')
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupDirectory(provider, 1n, {
        resolveHistoryBoundary: async () => historyBoundary(4_990n),
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      groups: [],
      head: 5_000n,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: 4_988n,
      scannedRanges: 0,
      startBlock: 4_990n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_call' }),
    )
  })

  it('stays pending when the safe head only reaches confirmed emptiness', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(21n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs' || method === 'eth_call') {
          throw new Error(
            'Confirmed emptiness is not a confirmed deployment boundary.',
          )
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupDirectory(provider, 1n, {
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
      groups: [],
      head: 21n,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: 9n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_call' }),
    )
  })

  it('stays pending before the chain has a confirmed head', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(5n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs' || method === 'eth_call') {
          throw new Error(
            'A pre-finality directory must not read group history.',
          )
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeGroupDirectory(provider, 1n, {
        resolveHistoryBoundary: async () => ({
          chainId: 1n,
          codeProbes: 1,
          head: { blockHash: blockHash(5n), blockNumber: 5n },
          kind: 'pending-confirmation',
          startBlock: 0n,
        }),
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: false,
      groups: [],
      head: 5n,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: undefined,
      scannedRanges: 0,
      startBlock: 0n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_call' }),
    )
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
        if (method === 'eth_getLogs' || method === 'eth_call') {
          throw new Error('A pre-finality fallback has no confirmed history.')
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeWithFallback(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: false,
      groups: [],
      head: 5n,
      historyBoundaryKind: 'genesis-fallback',
      indexedThrough: undefined,
      safeHead: undefined,
      scannedRanges: 0,
      startBlock: 0n,
    })
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getLogs' }),
    )
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_call' }),
    )
  })

  it('returns immutable public groups newest first', async () => {
    const logs = [
      rawGroup(2n, GROUP_A, ACCOUNT_A, 'First public group'),
      rawGroup(3n, GROUP_B, ACCOUNT_B, 'Newest public group', {
        metadataCid: '0x01701220',
      }),
    ]
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_call') return uint256Result(3n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') return logs
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeWithFallback(provider, 1n, {
        storage: storage(),
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      indexedThrough: 8n,
      groups: [
        {
          creator: getAddress(ACCOUNT_B),
          groupId: GROUP_B,
          metadataCid: '0x01701220',
          name: 'Newest public group',
        },
        {
          creator: getAddress(ACCOUNT_A),
          groupId: GROUP_A,
          metadataCid: '0x',
          name: 'First public group',
        },
      ],
    })
  })

  it('keeps discovery moving past a protocol-valid non-UTF-8 name', async () => {
    const data = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      ['0xfffe', '0x'],
    )
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_call') return uint256Result(2n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          return [
            rawGroup(2n, GROUP_A, ACCOUNT_A, 'ignored fallback input', {
              data,
            }),
          ]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeWithFallback(provider, 1n, { storage: storage() }),
    ).resolves.toMatchObject({
      caughtUp: true,
      groups: [
        {
          groupId: GROUP_A,
          name: '0xfffe',
          nameBytes: '0xfffe',
          nameEncoding: 'hex',
        },
      ],
    })
  })

  it('decodes a whole dense boundary block but returns only 100 groups', async () => {
    const logs = Array.from({ length: 101 }, (_, index) =>
      rawGroup(2n, BigInt(index + 1), ACCOUNT_A, `Public group ${index + 1}`, {
        logIndex: index,
      }),
    )
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_call') return uint256Result(102n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') return logs
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    const snapshot = await synchronizeWithFallback(provider, 1n, {
      storage: storage(),
    })

    expect(snapshot.groups).toHaveLength(100)
    expect(snapshot.groups[0]?.groupId).toBe(101n)
    expect(snapshot.groups.at(-1)?.groupId).toBe(2n)
  })

  it('does not advance when fresh group data cannot be decoded', async () => {
    let valid = false
    const fromBlocks: string[] = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_call') return uint256Result(2n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string }]
          fromBlocks.push(filter.fromBlock)
          const log = rawGroup(2n, GROUP_A, ACCOUNT_A, 'A valid public group')
          return [valid ? log : { ...log, data: '0x01' }]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeWithFallback(provider, 1n, {
        storage: cacheStorage,
      }),
    ).rejects.toThrow(/invalid GroupCreated/i)
    valid = true
    await expect(
      synchronizeWithFallback(provider, 1n, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      groups: [{ groupId: GROUP_A, name: 'A valid public group' }],
    })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
  })

  it('resets a falsely complete directory when RPC logs are truncated', async () => {
    let returnCompleteHistory = false
    const fromBlocks: string[] = []
    const calls: Array<readonly unknown[]> = []
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_call') {
          calls.push((params ?? []) as unknown as readonly unknown[])
          return uint256Result(3n)
        }
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          const [filter] = params as [{ fromBlock: string }]
          fromBlocks.push(filter.fromBlock)
          const logs = [rawGroup(2n, GROUP_A, ACCOUNT_A, 'First group')]
          if (returnCompleteHistory) {
            logs.push(rawGroup(3n, GROUP_B, ACCOUNT_B, 'Second group'))
          }
          return logs
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }
    const cacheStorage = storage()

    await expect(
      synchronizeWithFallback(provider, 1n, { storage: cacheStorage }),
    ).rejects.toThrow(/incomplete confirmed group directory/i)
    returnCompleteHistory = true
    await expect(
      synchronizeWithFallback(provider, 1n, { storage: cacheStorage }),
    ).resolves.toMatchObject({
      caughtUp: true,
      groups: [{ groupId: GROUP_B }, { groupId: GROUP_A }],
    })
    expect(fromBlocks).toEqual(['0x0', '0x0'])
    expect(calls[0]).toEqual([
      { data: '0x5eda7a76', to: PROTOCOL_ADDRESS },
      '0x8',
    ])
  })

  it('repairs a malformed cached group before resuming from genesis', async () => {
    const cacheStorage = storage()
    const filter = GROUP_CREATED_FILTER
    const seed = createEventCursor({
      chainId: 1n,
      filter,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_DIRECTORY_START_BLOCK,
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
        logs: [{ ...cachedGroup(1n, GROUP_A, ACCOUNT_A), data: '0x01' }],
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
        if (method === 'eth_call') return uint256Result(2n)
        if (method === 'eth_getBlockByNumber') {
          const [number] = params as [string]
          return { hash: blockHash(BigInt(number)), number }
        }
        if (method === 'eth_getLogs') {
          const [request] = params as [{ fromBlock: string }]
          fromBlock = request.fromBlock
          return [rawGroup(2n, GROUP_A, ACCOUNT_A, 'Recovered from the chain')]
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      },
    }

    await expect(
      synchronizeWithFallback(provider, 1n, {
        storage: cacheStorage,
      }),
    ).resolves.toMatchObject({
      cacheReset: true,
      groups: [{ name: 'Recovered from the chain' }],
    })
    expect(fromBlock).toBe('0x0')
  })

  it('clears only the selected chain directory scope', async () => {
    const cacheStorage = storage()
    const seedOne = createEventCursor({
      chainId: 1n,
      filter: GROUP_CREATED_FILTER,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_DIRECTORY_START_BLOCK,
    })
    const seedTwo = createEventCursor({
      chainId: 2n,
      filter: GROUP_CREATED_FILTER,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_DIRECTORY_START_BLOCK,
    })
    for (const [seed, log] of [
      [seedOne, cachedGroup(1n, GROUP_A, ACCOUNT_A)],
      [seedTwo, cachedGroup(1n, GROUP_B, ACCOUNT_B)],
    ] as const) {
      const cache = await openEventCache({
        ...cacheStorage,
        filter: GROUP_CREATED_FILTER,
      })
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

    await resetGroupDirectoryCache(1n, cacheStorage)

    const cleared = await openEventCache({
      ...cacheStorage,
      filter: GROUP_CREATED_FILTER,
    })
    try {
      await expect(cleared.readLatest(seedOne)).resolves.toMatchObject({
        cursor: seedOne,
        logs: [],
        reset: false,
        revision: 2n,
      })
    } finally {
      cleared.close()
    }
    const preserved = await openEventCache({
      ...cacheStorage,
      filter: GROUP_CREATED_FILTER,
    })
    try {
      await expect(preserved.readLatest(seedTwo)).resolves.toMatchObject({
        logs: [{ data: cachedGroup(1n, GROUP_B, ACCOUNT_B).data }],
        revision: 1n,
      })
    } finally {
      preserved.close()
    }
  })

  it('rejects unverified code without requesting group logs', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return '0x01'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      synchronizeWithFallback(provider, 1n, {
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
      synchronizeWithFallback(provider, 1n, {
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
      synchronizeWithFallback(provider, 1n, {
        storage: storage(),
      }),
    ).rejects.toThrow(/chain changed during group-directory verification/i)
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
      synchronizeWithFallback(provider, 1n, {
        storage: storage(),
      }),
    ).rejects.toThrow(/head moved behind the confirmed groups/i)
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
      synchronizeWithFallback(provider, 1n, {
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
        if (method === 'eth_call') return uint256Result(1n)
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
      synchronizeWithFallback(provider, 1n, {
        storage: storage(),
      }),
    ).rejects.toThrow(/confirmed group-directory checkpoint changed/i)
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
      synchronizeWithFallback(provider, 1n, {
        storage: storage(),
      }),
    ).rejects.toThrow(/cache changed after synchronization/i)
  })

  it('does no storage or RPC work for an already cancelled request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const controller = new AbortController()
    controller.abort()

    await expect(
      synchronizeWithFallback(provider, 1n, {
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
      synchronizeWithFallback(provider, 1n, {
        signal: controller.signal,
        storage: storage(),
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.request).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})
