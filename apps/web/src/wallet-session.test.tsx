import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Eip1193Provider, ProviderRequest } from './ethereum'
import type { DiscoveredWallet } from './wallet-providers'
import { useWalletSession } from './wallet-session'

afterEach(cleanup)

describe('useWalletSession', () => {
  it('commits a current snapshot and rejects malformed chain events', async () => {
    const oldAccount = '0x000000000000000000000000000000000000a11c'
    const newAccount = '0x000000000000000000000000000000000000b0b0'
    let selectedAccount = oldAccount
    let chainReads = 0
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const emit = (event: string, value: unknown) =>
      listeners.get(event)?.forEach((listener) => listener(value))
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }: ProviderRequest) => {
        if (method === 'eth_requestAccounts') return [oldAccount]
        if (method === 'eth_accounts') return [selectedAccount]
        if (method === 'eth_chainId') {
          chainReads += 1
          if (chainReads === 1) {
            selectedAccount = newAccount
            emit('accountsChanged', [newAccount])
          }
          return '0x1'
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
      on: vi.fn((event, listener) => {
        const current = listeners.get(event) ?? new Set()
        current.add(listener)
        listeners.set(event, current)
      }),
      removeListener: vi.fn((event, listener) =>
        listeners.get(event)?.delete(listener),
      ),
    }
    const wallet: DiscoveredWallet = {
      id: 'test-wallet',
      name: 'Test Wallet',
      provider,
    }
    const { result } = renderHook(() => useWalletSession())
    await act(async () => result.current.connect(wallet))
    expect(result.current.session).toMatchObject({
      account: newAccount,
      chainId: 1n,
      status: 'connected',
    })
    act(() => emit('chainChanged', 'not-a-chain-id'))
    expect(result.current.session).toMatchObject({
      account: undefined,
      chainId: undefined,
      status: 'disconnected',
    })
    expect(result.current.session.error).toMatch(/invalid chain identifier/i)

    await act(async () => emit('accountsChanged', [newAccount]))
    expect(result.current.session).toMatchObject({
      account: newAccount,
      chainId: 1n,
      status: 'connected',
    })
  })
})
