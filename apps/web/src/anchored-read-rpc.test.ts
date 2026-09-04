import { describe, expect, it, vi } from 'vitest'
import { createAnchoredReadRpcProvider } from './anchored-read-rpc'
import type { ProviderRequest } from './ethereum'
import type { HttpRpcProvider } from './http-rpc'
import type { ReadRpcVerification } from './read-rpc'

const ANCHOR_HASH = `0x${'ab'.repeat(32)}` as const
const REPLACEMENT_HASH = `0x${'cd'.repeat(32)}` as const
const SAMPLED_HASH = `0x${'ef'.repeat(32)}` as const

function block(number: string, hash: string = ANCHOR_HASH) {
  return { hash, number }
}

function wallet(
  handle: (request: ProviderRequest) => unknown | Promise<unknown>,
) {
  return {
    on: vi.fn<
      (event: string, listener: (...args: unknown[]) => void) => void
    >(),
    removeListener:
      vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
    request: vi.fn(async (request: ProviderRequest) => handle(request)),
  }
}

function endpoint(
  handle: (request: ProviderRequest) => unknown | Promise<unknown>,
  requestWithSignal?: HttpRpcProvider['requestWithSignal'],
): HttpRpcProvider {
  return Object.freeze({
    close: vi.fn(),
    endpoint: Object.freeze({
      origin: 'https://rpc.example',
      url: 'https://rpc.example/account/private-key',
    }),
    request: vi.fn(async (request: ProviderRequest) => handle(request)),
    ...(requestWithSignal ? { requestWithSignal } : {}),
  })
}

function verified(): ReadRpcVerification {
  return Object.freeze({
    blockHash: ANCHOR_HASH,
    blockNumber: 88n,
    chainId: 1n,
    endpointOrigin: 'https://rpc.example',
  })
}

function anchorResponse(request: ProviderRequest, hash: string = ANCHOR_HASH) {
  if (request.method === 'eth_chainId') return '0x1'
  if (request.method === 'eth_getBlockByNumber') return block('0x58', hash)
  throw new Error(`Unexpected RPC method: ${request.method}`)
}

describe('wallet-anchored read RPC', () => {
  it('revalidates the immutable wallet checkpoint on every chain check', async () => {
    let currentHash: string = ANCHOR_HASH
    const walletProvider = wallet((request) =>
      anchorResponse(request, currentHash),
    )
    const endpointProvider = endpoint((request) =>
      anchorResponse(request, currentHash),
    )
    const provider = createAnchoredReadRpcProvider(
      walletProvider,
      endpointProvider,
      verified(),
    )

    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe(
      '0x1',
    )
    expect(walletProvider.request).toHaveBeenCalledWith({
      method: 'eth_getBlockByNumber',
      params: ['0x58', false],
    })
    expect(endpointProvider.request).toHaveBeenCalledWith({
      method: 'eth_getBlockByNumber',
      params: ['0x58', false],
    })

    // Even if both providers now agree with one another, a deep replacement
    // of the checkpoint selected by the user requires explicit reverification.
    currentHash = REPLACEMENT_HASH
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /verified history anchor at block 88 changed/i,
    )
  })

  it('uses the lower head and cross-checks every sampled block', async () => {
    let endpointHash: string = SAMPLED_HASH
    const walletProvider = wallet(({ method, params }) => {
      if (method === 'eth_blockNumber') return '0x64'
      if (method === 'eth_getBlockByNumber') {
        return block((params as readonly unknown[])[0] as string, SAMPLED_HASH)
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    const endpointProvider = endpoint(({ method, params }) => {
      if (method === 'eth_blockNumber') return '0x70'
      if (method === 'eth_getBlockByNumber') {
        return block((params as readonly unknown[])[0] as string, endpointHash)
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })
    const provider = createAnchoredReadRpcProvider(
      walletProvider,
      endpointProvider,
      verified(),
    )

    await expect(provider.request({ method: 'eth_blockNumber' })).resolves.toBe(
      '0x64',
    )
    await expect(
      provider.request({
        method: 'eth_getBlockByNumber',
        params: ['0x60', false],
      }),
    ).resolves.toEqual(block('0x60', SAMPLED_HASH))

    endpointHash = REPLACEMENT_HASH
    await expect(
      provider.request({
        method: 'eth_getBlockByNumber',
        params: ['0x60', false],
      }),
    ).rejects.toThrow(/does not match wallet history at block 96/i)
  })

  it('keeps bulk reads on the endpoint and receipt identity on the wallet', async () => {
    const receipt = { transactionHash: `0x${'12'.repeat(32)}` }
    const logs = [{ data: '0x', topics: [] }]
    const walletProvider = wallet(({ method }) => {
      if (method === 'eth_getTransactionReceipt') return receipt
      throw new Error(`Unexpected wallet RPC method: ${method}`)
    })
    const endpointProvider = endpoint(({ method }) => {
      if (method === 'eth_getLogs') return logs
      throw new Error(`Unexpected endpoint RPC method: ${method}`)
    })
    const provider = createAnchoredReadRpcProvider(
      walletProvider,
      endpointProvider,
      verified(),
    )

    await expect(
      provider.request({ method: 'eth_getLogs', params: [{}] }),
    ).resolves.toBe(logs)
    await expect(
      provider.request({
        method: 'eth_getTransactionReceipt',
        params: [receipt.transactionHash],
      }),
    ).resolves.toBe(receipt)
    expect(endpointProvider.request).toHaveBeenCalledTimes(1)
    expect(walletProvider.request).toHaveBeenCalledTimes(1)
  })

  it('forwards cancellation, wallet context events, and close ownership', async () => {
    const controller = new AbortController()
    const listener = vi.fn()
    const walletProvider = wallet(() => {
      throw new Error('Wallet should not receive this bulk read.')
    })
    const requestWithSignal = vi.fn(
      async (_request: ProviderRequest, signal: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        return []
      },
    )
    const endpointProvider = endpoint(() => {
      throw new Error('Signal-aware request expected.')
    }, requestWithSignal)
    const provider = createAnchoredReadRpcProvider(
      walletProvider,
      endpointProvider,
      verified(),
    )

    provider.on?.('chainChanged', listener)
    await expect(
      provider.requestWithSignal?.(
        { method: 'eth_getLogs', params: [{}] },
        controller.signal,
      ),
    ).resolves.toEqual([])
    provider.removeListener?.('chainChanged', listener)
    provider.close()
    provider.close()

    expect(walletProvider.on).toHaveBeenCalledWith('chainChanged', listener)
    expect(walletProvider.removeListener).toHaveBeenCalledWith(
      'chainChanged',
      listener,
    )
    expect(requestWithSignal).toHaveBeenCalledTimes(1)
    expect(endpointProvider.close).toHaveBeenCalledTimes(1)
    await expect(provider.request({ method: 'eth_getLogs' })).rejects.toThrow(
      /transport was closed/i,
    )
  })

  it('rejects malformed sampled blocks and mismatched selection metadata', async () => {
    const walletProvider = wallet(() => null)
    const endpointProvider = endpoint(() => null)
    const provider = createAnchoredReadRpcProvider(
      walletProvider,
      endpointProvider,
      verified(),
    )

    await expect(
      provider.request({
        method: 'eth_getBlockByNumber',
        params: ['0x01', false],
      }),
    ).rejects.toThrow(/requested block number is invalid/i)
    expect(() =>
      createAnchoredReadRpcProvider(walletProvider, endpointProvider, {
        ...verified(),
        endpointOrigin: 'https://other.example',
      }),
    ).toThrow(/verified endpoint does not match/i)
  })
})
