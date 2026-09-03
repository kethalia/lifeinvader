import { describe, expect, it, vi } from 'vitest'

import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  assertProtocolConfiguration,
  FACTORY_ADDRESS,
  FACTORY_CODE_HASH,
  getPostBodyByteLength,
  inspectProtocol,
  MAX_POST_BODY_BYTES,
  PROTOCOL_ADDRESS,
  publishPost,
  switchToLocalChain,
  waitForTransactionReceipt,
} from './protocol'

const FACTORY_RUNTIME_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ACCOUNT = '0x000000000000000000000000000000000000a11c'

function providerFrom(
  request: (args: ProviderRequest) => Promise<unknown>,
): Eip1193Provider {
  return { request }
}

describe('protocol configuration', () => {
  it('keeps the browser deployment inputs frozen to the published v1 address', () => {
    expect(() => assertProtocolConfiguration()).not.toThrow()
    expect(FACTORY_CODE_HASH).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('recognizes a chain where the canonical factory can deploy v1', async () => {
    const provider = providerFrom(async ({ method, params }) => {
      expect(method).toBe('eth_getCode')
      const [address] = params as readonly string[]
      if (address === PROTOCOL_ADDRESS) return '0x'
      if (address === FACTORY_ADDRESS) return FACTORY_RUNTIME_CODE.toUpperCase()
      throw new Error(`Unexpected address: ${address}`)
    })

    await expect(inspectProtocol(provider)).resolves.toEqual({
      kind: 'deployable',
    })
  })

  it.each([
    ['missing-factory', '0x'],
    ['unsafe-factory', '0x00'],
  ] as const)(
    'reports %s without enabling deployment',
    async (kind, factoryCode) => {
      const provider = providerFrom(async ({ params }) => {
        const [address] = params as readonly string[]
        return address === PROTOCOL_ADDRESS ? '0x' : factoryCode
      })

      await expect(inspectProtocol(provider)).resolves.toEqual({ kind })
    },
  )

  it('rejects unexpected code at the predetermined protocol address', async () => {
    const request = vi.fn(async () => '0x00')

    await expect(inspectProtocol(providerFrom(request))).resolves.toEqual({
      kind: 'address-conflict',
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('post transactions', () => {
  it('measures the same UTF-8 bytes the contract limits', () => {
    expect(getPostBodyByteLength('invade')).toBe(6)
    expect(getPostBodyByteLength('👁️')).toBe(7)
  })

  it('parses a successful transaction receipt', async () => {
    const provider = providerFrom(async () => ({
      blockNumber: '0x2a',
      status: '0x1',
    }))

    await expect(
      waitForTransactionReceipt(provider, TRANSACTION_HASH),
    ).resolves.toEqual({ blockNumber: 42n, hash: TRANSACTION_HASH })
  })

  it('rejects an oversized UTF-8 body before opening the wallet', async () => {
    const request = vi.fn()

    await expect(
      publishPost(
        providerFrom(request),
        ACCOUNT,
        '🫥'.repeat(MAX_POST_BODY_BYTES),
      ),
    ).rejects.toThrow(/4096 UTF-8 bytes/i)
    expect(request).not.toHaveBeenCalled()
  })

  it('surfaces an on-chain revert from the receipt', async () => {
    const provider = providerFrom(async () => ({
      blockNumber: '0x2a',
      status: '0x0',
    }))

    await expect(
      waitForTransactionReceipt(provider, TRANSACTION_HASH),
    ).rejects.toThrow(/reverted on-chain/i)
  })
})

describe('local wallet network', () => {
  it('adds an unknown Anvil chain and selects it when still required', async () => {
    let firstSwitch = true
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'wallet_switchEthereumChain' && firstSwitch) {
        firstSwitch = false
        throw Object.assign(new Error('Unknown chain'), { code: 4902 })
      }
      if (method === 'eth_chainId') return '0x1'
      return null
    })

    await switchToLocalChain(providerFrom(request))

    expect(request.mock.calls.map(([request]) => request.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'wallet_switchEthereumChain',
    ])
    expect(request.mock.calls[1]?.[0].params).toEqual([
      expect.objectContaining({
        chainId: '0x7a69',
        rpcUrls: ['http://127.0.0.1:8545'],
      }),
    ])
  })

  it('does not repeat the switch when adding the chain selected it', async () => {
    let firstSwitch = true
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'wallet_switchEthereumChain' && firstSwitch) {
        firstSwitch = false
        throw Object.assign(new Error('Unknown chain'), { code: 4902 })
      }
      if (method === 'eth_chainId') return '0x7A69'
      return null
    })

    await switchToLocalChain(providerFrom(request))

    expect(request.mock.calls.map(([request]) => request.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
    ])
  })
})
