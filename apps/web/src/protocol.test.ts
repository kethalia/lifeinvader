import { describe, expect, it, vi } from 'vitest'

import {
  parseChainId,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  assertProtocolConfiguration,
  deployProtocol,
  FACTORY_ADDRESS,
  FACTORY_CODE_HASH,
  getPostBodyByteLength,
  inspectProtocol,
  isTransactionRevertedError,
  MAX_POST_BODY_BYTES,
  PROTOCOL_ADDRESS,
  publishPost,
  switchToLocalChain,
  verifyLocalChain,
  waitForTransactionReceipt,
} from './protocol'

const FACTORY_RUNTIME_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BLOCK_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER_BLOCK_HASH =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const ACCOUNT = '0x000000000000000000000000000000000000a11c'
function providerFrom(
  request: (args: ProviderRequest) => Promise<unknown>,
): Eip1193Provider {
  return { request }
}
function fingerprintProvider(
  blockHash = BLOCK_HASH,
  chainId = '0x7a69',
): Eip1193Provider {
  return providerFrom(async ({ method, params }) => {
    if (method === 'eth_chainId') return chainId
    if (method === 'eth_blockNumber') return '0x2a'
    if (method === 'eth_getBlockByNumber') {
      expect(params).toEqual(['0x2a', false])
      return { hash: blockHash, number: '0x2a' }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
}
describe('protocol configuration', () => {
  it('keeps the browser deployment inputs frozen to the published v1 address', () => {
    expect(() => assertProtocolConfiguration()).not.toThrow()
    expect(FACTORY_CODE_HASH).toMatch(/^0x[0-9a-f]{64}$/)
  })
  it('rejects chain quantities wider than an EVM word', () => {
    expect(() => parseChainId(`0x${'1'.repeat(65)}`)).toThrow(
      /invalid chain identifier/i,
    )
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
  it('bounds stalled contract-code reads', async () => {
    const request = vi.fn(() => new Promise<unknown>(() => undefined))
    await expect(inspectProtocol(providerFrom(request), 5)).rejects.toThrow(
      /inspection timed out/i,
    )
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
      transactionHash: TRANSACTION_HASH,
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
        1n,
        '🫥'.repeat(MAX_POST_BODY_BYTES),
      ),
    ).rejects.toThrow(/4096 UTF-8 bytes/i)
    expect(request).not.toHaveBeenCalled()
  })
  it('surfaces an on-chain revert from the receipt', async () => {
    const provider = providerFrom(async () => ({
      blockNumber: '0x2a',
      status: '0x0',
      transactionHash: TRANSACTION_HASH,
    }))
    const error = await waitForTransactionReceipt(
      provider,
      TRANSACTION_HASH,
    ).catch((error: unknown) => error)
    expect(isTransactionRevertedError(error)).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/reverted on-chain/i)
  })
  it('stops polling when the receipt provider rejects', async () => {
    const request = vi.fn(async () => {
      throw new Error('Wallet disconnected.')
    })
    await expect(
      waitForTransactionReceipt(providerFrom(request), TRANSACTION_HASH),
    ).rejects.toThrow(/wallet disconnected/i)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('rejects a receipt for a different transaction', async () => {
    const provider = providerFrom(async () => ({
      blockNumber: '0x2a',
      status: '0x1',
      transactionHash: OTHER_BLOCK_HASH,
    }))
    await expect(
      waitForTransactionReceipt(provider, TRANSACTION_HASH),
    ).rejects.toThrow(/different transaction/i)
  })
  it('bounds repeated null receipts without discarding the hash', async () => {
    const request = vi.fn(async () => null)
    await expect(
      waitForTransactionReceipt(providerFrom(request), TRANSACTION_HASH, {
        pollIntervalMs: 10,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(TRANSACTION_HASH)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('times out a receipt request that never settles', async () => {
    const request = vi.fn(() => new Promise<unknown>(() => undefined))
    await expect(
      waitForTransactionReceipt(providerFrom(request), TRANSACTION_HASH, {
        timeoutMs: 5,
      }),
    ).rejects.toThrow(TRANSACTION_HASH)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('rechecks the selected chain after reading a receipt', async () => {
    let changed = false
    const assertCurrentChain = vi.fn(async () => {
      if (changed) throw new Error('Wallet network changed.')
    })
    const provider = providerFrom(async () => {
      changed = true
      return {
        blockNumber: '0x2a',
        status: '0x1',
        transactionHash: TRANSACTION_HASH,
      }
    })
    await expect(
      waitForTransactionReceipt(provider, TRANSACTION_HASH, {
        assertCurrentChain,
      }),
    ).rejects.toThrow(/network changed/i)
    expect(assertCurrentChain).toHaveBeenCalledTimes(2)
  })
})
describe('transaction chain binding', () => {
  it('rejects a chain different from the click-time selection', async () => {
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x2'
      if (method === 'eth_accounts') return [ACCOUNT]
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(providerFrom(request), ACCOUNT, 1n),
    ).rejects.toThrow(/network changed/i)
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'eth_getCode' }),
    )
  })
  it('does not open the transaction request after the inspected chain changes', async () => {
    let handleChainChanged: ((...args: unknown[]) => void) | undefined
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_getCode') {
        const [address] = params as readonly string[]
        if (address === PROTOCOL_ADDRESS) return '0x'
        if (address === FACTORY_ADDRESS) {
          handleChainChanged?.('0x2')
          return FACTORY_RUNTIME_CODE
        }
      }
      if (method === 'eth_sendTransaction') return TRANSACTION_HASH
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(
        {
          request,
          on: (event, listener) => {
            if (event === 'chainChanged') handleChainChanged = listener
          },
          removeListener: (event) => {
            if (event === 'chainChanged') handleChainChanged = undefined
          },
        },
        ACCOUNT,
        1n,
      ),
    ).rejects.toThrow(/network changed/i)
    expect(
      request.mock.calls.some(
        ([request]) => request.method === 'eth_sendTransaction',
      ),
    ).toBe(false)
  })
  it('reports the hash when the wallet changes chain during submission', async () => {
    let handleChainChanged: ((...args: unknown[]) => void) | undefined
    const onSubmitted = vi.fn()
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_getCode') {
        const [address] = params as readonly string[]
        return address === PROTOCOL_ADDRESS ? '0x' : FACTORY_RUNTIME_CODE
      }
      if (method === 'eth_sendTransaction') {
        expect(params).toEqual([expect.objectContaining({ chainId: '0x1' })])
        handleChainChanged?.('0x2')
        return TRANSACTION_HASH
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(
        {
          request,
          on: (event, listener) => {
            if (event === 'chainChanged') handleChainChanged = listener
          },
          removeListener: (event) => {
            if (event === 'chainChanged') handleChainChanged = undefined
          },
        },
        ACCOUNT,
        1n,
        onSubmitted,
      ),
    ).rejects.toThrow(/network changed/i)
    expect(onSubmitted).toHaveBeenCalledWith(TRANSACTION_HASH)
    expect(
      request.mock.calls.some(
        ([request]) => request.method === 'eth_getTransactionReceipt',
      ),
    ).toBe(false)
  })
  it('does not submit after the selected account changes', async () => {
    let handleAccountsChanged: ((...args: unknown[]) => void) | undefined
    const request = vi.fn(async ({ method, params }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [ACCOUNT]
      if (method === 'eth_getCode') {
        const [address] = params as readonly string[]
        if (address === PROTOCOL_ADDRESS) return '0x'
        handleAccountsChanged?.(['0x000000000000000000000000000000000000b0b0'])
        return FACTORY_RUNTIME_CODE
      }
      if (method === 'eth_sendTransaction') return TRANSACTION_HASH
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      deployProtocol(
        {
          request,
          on: (event, listener) => {
            if (event === 'accountsChanged') handleAccountsChanged = listener
          },
          removeListener: (event) => {
            if (event === 'accountsChanged') handleAccountsChanged = undefined
          },
        },
        ACCOUNT,
        1n,
      ),
    ).rejects.toThrow(/account changed/i)
    expect(
      request.mock.calls.some(
        ([request]) => request.method === 'eth_sendTransaction',
      ),
    ).toBe(false)
  })
})
describe('local wallet network', () => {
  it('verifies the wallet against a block fingerprint from loopback Anvil', async () => {
    await expect(
      verifyLocalChain(fingerprintProvider(), fingerprintProvider()),
    ).resolves.toBeUndefined()
  })
  it('rejects a reused chain ID that points at a different RPC', async () => {
    await expect(
      verifyLocalChain(
        fingerprintProvider(OTHER_BLOCK_HASH),
        fingerprintProvider(),
      ),
    ).rejects.toThrow(/does not match Anvil/i)
  })
  it('bounds stalled local fingerprint reads', async () => {
    const stalled = providerFrom(() => new Promise<unknown>(() => undefined))
    await expect(
      verifyLocalChain(fingerprintProvider(), stalled, 5),
    ).rejects.toThrow(/does not match Anvil/i)
  })
  it('rejects oversized block quantities before conversion', async () => {
    const localProvider = providerFrom(async ({ method }) => {
      if (method === 'eth_chainId') return '0x7a69'
      if (method === 'eth_blockNumber') return `0x${'1'.repeat(65)}`
      throw new Error(`Unexpected method: ${method}`)
    })
    await expect(
      verifyLocalChain(fingerprintProvider(), localProvider),
    ).rejects.toThrow(/invalid local block number/i)
  })
  it('adds an unknown Anvil chain and selects it when still required', async () => {
    let firstSwitch = true
    let selected = false
    const request = vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'wallet_switchEthereumChain' && firstSwitch) {
        firstSwitch = false
        throw Object.assign(new Error('Unknown chain'), { code: 4902 })
      }
      if (method === 'wallet_switchEthereumChain') selected = true
      if (method === 'eth_chainId') return selected ? '0x7a69' : '0x1'
      if (method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      return null
    })
    await switchToLocalChain(providerFrom(request), fingerprintProvider())
    expect(request.mock.calls.map(([request]) => request.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'eth_getBlockByNumber',
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
      if (method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      return null
    })
    await switchToLocalChain(providerFrom(request), fingerprintProvider())
    expect(request.mock.calls.map(([request]) => request.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'eth_chainId',
      'eth_getBlockByNumber',
    ])
  })
})
