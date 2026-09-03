import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from './app'
import {
  FACTORY_ADDRESS,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'
import { resetWalletDiscoveryForTests } from './wallet-providers'

const FACTORY_RUNTIME_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`
const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REVERTED_TRANSACTION_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const UNKNOWN_TRANSACTION_HASH =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'

afterEach(() => {
  cleanup()
  resetWalletDiscoveryForTests()
  vi.unstubAllGlobals()
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
          if (method === 'eth_accounts') {
            return ['0x000000000000000000000000000000000000a11c']
          }
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getCode') {
            const [address] = params as [string]
            expect([PROTOCOL_ADDRESS, FACTORY_ADDRESS]).toContain(address)
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

    expect(await screen.findByText('1')).toBeTruthy()
    await waitFor(() => {
      expect(provider.request).toHaveBeenCalledWith({
        method: 'eth_getCode',
        params: [PROTOCOL_ADDRESS, 'latest'],
      })
      expect(provider.request).toHaveBeenCalledWith({
        method: 'eth_getCode',
        params: [FACTORY_ADDRESS, 'latest'],
      })
    })

    window.removeEventListener('eip6963:requestProvider', announce)
  })

  it('does not trust a reused local chain ID with a different fingerprint', async () => {
    const walletBlockHash = `0x${'aa'.repeat(32)}`
    const localBlockHash = `0x${'bb'.repeat(32)}`
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string }
        const result =
          request.method === 'eth_chainId'
            ? '0x7a69'
            : request.method === 'eth_blockNumber'
              ? '0x2a'
              : { hash: localBlockHash, number: '0x2a' }
        return new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', result }))
      }),
    )

    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') {
          return ['0x000000000000000000000000000000000000a11c']
        }
        if (method === 'eth_chainId') return '0x7a69'
        if (method === 'eth_getBlockByNumber') {
          return { hash: walletBlockHash, number: '0x2a' }
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { name: 'Other Local Wallet', uuid: 'other-local-wallet' },
            provider,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announce)

    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /connect other local wallet/i,
      }),
    )

    expect(await screen.findByText(/does not match Anvil/i)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: /deploy protocol here/i }),
    ).toBeNull()
    expect(screen.queryByLabelText(/permanent public statement/i)).toBeNull()

    window.removeEventListener('eip6963:requestProvider', announce)
  })

  it('keeps a submitted hash pending and preserves its receipt if refresh fails', async () => {
    let deployed = false
    let failNextInspection = false
    let transactionNumber = 0
    let unknownReceiptAttempts = 0
    let resolveReceipt: ((value: unknown) => void) | undefined
    const receiptResponse = new Promise<unknown>((resolve) => {
      resolveReceipt = resolve
    })
    const provider = {
      request: vi.fn(
        async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_requestAccounts') {
            return ['0x000000000000000000000000000000000000a11c']
          }
          if (method === 'eth_accounts') {
            return ['0x000000000000000000000000000000000000a11c']
          }
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getCode') {
            if (failNextInspection) {
              failNextInspection = false
              throw new Error('Temporary RPC outage.')
            }
            const [address] = params as [string]
            if (address === PROTOCOL_ADDRESS) {
              return deployed ? PROTOCOL_RUNTIME_CODE : '0x'
            }
            if (address === FACTORY_ADDRESS) return FACTORY_RUNTIME_CODE
          }
          if (method === 'eth_sendTransaction') {
            transactionNumber += 1
            return [
              TRANSACTION_HASH,
              REVERTED_TRANSACTION_HASH,
              UNKNOWN_TRANSACTION_HASH,
            ][transactionNumber - 1]
          }
          if (method === 'eth_getTransactionReceipt') {
            if (transactionNumber === 1) {
              const result = await receiptResponse
              deployed = true
              failNextInspection = true
              return result
            }
            if (transactionNumber === 2) {
              return {
                blockNumber: '0x2b',
                status: '0x0',
                transactionHash: REVERTED_TRANSACTION_HASH,
              }
            }
            unknownReceiptAttempts += 1
            if (unknownReceiptAttempts === 1) {
              throw new Error('Wallet disconnected.')
            }
            return {
              blockNumber: '0x2c',
              status: '0x1',
              transactionHash: UNKNOWN_TRANSACTION_HASH,
            }
          }
          throw new Error(`Unexpected method: ${method}`)
        },
      ),
    }
    const announce = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { name: 'Pending Wallet', uuid: 'pending-wallet' },
            provider,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announce)

    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /connect pending wallet/i,
      }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: /deploy protocol here/i }),
    )

    expect(await screen.findByText(/deployment submitted/i)).toBeTruthy()
    expect(screen.getByTitle(TRANSACTION_HASH)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /deploying/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    await act(async () => {
      resolveReceipt?.({
        blockNumber: '0x2a',
        status: '0x1',
        transactionHash: TRANSACTION_HASH,
      })
    })

    expect(await screen.findByText(/confirmed in block 42/i)).toBeTruthy()
    const retryButton = await screen.findByRole('button', {
      name: /retry verification/i,
    })
    fireEvent.click(retryButton)
    expect(
      await screen.findByText(/verified Lifeinvader v1 code is ready/i),
    ).toBeTruthy()

    const textarea = screen.getByLabelText(/permanent public statement/i)
    fireEvent.change(textarea, { target: { value: 'Try, try again.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /reverted on-chain/i,
    )
    expect(screen.getByTitle(REVERTED_TRANSACTION_HASH)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /publish on-chain/i })
        .hasAttribute('disabled'),
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()
    expect(screen.getByTitle(UNKNOWN_TRANSACTION_HASH)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /publish on-chain/i })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(
      screen
        .getByRole('button', { name: /connect pending wallet/i })
        .hasAttribute('disabled'),
    ).toBe(false)

    fireEvent.click(
      screen.getByRole('button', { name: /check receipt again/i }),
    )
    expect(await screen.findByText(/confirmed in block 44/i)).toBeTruthy()
    expect((textarea as HTMLTextAreaElement).value).toBe('')

    window.removeEventListener('eip6963:requestProvider', announce)
  })
})
