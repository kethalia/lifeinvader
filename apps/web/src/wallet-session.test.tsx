import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Eip1193Provider, ProviderRequest } from './ethereum'
import type { DiscoveredWallet } from './wallet-providers'
import { useWalletSession } from './wallet-session'

afterEach(cleanup)

describe('useWalletSession', () => {
  it('invalidates the connected session after a malformed chain event', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: ProviderRequest) => {
        if (method === 'eth_requestAccounts') {
          return ['0x000000000000000000000000000000000000a11c']
        }
        if (method === 'eth_chainId') return '0x1'
        throw new Error(`Unexpected method: ${method}`)
      }),
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
    }
    const wallet: DiscoveredWallet = {
      id: 'test-wallet',
      name: 'Test Wallet',
      provider,
    }
    const { result } = renderHook(() => useWalletSession())

    await act(async () => result.current.connect(wallet))
    expect(result.current.session).toMatchObject({
      account: '0x000000000000000000000000000000000000a11c',
      chainId: 1n,
      status: 'connected',
    })

    const handleChainChanged = listeners.get('chainChanged')
    expect(handleChainChanged).toBeDefined()
    act(() => handleChainChanged?.('not-a-chain-id'))

    expect(result.current.session).toMatchObject({
      account: undefined,
      chainId: undefined,
      status: 'disconnected',
    })
    expect(result.current.session.error).toMatch(/invalid chain identifier/i)
  })
})
