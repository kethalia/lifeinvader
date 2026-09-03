import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from './app'
import { PROTOCOL_ADDRESS } from './protocol'
import { resetWalletDiscoveryForTests } from './wallet-providers'

afterEach(() => {
  cleanup()
  resetWalletDiscoveryForTests()
})

describe('App', () => {
  it('states the deliberately public product boundary', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: /privacy was a bug/i }),
    ).toBeTruthy()
    expect(screen.getByText(/no delete button/i)).toBeTruthy()
    expect(screen.getByText(/unofficial parody project/i)).toBeTruthy()
  })

  it('offers an honest wallet entry point without claiming a wallet exists', () => {
    render(<App />)

    expect(
      screen.getByRole('link', {
        name: /invade with your wallet/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/no injected wallet found/i)).toBeTruthy()
    expect(screen.getByText(/there are no private actions/i)).toBeTruthy()
  })

  it('discovers an EIP-6963 wallet and inspects its selected chain', async () => {
    const provider = {
      request: vi.fn(
        async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_requestAccounts') {
            return ['0x000000000000000000000000000000000000a11c']
          }
          if (method === 'eth_chainId') return '0x7a69'
          if (method === 'eth_getCode') {
            const [address] = params as [string]
            expect(address).toBe(PROTOCOL_ADDRESS)
            return '0x'
          }
          throw new Error(`Unexpected method: ${method}`)
        },
      ),
    }
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { name: 'Test Wallet', uuid: 'test-wallet' },
            provider,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announce)

    render(<App />)

    const walletButton = await screen.findByRole('button', {
      name: /connect test wallet/i,
    })
    fireEvent.click(walletButton)

    expect(await screen.findByText('31337')).toBeTruthy()
    await waitFor(() => {
      expect(provider.request).toHaveBeenCalledWith({
        method: 'eth_getCode',
        params: [PROTOCOL_ADDRESS, 'latest'],
      })
    })

    window.removeEventListener('eip6963:requestProvider', announce)
  })
})
