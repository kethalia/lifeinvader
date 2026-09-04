import { encodeAbiParameters, toFunctionSelector, type Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_MAINNET_CHAIN_ID,
  FILECOIN_STORAGE_NETWORKS,
  getFilecoinStorageNetwork,
  inspectFilecoinStorage,
  type FilecoinStorageContract,
} from './filecoin-storage'

const CALIBRATION = FILECOIN_STORAGE_NETWORKS[1]
const OTHER_ADDRESS = '0x0000000000000000000000000000000000001234'

const CONTRACT_BY_SELECTOR = new Map<string, FilecoinStorageContract>([
  [toFunctionSelector('paymentsContractAddress()'), 'filecoinPay'],
  [toFunctionSelector('viewContractAddress()'), 'fwssView'],
  [toFunctionSelector('pdpVerifierAddress()'), 'pdp'],
  [toFunctionSelector('serviceProviderRegistry()'), 'serviceProviderRegistry'],
  [toFunctionSelector('sessionKeyRegistry()'), 'sessionKeyRegistry'],
  [toFunctionSelector('usdfcTokenAddress()'), 'usdfc'],
])

function requestParams(request: ProviderRequest): readonly unknown[] {
  return Array.isArray(request.params) ? request.params : []
}

function deploymentProvider({
  addressOverrides = {},
  chainIds = [FILECOIN_CALIBRATION_CHAIN_ID],
  malformedCall,
  malformedCode,
  missingCode = [],
}: {
  addressOverrides?: Partial<Record<FilecoinStorageContract, Address>>
  chainIds?: readonly bigint[]
  malformedCall?: unknown
  malformedCode?: unknown
  missingCode?: readonly FilecoinStorageContract[]
} = {}) {
  const requests: ProviderRequest[] = []
  let chainRead = 0
  let activeRequests = 0
  let maximumConcurrentRequests = 0
  const provider: Eip1193Provider = {
    request: vi.fn(async (request) => {
      requests.push(request)
      activeRequests += 1
      maximumConcurrentRequests = Math.max(
        maximumConcurrentRequests,
        activeRequests,
      )
      await Promise.resolve()
      try {
        if (request.method === 'eth_chainId') {
          const chainId = chainIds[Math.min(chainRead, chainIds.length - 1)]
          chainRead += 1
          return `0x${(chainId ?? 0n).toString(16)}`
        }
        if (request.method === 'eth_getCode') {
          if (malformedCode !== undefined) return malformedCode
          const address = requestParams(request)[0]
          const contract = Object.entries(CALIBRATION.contracts).find(
            ([, candidate]) =>
              typeof address === 'string' &&
              candidate.toLowerCase() === address.toLowerCase(),
          )?.[0] as FilecoinStorageContract | undefined
          return contract && missingCode.includes(contract) ? '0x' : '0x6000'
        }
        if (request.method === 'eth_call') {
          if (malformedCall !== undefined) return malformedCall
          const call = requestParams(request)[0] as
            { data?: unknown; to?: unknown } | undefined
          if (
            typeof call?.data !== 'string' ||
            call.to !== CALIBRATION.contracts.fwss
          ) {
            throw new Error('Unexpected eth_call payload.')
          }
          const contract = CONTRACT_BY_SELECTOR.get(call.data.slice(0, 10))
          if (!contract) throw new Error('Unexpected FWSS getter.')
          return encodeAbiParameters(
            [{ type: 'address' }],
            [addressOverrides[contract] ?? CALIBRATION.contracts[contract]],
          )
        }
        throw new Error(`Unexpected method: ${request.method}`)
      } finally {
        activeRequests -= 1
      }
    }),
  }
  return {
    get maximumConcurrentRequests() {
      return maximumConcurrentRequests
    },
    provider,
    requests,
  }
}

describe('Filecoin storage deployment inspection', () => {
  it('recognizes only the two supported Filecoin production networks', () => {
    expect(getFilecoinStorageNetwork(FILECOIN_MAINNET_CHAIN_ID)?.name).toBe(
      'Filecoin mainnet',
    )
    expect(getFilecoinStorageNetwork(FILECOIN_CALIBRATION_CHAIN_ID)?.name).toBe(
      'Filecoin Calibration',
    )
    expect(getFilecoinStorageNetwork(31_337n)).toBeUndefined()
    expect(getFilecoinStorageNetwork(undefined)).toBeUndefined()
  })

  it('does no contract reads on an unsupported chain', async () => {
    const { provider, requests } = deploymentProvider({ chainIds: [31_337n] })

    await expect(inspectFilecoinStorage(provider)).resolves.toEqual({
      chainId: 31_337n,
      kind: 'unsupported-chain',
    })
    expect(requests.map(({ method }) => method)).toEqual(['eth_chainId'])
  })

  it('rejects a wallet chain that no longer matches its UI context', async () => {
    const { provider, requests } = deploymentProvider()

    await expect(
      inspectFilecoinStorage(provider, {
        expectedChainId: FILECOIN_MAINNET_CHAIN_ID,
      }),
    ).rejects.toThrow(/moved from expected chain 314 to chain 314159/i)
    expect(requests.map(({ method }) => method)).toEqual(['eth_chainId'])
  })

  it('verifies the canonical graph with bounded sequential wallet reads', async () => {
    const inspection = deploymentProvider()

    await expect(inspectFilecoinStorage(inspection.provider)).resolves.toEqual({
      kind: 'ready',
      network: CALIBRATION,
    })

    expect(
      inspection.requests.filter(({ method }) => method === 'eth_call'),
    ).toHaveLength(6)
    expect(
      inspection.requests.filter(({ method }) => method === 'eth_getCode'),
    ).toHaveLength(Object.keys(CALIBRATION.contracts).length)
    expect(
      inspection.requests.filter(({ method }) => method === 'eth_chainId'),
    ).toHaveLength(2)
    expect(inspection.maximumConcurrentRequests).toBe(1)
  })

  it('stops before calling an absent FWSS deployment', async () => {
    const { provider, requests } = deploymentProvider({
      missingCode: ['fwss'],
    })

    await expect(inspectFilecoinStorage(provider)).resolves.toEqual({
      issues: [
        {
          address: CALIBRATION.contracts.fwss,
          contract: 'fwss',
          kind: 'missing-code',
        },
      ],
      kind: 'unavailable',
      network: CALIBRATION,
    })
    expect(requests.filter(({ method }) => method === 'eth_call')).toHaveLength(
      0,
    )
    expect(
      requests.filter(({ method }) => method === 'eth_getCode'),
    ).toHaveLength(1)
  })

  it('rejects an FWSS graph that redirects a dependency', async () => {
    const { provider, requests } = deploymentProvider({
      addressOverrides: { filecoinPay: OTHER_ADDRESS },
    })

    await expect(inspectFilecoinStorage(provider)).resolves.toEqual({
      issues: [
        {
          contract: 'filecoinPay',
          expected: CALIBRATION.contracts.filecoinPay,
          kind: 'address-mismatch',
          received: OTHER_ADDRESS,
        },
      ],
      kind: 'unavailable',
      network: CALIBRATION,
    })
    expect(
      requests.filter(({ method }) => method === 'eth_getCode'),
    ).toHaveLength(1)
  })

  it('reports every missing dependency after the graph matches', async () => {
    const { provider } = deploymentProvider({
      missingCode: ['endorsements', 'usdfc'],
    })

    await expect(inspectFilecoinStorage(provider)).resolves.toMatchObject({
      issues: [
        {
          address: CALIBRATION.contracts.endorsements,
          contract: 'endorsements',
          kind: 'missing-code',
        },
        {
          address: CALIBRATION.contracts.usdfc,
          contract: 'usdfc',
          kind: 'missing-code',
        },
      ],
      kind: 'unavailable',
    })
  })

  it('rejects malformed wallet data and mid-inspection chain changes', async () => {
    const malformedCode = deploymentProvider({ malformedCode: '0x0' })
    await expect(
      inspectFilecoinStorage(malformedCode.provider),
    ).rejects.toThrow(/invalid contract code/i)

    const malformedCall = deploymentProvider({ malformedCall: '0x' })
    await expect(
      inspectFilecoinStorage(malformedCall.provider),
    ).rejects.toThrow(/invalid paymentsContractAddress data/i)

    const nonZeroPadding = deploymentProvider({
      malformedCall: `0x${'01'.repeat(12)}${CALIBRATION.contracts.filecoinPay.slice(2)}`,
    })
    await expect(
      inspectFilecoinStorage(nonZeroPadding.provider),
    ).rejects.toThrow(/invalid paymentsContractAddress data/i)

    const changedChain = deploymentProvider({
      chainIds: [FILECOIN_CALIBRATION_CHAIN_ID, FILECOIN_MAINNET_CHAIN_ID],
    })
    await expect(inspectFilecoinStorage(changedChain.provider)).rejects.toThrow(
      /chain changed during inspection/i,
    )
  })

  it('rejects and unsubscribes after an A-to-B-to-A chain event', async () => {
    const deployment = deploymentProvider()
    const chainListeners = new Set<(...args: unknown[]) => void>()
    let switched = false
    const provider: Eip1193Provider = {
      request: vi.fn(async (request) => {
        if (!switched && request.method === 'eth_getCode') {
          switched = true
          chainListeners.forEach((listener) => listener('0x13a'))
          chainListeners.forEach((listener) => listener('0x4cb2f'))
        }
        return deployment.provider.request(request)
      }),
      on: vi.fn((event, listener) => {
        if (event === 'chainChanged') chainListeners.add(listener)
      }),
      removeListener: vi.fn((event, listener) => {
        if (event === 'chainChanged') chainListeners.delete(listener)
      }),
    }

    await expect(inspectFilecoinStorage(provider)).rejects.toThrow(
      /chain changed during inspection/i,
    )
    expect(provider.on).toHaveBeenCalledWith(
      'chainChanged',
      expect.any(Function),
    )
    expect(provider.removeListener).toHaveBeenCalledWith(
      'chainChanged',
      expect.any(Function),
    )
    expect(chainListeners.size).toBe(0)
  })

  it('bounds stalled reads and honors cancellation', async () => {
    const stalledProvider: Eip1193Provider = {
      request: vi.fn(() => new Promise(() => undefined)),
    }
    await expect(
      inspectFilecoinStorage(stalledProvider, { timeoutMs: 5 }),
    ).rejects.toThrow(/wallet read timed out/i)

    const controller = new AbortController()
    controller.abort()
    await expect(
      inspectFilecoinStorage(stalledProvider, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/inspection was cancelled/i)
  })
})
