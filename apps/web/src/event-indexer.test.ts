import { describe, expect, it, vi } from 'vitest'
import { keccak256, stringToHex, type Hex } from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  createEventCursor,
  getEventFilterId,
  syncEventLogs,
  type EventLogFilter,
} from './event-indexer'
import { PROTOCOL_ADDRESS } from './protocol'

const TOPIC = `0x${'11'.repeat(32)}` as Hex
const OTHER_TOPIC = `0x${'22'.repeat(32)}` as Hex
const OTHER_ADDRESS = '0x000000000000000000000000000000000000b0b0'
const FILTER = { address: PROTOCOL_ADDRESS, topics: [TOPIC] } as const

function quantity(value: bigint | number) {
  return `0x${BigInt(value).toString(16)}`
}
function blockHash(block: bigint | number, branch = 'a') {
  return keccak256(stringToHex(`${branch}:${block.toString()}`))
}
function transactionHash(block: bigint | number, logIndex = 0) {
  return keccak256(stringToHex(`transaction:${block.toString()}:${logIndex}`))
}
function rpcLog(
  block: bigint,
  options: {
    branch?: string
    logIndex?: number
    overrides?: Record<string, unknown>
  } = {},
) {
  const logIndex = options.logIndex ?? 0
  return {
    address: PROTOCOL_ADDRESS.toLowerCase(),
    blockHash: blockHash(block, options.branch),
    blockNumber: quantity(block),
    data: '0x',
    logIndex: quantity(logIndex),
    removed: false,
    topics: [TOPIC],
    transactionHash: transactionHash(block, logIndex),
    transactionIndex: '0x0',
    ...options.overrides,
  }
}
type ChainProviderOptions = {
  chainId?: bigint
  getLogs?: (fromBlock: bigint, toBlock: bigint) => unknown
  hashFor?: (block: bigint) => Hex
  head?: () => bigint
}
function chainProvider(options: ChainProviderOptions = {}) {
  const request = vi.fn(async ({ method, params }: ProviderRequest) => {
    if (method === 'eth_chainId') return quantity(options.chainId ?? 1n)
    if (method === 'eth_blockNumber') return quantity(options.head?.() ?? 20n)
    if (method === 'eth_getBlockByNumber') {
      const [tag] = params as [string, boolean]
      const block = BigInt(tag)
      if (block > (options.head?.() ?? 20n)) return null
      return {
        hash: options.hashFor?.(block) ?? blockHash(block),
        number: tag,
      }
    }
    if (method === 'eth_getLogs') {
      const [filter] = params as [{ fromBlock: string; toBlock: string }]
      return (
        options.getLogs?.(BigInt(filter.fromBlock), BigInt(filter.toBlock)) ??
        []
      )
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  return { provider: { request } satisfies Eip1193Provider, request }
}
function requestedLogRanges(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls
    .map(([call]) => call as ProviderRequest)
    .filter((call) => call.method === 'eth_getLogs')
    .map((call) => {
      const [filter] = call.params as [{ fromBlock: string; toBlock: string }]
      return [BigInt(filter.fromBlock), BigInt(filter.toBlock)]
    })
}

describe('bounded event synchronization', () => {
  it('scans only bounded ranges and returns logs in canonical order', async () => {
    const { provider, request } = chainProvider({
      getLogs: (fromBlock, toBlock) =>
        [13n, 11n, 17n]
          .filter((block) => block >= fromBlock && block <= toBlock)
          .map((block) => rpcLog(block)),
    })
    const cursor = createEventCursor(1n, FILTER, 10n, 4)
    const result = await syncEventLogs(provider, FILTER, cursor, {
      finalityDepth: 2n,
      maxLogsPerRange: 4,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(requestedLogRanges(request)).toEqual([
      [10n, 13n],
      [14n, 17n],
    ])
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getLogs',
      params: [
        expect.objectContaining({ address: PROTOCOL_ADDRESS, topics: [TOPIC] }),
      ],
    })
    expect(result.logs.map((log) => log.blockNumber)).toEqual([11n, 13n, 17n])
    expect(result.cursor.nextBlock).toBe(18n)
    expect(result.safeHead).toBe(18n)
    expect(result.caughtUp).toBe(false)
    expect(result.scannedRanges).toBe(2)
  })

  it('shrinks provider-limited ranges without exceeding the work budget', async () => {
    const { provider, request } = chainProvider({
      head: () => 7n,
      getLogs: (fromBlock, toBlock) => {
        if (toBlock - fromBlock + 1n > 2n) {
          throw Object.assign(new Error('block range is too wide'), {
            code: -32005,
          })
        }
        return [rpcLog(1n)]
      },
    })
    const result = await syncEventLogs(
      provider,
      FILTER,
      createEventCursor(1n, FILTER, 0n, 8),
      {
        finalityDepth: 0n,
        maxLogsPerRange: 2,
        maxRangeSize: 8,
        maxRanges: 3,
      },
    )
    expect(requestedLogRanges(request)).toEqual([
      [0n, 7n],
      [0n, 3n],
      [0n, 1n],
    ])
    expect(result.scannedRanges).toBe(1)
    expect(result.cursor.nextBlock).toBe(2n)
    expect(result.cursor.rangeSize).toBe(2)
  })

  it('does not reinterpret unrelated RPC failures as range limits', async () => {
    const { provider } = chainProvider({
      getLogs: () => {
        throw Object.assign(new Error('rate limit exceeded'), { code: 429 })
      },
    })
    await expect(
      syncEventLogs(provider, FILTER, createEventCursor(1n, FILTER, 0n, 8), {
        finalityDepth: 0n,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/rate limit exceeded/i)
  })

  it('rejects a single range that cannot be split any further', async () => {
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [rpcLog(0n), rpcLog(0n, { logIndex: 1 })],
    })
    await expect(
      syncEventLogs(provider, FILTER, createEventCursor(1n, FILTER, 0n, 1), {
        finalityDepth: 0n,
        maxLogsPerRange: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/single block returned too many events/i)
  })

  it('waits until a block has the configured finality depth', async () => {
    const { provider, request } = chainProvider({ head: () => 5n })
    const result = await syncEventLogs(
      provider,
      FILTER,
      createEventCursor(1n, FILTER, 0n),
      { finalityDepth: 12n },
    )
    expect(result.safeHead).toBeUndefined()
    expect(result.caughtUp).toBe(true)
    expect(requestedLogRanges(request)).toEqual([])
  })
})

describe('canonical checkpoints', () => {
  it('rolls back to the last canonical range before resuming', async () => {
    let head = 7n
    let reorgFrom: bigint | undefined
    const currentBranch = (block: bigint) =>
      reorgFrom !== undefined && block >= reorgFrom ? 'b' : 'a'
    const { provider } = chainProvider({
      head: () => head,
      hashFor: (block) => blockHash(block, currentBranch(block)),
      getLogs: (fromBlock, toBlock) => {
        const blocks = reorgFrom === undefined ? [2n, 6n] : [2n, 5n, 8n]
        return blocks
          .filter((block) => block >= fromBlock && block <= toBlock)
          .map((block) => rpcLog(block, { branch: currentBranch(block) }))
      },
    })
    const first = await syncEventLogs(
      provider,
      FILTER,
      createEventCursor(1n, FILTER, 0n, 4),
      {
        finalityDepth: 0n,
        maxLogsPerRange: 2,
        maxRangeSize: 4,
        maxRanges: 2,
      },
    )
    expect(
      first.cursor.checkpoints.map(({ blockNumber }) => blockNumber),
    ).toEqual([3n, 7n])
    head = 9n
    reorgFrom = 4n
    const second = await syncEventLogs(provider, FILTER, first.cursor, {
      finalityDepth: 0n,
      maxLogsPerRange: 2,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(second.rollbackTo).toBe(4n)
    expect(second.logs.map((log) => log.blockNumber)).toEqual([5n, 8n])
    expect(second.cursor.nextBlock).toBe(10n)
    expect(second.caughtUp).toBe(true)
  })

  it('discards an unstable range and retries its replacement', async () => {
    let branch = 'a'
    let logRequests = 0
    const { provider } = chainProvider({
      head: () => 3n,
      hashFor: (block) => blockHash(block, branch),
      getLogs: () => {
        const result = [rpcLog(1n, { branch })]
        logRequests += 1
        if (logRequests === 1) branch = 'b'
        return result
      },
    })
    const result = await syncEventLogs(
      provider,
      FILTER,
      createEventCursor(1n, FILTER, 0n, 4),
      {
        finalityDepth: 0n,
        maxLogsPerRange: 2,
        maxRangeSize: 4,
        maxRanges: 2,
      },
    )
    expect(logRequests).toBe(2)
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0]?.blockHash).toBe(blockHash(1n, 'b'))
    expect(result.cursor.checkpoints[0]?.blockHash).toBe(blockHash(3n, 'b'))
  })

  it('falls back to a full rebuild when the rollback budget is exhausted', async () => {
    const { provider: original } = chainProvider({
      head: () => 7n,
      getLogs: () => [],
    })
    const first = await syncEventLogs(
      original,
      FILTER,
      createEventCursor(1n, FILTER, 0n, 4),
      { finalityDepth: 0n, maxRangeSize: 4, maxRanges: 2 },
    )
    const { provider: replacement } = chainProvider({
      head: () => 7n,
      hashFor: (block) => blockHash(block, 'b'),
    })
    const rebuilt = await syncEventLogs(replacement, FILTER, first.cursor, {
      finalityDepth: 0n,
      maxRanges: 1,
      maxReorgChecks: 1,
    })
    expect(rebuilt.rollbackTo).toBe(0n)
    expect(rebuilt.cursor.startBlock).toBe(0n)
  })

  it('retains replacement logs after a later rollback in the same sync', async () => {
    let head = 7n
    let rebuilding = false
    let finalRangeReads = 0
    const hashFor = (block: bigint) => {
      if (!rebuilding || block < 4n) return blockHash(block, 'a')
      if (block < 8n) return blockHash(block, 'b')
      if (block === 11n) {
        finalRangeReads += 1
        return blockHash(block, finalRangeReads > 2 ? 'c' : 'b')
      }
      return blockHash(block, finalRangeReads > 2 ? 'c' : 'b')
    }
    const { provider } = chainProvider({
      head: () => head,
      hashFor,
      getLogs: (fromBlock, toBlock) => {
        const blocks = rebuilding ? [5n, 9n] : []
        return blocks
          .filter((block) => block >= fromBlock && block <= toBlock)
          .map((block) => rpcLog(block, { branch: 'b' }))
      },
    })
    const original = await syncEventLogs(
      provider,
      FILTER,
      createEventCursor(1n, FILTER, 0n, 4),
      { finalityDepth: 0n, maxRangeSize: 4, maxRanges: 2 },
    )
    rebuilding = true
    head = 11n
    const result = await syncEventLogs(provider, FILTER, original.cursor, {
      finalityDepth: 0n,
      maxLogsPerRange: 2,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(result.rollbackTo).toBe(4n)
    expect(result.logs.map((log) => log.blockNumber)).toEqual([5n])
    expect(result.cursor.nextBlock).toBe(8n)
  })
})

describe('untrusted RPC and cursor data', () => {
  it('normalizes equivalent topic alternatives into the same filter ID', () => {
    const first: EventLogFilter = {
      address: PROTOCOL_ADDRESS.toLowerCase() as typeof PROTOCOL_ADDRESS,
      topics: [[TOPIC, OTHER_TOPIC, TOPIC]],
    }
    const second: EventLogFilter = {
      address: PROTOCOL_ADDRESS,
      topics: [[OTHER_TOPIC, TOPIC]],
    }
    expect(getEventFilterId(first)).toBe(getEventFilterId(second))
  })

  it('rejects a cursor for another filter before opening the RPC', async () => {
    const request = vi.fn()
    const cursor = createEventCursor(1n, FILTER, 0n)
    await expect(
      syncEventLogs(
        { request },
        { address: PROTOCOL_ADDRESS, topics: [OTHER_TOPIC] },
        cursor,
      ),
    ).rejects.toThrow(/different filter/i)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects a cursor for another RPC chain', async () => {
    const { provider } = chainProvider({ chainId: 2n })
    await expect(
      syncEventLogs(provider, FILTER, createEventCursor(1n, FILTER, 0n)),
    ).rejects.toThrow(/different chain/i)
  })

  it.each([
    ['removal state', { removed: true }],
    ['address', { address: OTHER_ADDRESS }],
    ['topics', { topics: [OTHER_TOPIC] }],
    ['block number', { blockNumber: '0x1' }],
    ['block hash', { blockHash: OTHER_TOPIC }],
    ['log data', { data: `0x${'00'.repeat(16_385)}` }],
    ['log index', { logIndex: `0x${'1'.repeat(65)}` }],
    ['transaction hash', { transactionHash: '0x01' }],
    ['topics', { topics: Array(5).fill(TOPIC) }],
  ])('rejects an invalid event log %s', async (field, overrides) => {
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [rpcLog(0n, { overrides })],
    })
    await expect(
      syncEventLogs(provider, FILTER, createEventCursor(1n, FILTER, 0n, 1), {
        finalityDepth: 0n,
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(new RegExp(field, 'i'))
  })

  it('rejects duplicate log positions from an RPC response', async () => {
    const duplicate = rpcLog(0n)
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [duplicate, duplicate],
    })
    await expect(
      syncEventLogs(provider, FILTER, createEventCursor(1n, FILTER, 0n, 1), {
        finalityDepth: 0n,
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/duplicate event log/i)
  })

  it('bounds cursor identifiers before normalizing them', async () => {
    const request = vi.fn()
    const cursor = {
      ...createEventCursor(1n, FILTER, 0n),
      filterId: `0x${'1'.repeat(1_000_000)}` as Hex,
    }
    await expect(syncEventLogs({ request }, FILTER, cursor)).rejects.toThrow(
      /invalid event cursor filter/i,
    )
    expect(request).not.toHaveBeenCalled()
  })
})

describe('sync lifetime', () => {
  it('honors cancellation before issuing RPC requests', async () => {
    const controller = new AbortController()
    controller.abort()
    const request = vi.fn()
    await expect(
      syncEventLogs({ request }, FILTER, createEventCursor(1n, FILTER, 0n), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds a stalled provider request', async () => {
    const request = vi.fn(() => new Promise<unknown>(() => undefined))
    await expect(
      syncEventLogs({ request }, FILTER, createEventCursor(1n, FILTER, 0n), {
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/i)
  })

  it('removes chain listeners after a mid-sync network change', async () => {
    const listeners = new Map<string, () => void>()
    const removeListener = vi.fn((event: string) => listeners.delete(event))
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') return '0x0'
      if (method === 'eth_getBlockByNumber') {
        listeners.get('chainChanged')?.()
        const [tag] = params as [string]
        return { hash: blockHash(0n), number: tag }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const provider: Eip1193Provider = {
      on: (event, listener) => listeners.set(event, listener),
      removeListener,
      request,
    }
    await expect(
      syncEventLogs(provider, FILTER, createEventCursor(1n, FILTER, 0n), {
        finalityDepth: 0n,
      }),
    ).rejects.toThrow(/chain changed/i)
    expect(removeListener).toHaveBeenCalledTimes(2)
  })
})
