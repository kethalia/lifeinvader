import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, stringToHex, type Hex } from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  discoverProtocolHistoryBoundary,
  isProtocolHistoryUnavailableError,
  resolveProtocolHistoryBoundary,
} from './protocol-history'
import { LIFEINVADER_INIT_CODE, PROTOCOL_ADDRESS } from './protocol'

const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

function blockHash(blockNumber: bigint, branch = 'a') {
  return keccak256(stringToHex(`history:${blockNumber.toString()}:${branch}`))
}

function quantity(value: bigint) {
  return `0x${value.toString(16)}`
}

function numericBlock(params: ProviderRequest['params']) {
  const [blockTag] = params as [string]
  return BigInt(blockTag)
}

function providerWithDeployment({
  deploymentBlock = 37n,
  head = 100n,
  onBlock,
  onChainId,
  onCode,
  onHead,
}: {
  deploymentBlock?: bigint
  head?: bigint
  onBlock?(blockNumber: bigint): { hash: Hex; number: string }
  onChainId?(): unknown
  onCode?(blockNumber: bigint): unknown
  onHead?(): unknown
} = {}) {
  const requests: ProviderRequest[] = []
  let codeRequestsInFlight = 0
  let maximumCodeConcurrency = 0
  const provider: Eip1193Provider = {
    async request(request) {
      requests.push(request)
      if (request.method === 'eth_chainId') return onChainId?.() ?? '0x1'
      if (request.method === 'eth_blockNumber') {
        return onHead?.() ?? quantity(head)
      }
      if (request.method === 'eth_getBlockByNumber') {
        const blockNumber = numericBlock(request.params)
        return (
          onBlock?.(blockNumber) ?? {
            hash: blockHash(blockNumber),
            number: quantity(blockNumber),
          }
        )
      }
      if (request.method === 'eth_getCode') {
        const [address] = request.params as [string, string]
        expect(address).toBe(PROTOCOL_ADDRESS)
        const blockNumber = numericBlock(
          (request.params as [string, string]).slice(1),
        )
        codeRequestsInFlight += 1
        maximumCodeConcurrency = Math.max(
          maximumCodeConcurrency,
          codeRequestsInFlight,
        )
        await Promise.resolve()
        codeRequestsInFlight -= 1
        return (
          onCode?.(blockNumber) ??
          (blockNumber >= deploymentBlock ? PROTOCOL_RUNTIME_CODE : '0x')
        )
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    },
  }
  return {
    maximumCodeConcurrency: () => maximumCodeConcurrency,
    provider,
    requests,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('protocol history discovery', () => {
  it('finds and authenticates the first confirmed protocol-code block', async () => {
    const prepared = providerWithDeployment()

    const boundary = await discoverProtocolHistoryBoundary(
      prepared.provider,
      1n,
    )

    expect(boundary).toEqual({
      chainId: 1n,
      codeProbes: 11,
      confirmedThrough: {
        blockHash: blockHash(88n),
        blockNumber: 88n,
      },
      deployment: {
        blockHash: blockHash(37n),
        blockNumber: 37n,
      },
      head: { blockHash: blockHash(100n), blockNumber: 100n },
      kind: 'confirmed',
      preceding: {
        blockHash: blockHash(36n),
        blockNumber: 36n,
      },
      startBlock: 37n,
    })
    expect(Object.isFrozen(boundary)).toBe(true)
    expect(Object.isFrozen(boundary.deployment)).toBe(true)
    expect(prepared.maximumCodeConcurrency()).toBe(1)
    const blockRequests = prepared.requests
      .filter(({ method }) => method === 'eth_getBlockByNumber')
      .map(({ params }) => numericBlock(params))
    expect(blockRequests).toEqual([100n, 88n, 37n, 36n, 100n])
  })

  it('starts after confirmed emptiness while deployment is still pending', async () => {
    const prepared = providerWithDeployment({
      deploymentBlock: 14n,
      head: 20n,
    })

    await expect(
      discoverProtocolHistoryBoundary(prepared.provider, 1n),
    ).resolves.toEqual({
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
    })
  })

  it('uses genesis when the chain has no confirmed block yet', async () => {
    const prepared = providerWithDeployment({ deploymentBlock: 1n, head: 5n })

    const boundary = await discoverProtocolHistoryBoundary(
      prepared.provider,
      1n,
    )
    expect(boundary).toMatchObject({
      codeProbes: 1,
      kind: 'pending-confirmation',
      startBlock: 0n,
    })
    expect(boundary).not.toHaveProperty('confirmedThrough')
    expect(boundary).not.toHaveProperty('deployment')
  })

  it('accepts protocol code present from block zero', async () => {
    const prepared = providerWithDeployment({ deploymentBlock: 0n, head: 20n })

    await expect(
      discoverProtocolHistoryBoundary(prepared.provider, 1n),
    ).resolves.toMatchObject({
      deployment: { blockHash: blockHash(0n), blockNumber: 0n },
      kind: 'confirmed',
      preceding: undefined,
      startBlock: 0n,
    })
  })

  it('rejects missing or unexpected code at the selected head', async () => {
    const missing = providerWithDeployment({ deploymentBlock: 101n })
    await expect(
      discoverProtocolHistoryBoundary(missing.provider, 1n),
    ).rejects.toThrow(/not deployed at the selected head/i)

    const conflicting = providerWithDeployment({ onCode: () => '0x01' })
    await expect(
      discoverProtocolHistoryBoundary(conflicting.provider, 1n),
    ).rejects.toThrow(/unexpected code at block 100/i)
  })

  it('rejects unexpected code encountered inside historical state', async () => {
    const prepared = providerWithDeployment({
      onCode: (blockNumber) =>
        blockNumber === 44n
          ? '0x01'
          : blockNumber >= 37n
            ? PROTOCOL_RUNTIME_CODE
            : '0x',
    })

    await expect(
      discoverProtocolHistoryBoundary(prepared.provider, 1n),
    ).rejects.toThrow(/unexpected code at block 44/i)
  })

  it('enforces a hard code-probe budget', async () => {
    const prepared = providerWithDeployment()

    await expect(
      discoverProtocolHistoryBoundary(prepared.provider, 1n, {
        maxCodeProbes: 2,
      }),
    ).rejects.toThrow(/exceeded 2 code probes/i)
    expect(
      prepared.requests.filter(({ method }) => method === 'eth_getCode'),
    ).toHaveLength(2)
  })

  it('does not classify a local deadline as unavailable history', async () => {
    vi.useFakeTimers()
    const prepared = providerWithDeployment({
      onCode: () => new Promise<unknown>(() => undefined),
    })
    const outcome = discoverProtocolHistoryBoundary(prepared.provider, 1n, {
      timeoutMs: 25,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(25)
    const error = await outcome

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/discovery timed out/i)
    expect(isProtocolHistoryUnavailableError(error)).toBe(false)
  })

  it('brackets discovery with the selected chain and anchored head', async () => {
    let chainReads = 0
    const wrongChain = providerWithDeployment({
      onChainId: () => (chainReads++ === 0 ? '0x1' : '0x2'),
    })
    await expect(
      discoverProtocolHistoryBoundary(wrongChain.provider, 1n),
    ).rejects.toThrow(/another wallet chain/i)

    let headReads = 0
    const regressing = providerWithDeployment({
      onHead: () => quantity(headReads++ === 0 ? 100n : 99n),
    })
    await expect(
      discoverProtocolHistoryBoundary(regressing.provider, 1n),
    ).rejects.toThrow(/head moved behind/i)

    let anchorReads = 0
    const replaced = providerWithDeployment({
      onBlock: (blockNumber) => ({
        hash: blockHash(
          blockNumber,
          blockNumber === 100n && anchorReads++ > 0 ? 'b' : 'a',
        ),
        number: quantity(blockNumber),
      }),
    })
    await expect(
      discoverProtocolHistoryBoundary(replaced.provider, 1n),
    ).rejects.toThrow(/anchor changed during discovery/i)
  })

  it('rejects malformed RPC quantities, blocks, and code', async () => {
    const badHead = providerWithDeployment({ onHead: () => '0x00' })
    await expect(
      discoverProtocolHistoryBoundary(badHead.provider, 1n),
    ).rejects.toThrow(/invalid protocol history head/i)

    const badBlock = providerWithDeployment({
      onBlock: () => ({ hash: '0x01', number: '0x64' }),
    })
    await expect(
      discoverProtocolHistoryBoundary(badBlock.provider, 1n),
    ).rejects.toThrow(/invalid protocol history block hash/i)

    const badCode = providerWithDeployment({ onCode: () => '0x1' })
    await expect(
      discoverProtocolHistoryBoundary(badCode.provider, 1n),
    ).rejects.toThrow(/invalid protocol code/i)
  })

  it('cancels stalled work and removes provider listeners', async () => {
    const controller = new AbortController()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn(({ method }) => {
        if (method === 'eth_chainId') return Promise.resolve('0x1')
        return new Promise<unknown>(() => {
          queueMicrotask(() => controller.abort())
        })
      }),
    }

    await expect(
      discoverProtocolHistoryBoundary(provider, 1n, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(listeners.size).toBe(0)
  })

  it('interrupts discovery when the injected wallet changes chain', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn(({ method }) => {
        if (method === 'eth_chainId') return Promise.resolve('0x1')
        return new Promise<unknown>(() => {
          queueMicrotask(() => listeners.get('chainChanged')?.('0x2'))
        })
      }),
    }

    await expect(discoverProtocolHistoryBoundary(provider, 1n)).rejects.toThrow(
      /chain changed during protocol history/i,
    )
    expect(listeners.size).toBe(0)
  })

  it('validates inputs before making an RPC request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider

    await expect(
      discoverProtocolHistoryBoundary(provider, -1n),
    ).rejects.toThrow(/invalid protocol history chain/i)
    await expect(
      discoverProtocolHistoryBoundary(provider, 1n, { finalityDepth: -1n }),
    ).rejects.toThrow(/invalid protocol history finality/i)
    await expect(
      discoverProtocolHistoryBoundary(provider, 1n, { maxCodeProbes: 65 }),
    ).rejects.toThrow(/invalid protocol history code probe/i)
    await expect(
      discoverProtocolHistoryBoundary(provider, 1n, { timeoutMs: 0 }),
    ).rejects.toThrow(/invalid protocol history timeout/i)
    expect(provider.request).not.toHaveBeenCalled()
  })
})

describe('resolved protocol history boundaries', () => {
  it('reuses a successful boundary for the same provider and policy', async () => {
    const prepared = providerWithDeployment()

    const first = await resolveProtocolHistoryBoundary(prepared.provider, 1n)
    const requestCount = prepared.requests.length
    const second = await resolveProtocolHistoryBoundary(prepared.provider, 1n)

    expect(second).toBe(first)
    expect(prepared.requests.slice(requestCount)).toEqual([
      { method: 'eth_chainId' },
      {
        method: 'eth_getBlockByNumber',
        params: ['0x64', false],
      },
      { method: 'eth_chainId' },
    ])
  })

  it('rediscovers after a same-chain-id head anchor is replaced', async () => {
    let branch = 'a'
    let deploymentBlock = 37n
    const prepared = providerWithDeployment({
      onBlock: (blockNumber) => ({
        hash: blockHash(blockNumber, branch),
        number: quantity(blockNumber),
      }),
      onCode: (blockNumber) =>
        blockNumber >= deploymentBlock ? PROTOCOL_RUNTIME_CODE : '0x',
    })
    const first = await resolveProtocolHistoryBoundary(prepared.provider, 1n)
    const codeRequests = prepared.requests.filter(
      ({ method }) => method === 'eth_getCode',
    ).length

    branch = 'b'
    deploymentBlock = 41n
    const second = await resolveProtocolHistoryBoundary(prepared.provider, 1n)

    expect(second).not.toBe(first)
    expect(second).toMatchObject({
      deployment: {
        blockHash: blockHash(41n, 'b'),
        blockNumber: 41n,
      },
      startBlock: 41n,
    })
    expect(
      prepared.requests.filter(({ method }) => method === 'eth_getCode').length,
    ).toBeGreaterThan(codeRequests)
  })
})
