import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider } from './ethereum'
import type { HttpRpcProvider } from './http-rpc'
import {
  ReadRpcPanel,
  useReadRpcSelection,
  type ReadRpcSelectionOptions,
} from './read-rpc-panel'
import type { ReadRpcVerification } from './read-rpc'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const

function walletSession(provider: Eip1193Provider, chainId = 1n): WalletSession {
  return {
    account: ACCOUNT,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function candidate(
  origin: string,
  url = `${origin}/private-key`,
): HttpRpcProvider {
  return Object.freeze({
    close: vi.fn(),
    endpoint: Object.freeze({ origin, url }),
    request: vi.fn(),
    requestWithSignal: vi.fn(),
  })
}

function verification(
  endpointOrigin = 'https://rpc.example',
  chainId = 1n,
): ReadRpcVerification {
  return Object.freeze({
    blockHash: BLOCK_HASH,
    blockNumber: 88n,
    chainId,
    endpointOrigin,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function Harness({
  options,
  session,
}: {
  options?: ReadRpcSelectionOptions
  session: WalletSession
}) {
  const controller = useReadRpcSelection(session, options)
  return <ReadRpcPanel controller={controller} session={session} />
}

afterEach(cleanup)

describe('read RPC selector', () => {
  it('requires a connected wallet and performs no endpoint work by default', () => {
    const createProvider = vi.fn()
    render(
      <Harness
        options={{ createProvider }}
        session={{ status: 'disconnected' }}
      />,
    )

    expect(screen.getByText(/connect a wallet before selecting/i)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /verify and use RPC/i }),
    ).toHaveProperty('disabled', true)
    expect(createProvider).not.toHaveBeenCalled()
  })

  it('keeps the endpoint in memory and displays only its origin after verification', async () => {
    const wallet = { request: vi.fn() }
    const endpoint = candidate(
      'https://rpc.example',
      'https://rpc.example/account/private-key',
    )
    const createProvider = vi.fn(() => endpoint)
    const verify = vi.fn(async () => verification())
    render(
      <Harness
        options={{ createProvider, verify }}
        session={walletSession(wallet)}
      />,
    )
    const input = screen.getByLabelText(/HTTPS JSON-RPC endpoint/i)

    fireEvent.change(input, {
      target: { value: 'https://rpc.example/account/private-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: /verify and use RPC/i }))

    expect(
      await screen.findByText(
        /matched to wallet history at confirmed block 88/i,
      ),
    ).toBeTruthy()
    expect(createProvider).toHaveBeenCalledWith(
      'https://rpc.example/account/private-key',
    )
    expect(verify).toHaveBeenCalledWith(wallet, 1n, endpoint, {
      signal: expect.any(AbortSignal),
    })
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(/private-key/i)).toBeNull()
    expect(endpoint.close).not.toHaveBeenCalled()
  })

  it('closes a rejected candidate and preserves the entered draft for correction', async () => {
    const endpoint = candidate('https://wrong.example')
    const verify = vi.fn(async () => {
      throw new Error('Cannot use read RPC: endpoint chain does not match.')
    })
    render(
      <Harness
        options={{ createProvider: () => endpoint, verify }}
        session={walletSession({ request: vi.fn() })}
      />,
    )
    const input = screen.getByLabelText(/HTTPS JSON-RPC endpoint/i)
    fireEvent.change(input, {
      target: { value: 'https://wrong.example/key' },
    })
    fireEvent.click(screen.getByRole('button', { name: /verify and use RPC/i }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Cannot use read RPC: endpoint chain does not match.',
    )
    expect((input as HTMLInputElement).value).toBe('https://wrong.example/key')
    expect(endpoint.close).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /use wallet RPC/i })).toBeNull()
  })

  it('atomically replaces and closes selected transports', async () => {
    const first = candidate('https://first.example')
    const second = candidate('https://second.example')
    const createProvider = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const verify = vi
      .fn()
      .mockResolvedValueOnce(verification('https://first.example'))
      .mockResolvedValueOnce(verification('https://second.example'))
    render(
      <Harness
        options={{ createProvider, verify }}
        session={walletSession({ request: vi.fn() })}
      />,
    )
    const input = screen.getByLabelText(/HTTPS JSON-RPC endpoint/i)

    fireEvent.change(input, { target: { value: first.endpoint.url } })
    fireEvent.click(screen.getByRole('button', { name: /verify and use RPC/i }))
    expect(await screen.findByText('https://first.example')).toBeTruthy()

    fireEvent.change(input, { target: { value: second.endpoint.url } })
    fireEvent.click(screen.getByRole('button', { name: /verify and use RPC/i }))
    expect(await screen.findByText('https://second.example')).toBeTruthy()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /use wallet RPC/i }))
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/currently use the wallet’s RPC/i)).toBeTruthy()
  })

  it('cancels and closes a stale verification when wallet context changes', async () => {
    const firstWallet = { request: vi.fn() }
    const secondWallet = { request: vi.fn() }
    const endpoint = candidate('https://rpc.example')
    const pending = deferred<ReadRpcVerification>()
    let verificationSignal: AbortSignal | undefined
    const verify = vi.fn(
      async (
        _wallet: Eip1193Provider,
        _chainId: bigint,
        _endpoint: HttpRpcProvider,
        options = {},
      ) => {
        verificationSignal = options.signal
        return pending.promise
      },
    )
    const view = render(
      <Harness
        options={{ createProvider: () => endpoint, verify }}
        session={walletSession(firstWallet)}
      />,
    )
    fireEvent.change(screen.getByLabelText(/HTTPS JSON-RPC endpoint/i), {
      target: { value: endpoint.endpoint.url },
    })
    fireEvent.click(screen.getByRole('button', { name: /verify and use RPC/i }))
    expect(
      await screen.findByRole('button', { name: /verifying RPC/i }),
    ).toBeTruthy()

    view.rerender(
      <Harness
        options={{ createProvider: () => endpoint, verify }}
        session={walletSession(secondWallet, 2n)}
      />,
    )
    await waitFor(() => expect(verificationSignal?.aborted).toBe(true))
    expect(endpoint.close).toHaveBeenCalledTimes(1)
    pending.resolve(verification('https://rpc.example', 1n))

    await waitFor(() => {
      expect(screen.queryByText(/matched to wallet history/i)).toBeNull()
    })
    expect(
      (screen.getByLabelText(/HTTPS JSON-RPC endpoint/i) as HTMLInputElement)
        .value,
    ).toBe('')
    expect(endpoint.close).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/currently use the wallet’s RPC/i)).toBeTruthy()
  })
})
