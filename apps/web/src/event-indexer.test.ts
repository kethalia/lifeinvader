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

function eventCursor(startBlock = 0n, rangeSize?: number, finalityDepth = 0n) {
  return createEventCursor({
    chainId: 1n,
    filter: FILTER,
    finalityDepth,
    rangeSize,
    startBlock,
  })
}
function quantity(value: bigint | number) {
  return `0x${BigInt(value).toString(16)}`
}
function blockHash(block: bigint | number, branch = 'a') {
  return keccak256(stringToHex(`${branch}:${block.toString()}`))
}
function transactionHash(block: bigint | number, transactionIndex = 0) {
  return keccak256(
    stringToHex(`transaction:${block.toString()}:${transactionIndex}`),
  )
}
function rpcLog(
  block: bigint,
  options: {
    branch?: string
    logIndex?: number
    overrides?: Record<string, unknown>
    transactionIndex?: number
  } = {},
) {
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? 0
  return {
    address: PROTOCOL_ADDRESS.toLowerCase(),
    blockHash: blockHash(block, options.branch),
    blockNumber: quantity(block),
    data: '0x',
    logIndex: quantity(logIndex),
    removed: false,
    topics: [TOPIC],
    transactionHash: transactionHash(block, transactionIndex),
    transactionIndex: quantity(transactionIndex),
    ...options.overrides,
  }
}
type ChainProviderOptions = {
  chainId?: bigint
  getLogs?: (fromBlock: bigint, toBlock: bigint) => unknown
  hashFor?: (block: bigint) => Hex
  head?: () => bigint
  missingBlock?: (block: bigint) => boolean
}
function chainProvider(options: ChainProviderOptions = {}) {
  const request = vi.fn(async ({ method, params }: ProviderRequest) => {
    if (method === 'eth_chainId') return quantity(options.chainId ?? 1n)
    if (method === 'eth_blockNumber') return quantity(options.head?.() ?? 20n)
    if (method === 'eth_getBlockByNumber') {
      const [tag] = params as [string, boolean]
      const block = BigInt(tag)
      if (block > (options.head?.() ?? 20n)) return null
      if (options.missingBlock?.(block)) return null
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
    const cursor = eventCursor(10n, 4, 2n)
    const result = await syncEventLogs(provider, FILTER, cursor, {
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
    const result = await syncEventLogs(provider, FILTER, eventCursor(0n, 8), {
      maxLogsPerRange: 2,
      maxRangeSize: 8,
      maxRanges: 3,
    })
    expect(requestedLogRanges(request)).toEqual([
      [0n, 7n],
      [0n, 3n],
      [0n, 1n],
    ])
    expect(result.scannedRanges).toBe(1)
    expect(result.cursor.nextBlock).toBe(2n)
    expect(result.cursor.rangeSize).toBe(2)
  })

  it('shrinks ranges with too many distinct log-bearing blocks', async () => {
    const { provider, request } = chainProvider({
      head: () => 3n,
      getLogs: (fromBlock, toBlock) =>
        [0n, 1n, 2n, 3n]
          .filter((block) => block >= fromBlock && block <= toBlock)
          .map((block) => rpcLog(block)),
    })
    const result = await syncEventLogs(provider, FILTER, eventCursor(0n, 4), {
      maxLogBlocksPerRange: 2,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(requestedLogRanges(request)).toEqual([
      [0n, 3n],
      [0n, 1n],
    ])
    expect(result.logs.map((log) => log.blockNumber)).toEqual([0n, 1n])
    expect(result.cursor.nextBlock).toBe(2n)
    expect(result.scannedRanges).toBe(1)
  })

  it('does not reinterpret unrelated RPC failures as range limits', async () => {
    const { provider } = chainProvider({
      getLogs: () => {
        throw Object.assign(new Error('rate limit exceeded'), { code: 429 })
      },
    })
    await expect(
      syncEventLogs(provider, FILTER, eventCursor(0n, 8), {
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
      syncEventLogs(provider, FILTER, eventCursor(0n, 1), {
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
      eventCursor(0n, undefined, 12n),
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
    const first = await syncEventLogs(provider, FILTER, eventCursor(0n, 4), {
      maxLogsPerRange: 2,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(
      first.cursor.checkpoints.map(({ blockNumber }) => blockNumber),
    ).toEqual([3n, 7n])
    head = 9n
    reorgFrom = 4n
    const second = await syncEventLogs(provider, FILTER, first.cursor, {
      maxLogsPerRange: 2,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(second.rollbackTo).toBe(4n)
    expect(second.logs.map((log) => log.blockNumber)).toEqual([5n, 8n])
    expect(second.cursor.nextBlock).toBe(10n)
    expect(second.caughtUp).toBe(true)
  })

  it('preserves the cursor when the sampled head is temporarily behind', async () => {
    let head = 7n
    const { provider, request } = chainProvider({ head: () => head })
    const cursor = await syncEventLogs(provider, FILTER, eventCursor(0n, 4), {
      maxRangeSize: 4,
      maxRanges: 2,
    })
    const logRequests = requestedLogRanges(request).length
    head = 3n
    await expect(
      syncEventLogs(provider, FILTER, cursor.cursor),
    ).rejects.toThrow(/head is behind the event cursor checkpoint/i)
    expect(requestedLogRanges(request)).toHaveLength(logRequests)
    expect(cursor.cursor.nextBlock).toBe(8n)
  })

  it('does not use a missing checkpoint block as reorg evidence', async () => {
    const { provider: original } = chainProvider({ head: () => 3n })
    const cursor = await syncEventLogs(original, FILTER, eventCursor(0n, 4), {
      maxRangeSize: 4,
      maxRanges: 1,
    })
    const { provider: incomplete } = chainProvider({
      head: () => 3n,
      missingBlock: (block) => block === 3n,
    })
    await expect(
      syncEventLogs(incomplete, FILTER, cursor.cursor),
    ).rejects.toThrow(/could not serve expected block 3/i)
    expect(cursor.cursor.nextBlock).toBe(4n)
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
    const result = await syncEventLogs(provider, FILTER, eventCursor(0n, 4), {
      maxLogsPerRange: 2,
      maxRangeSize: 4,
      maxRanges: 2,
    })
    expect(logRequests).toBe(2)
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0]?.blockHash).toBe(blockHash(1n, 'b'))
    expect(result.cursor.checkpoints[0]?.blockHash).toBe(blockHash(3n, 'b'))
  })

  it('does not accept a stale log before the range endpoint', async () => {
    const { provider, request } = chainProvider({
      head: () => 3n,
      getLogs: () => [rpcLog(1n, { branch: 'stale' })],
    })
    await expect(
      syncEventLogs(provider, FILTER, eventCursor(0n, 4), {
        maxRangeSize: 4,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/event block hash/i)
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getBlockByNumber',
      params: ['0x1', false],
    })
  })

  it('falls back to a full rebuild when the rollback budget is exhausted', async () => {
    const { provider: original } = chainProvider({
      head: () => 7n,
      getLogs: () => [],
    })
    const first = await syncEventLogs(original, FILTER, eventCursor(0n, 4), {
      maxRangeSize: 4,
      maxRanges: 2,
    })
    const { provider: replacement } = chainProvider({
      head: () => 7n,
      hashFor: (block) => blockHash(block, 'b'),
    })
    const rebuilt = await syncEventLogs(replacement, FILTER, first.cursor, {
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
    const original = await syncEventLogs(provider, FILTER, eventCursor(0n, 4), {
      maxRangeSize: 4,
      maxRanges: 2,
    })
    rebuilding = true
    head = 11n
    const result = await syncEventLogs(provider, FILTER, original.cursor, {
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
    const cursor = eventCursor()
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
      syncEventLogs(provider, FILTER, eventCursor()),
    ).rejects.toThrow(/different chain/i)
  })

  it.each([
    ['removal state', { removed: true }],
    ['address', { address: OTHER_ADDRESS }],
    ['topics', { topics: [OTHER_TOPIC] }],
    ['block number', { blockNumber: '0x1' }],
    ['block hash', { blockHash: OTHER_TOPIC }],
    ['log data', { data: `0x${'00'.repeat(8_193)}` }],
    ['log index', { logIndex: `0x${'1'.repeat(65)}` }],
    ['transaction hash', { transactionHash: '0x01' }],
    ['topics', { topics: Array(5).fill(TOPIC) }],
  ])('rejects an invalid event log %s', async (field, overrides) => {
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [rpcLog(0n, { overrides })],
    })
    await expect(
      syncEventLogs(provider, FILTER, eventCursor(0n, 1), {
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
      syncEventLogs(provider, FILTER, eventCursor(0n, 1), {
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/duplicate event log/i)
  })

  it('rejects transaction indexes that contradict canonical log order', async () => {
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [
        rpcLog(0n, {
          logIndex: 0,
          transactionIndex: 1,
        }),
        rpcLog(0n, { logIndex: 1, transactionIndex: 0 }),
      ],
    })
    await expect(
      syncEventLogs(provider, FILTER, eventCursor(0n, 1), {
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/transaction metadata/i)
  })

  it.each([
    [
      'different hashes for one transaction index',
      [
        rpcLog(0n),
        rpcLog(0n, {
          logIndex: 1,
          overrides: { transactionHash: OTHER_TOPIC },
        }),
      ],
    ],
    [
      'one transaction hash at different indexes',
      [
        rpcLog(0n),
        rpcLog(0n, {
          logIndex: 1,
          overrides: { transactionHash: transactionHash(0n) },
          transactionIndex: 1,
        }),
      ],
    ],
  ])('rejects %s', async (_description, logs) => {
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => logs,
    })
    await expect(
      syncEventLogs(provider, FILTER, eventCursor(0n, 1), {
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/transaction metadata/i)
  })

  it('requires every positional wildcard topic to exist', async () => {
    const filter = {
      address: PROTOCOL_ADDRESS,
      topics: [TOPIC, null],
    } as const
    const cursor = createEventCursor({
      chainId: 1n,
      filter,
      finalityDepth: 0n,
      rangeSize: 1,
      startBlock: 0n,
    })
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [rpcLog(0n)],
    })
    await expect(
      syncEventLogs(provider, filter, cursor, {
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/event log topics/i)
  })

  it('rejects mixed block hashes at one height', async () => {
    const { provider } = chainProvider({
      head: () => 0n,
      getLogs: () => [rpcLog(0n), rpcLog(0n, { branch: 'b', logIndex: 1 })],
    })
    await expect(
      syncEventLogs(provider, FILTER, eventCursor(0n, 1), {
        maxRangeSize: 1,
        maxRanges: 1,
      }),
    ).rejects.toThrow(/event block hash/i)
  })

  it('bounds cursor identifiers before normalizing them', async () => {
    const request = vi.fn()
    const cursor = {
      ...eventCursor(),
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
      syncEventLogs({ request }, FILTER, eventCursor(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(request).not.toHaveBeenCalled()
  })

  it('interrupts an in-flight provider request on cancellation', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const request = vi.fn()
    const requestWithSignal = vi.fn(
      (_request: ProviderRequest, signal: AbortSignal) => {
        requestSignal = signal
        markStarted?.()
        return new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    )
    const synchronization = syncEventLogs(
      { request, requestWithSignal },
      FILTER,
      eventCursor(),
      {
        signal: controller.signal,
        timeoutMs: 60_000,
      },
    )
    const rejected = expect(synchronization).rejects.toThrow(/cancelled/i)
    await started
    controller.abort()
    await rejected
    expect(requestWithSignal).toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(requestSignal?.aborted).toBe(true)
  })

  it('bounds a stalled provider request', async () => {
    let requestSignal: AbortSignal | undefined
    const request = vi.fn()
    const requestWithSignal = vi.fn(
      (_request: ProviderRequest, signal: AbortSignal) => {
        requestSignal = signal
        return new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    )
    await expect(
      syncEventLogs({ request, requestWithSignal }, FILTER, eventCursor(), {
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out/i)
    expect(requestSignal?.aborted).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('interrupts an in-flight request when the provider disconnects', async () => {
    const listeners = new Map<string, () => void>()
    const removeListener = vi.fn((event: string) => listeners.delete(event))
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const request = vi.fn(({ method }: ProviderRequest) => {
      if (method === 'eth_blockNumber') return Promise.resolve('0x0')
      markStarted?.()
      return new Promise<unknown>(() => undefined)
    })
    const synchronization = syncEventLogs(
      {
        on: (event, listener) => listeners.set(event, listener),
        removeListener,
        request,
      },
      FILTER,
      eventCursor(),
      { timeoutMs: 60_000 },
    )
    const rejected = expect(synchronization).rejects.toThrow(/chain changed/i)
    await started
    listeners.get('disconnect')?.()
    await rejected
    expect(removeListener).toHaveBeenCalledTimes(2)
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
      syncEventLogs(provider, FILTER, eventCursor(), {}),
    ).rejects.toThrow(/chain changed/i)
    expect(removeListener).toHaveBeenCalledTimes(2)
  })
})
