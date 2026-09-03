import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, padHex, toHex } from 'viem'
import { App } from './app'
import type { Eip1193Provider } from './ethereum'
import { parseMediaCid } from './media-cid'
import {
  FACTORY_ADDRESS,
  LIFEINVADER_INIT_CODE,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
  publishPost,
  type TransactionReceipt,
} from './protocol'
import { WalletPanel } from './wallet-panel'
import { resetWalletDiscoveryForTests } from './wallet-providers'
import type { WalletSessionController } from './wallet-session'
const FACTORY_RUNTIME_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
const PROTOCOL_RUNTIME_CODE = `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}`
const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REVERTED_TRANSACTION_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const UNKNOWN_TRANSACTION_HASH =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
const RECEIPT_BLOCK_HASH = `0x${'dd'.repeat(32)}`
const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const MEDIA_CID_V0 = 'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C'
const MEDIA_CID = parseMediaCid(MEDIA_CID_V0)!
const synchronizeEmptyFeed = vi.fn(async () => ({
  cacheReset: false,
  caughtUp: true,
  head: 0n,
  posts: [],
  safeHead: 0n,
  scannedRanges: 0,
}))
const waitForSafePost = vi.fn(async () => undefined)
function renderApp() {
  return render(
    <App
      synchronizePostFeed={synchronizeEmptyFeed}
      waitForPostConfirmation={waitForSafePost}
    />,
  )
}
function announceWallet(name: string, uuid: string, provider: unknown) {
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: { info: { name, uuid }, provider },
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
  return () => window.removeEventListener('eip6963:requestProvider', announce)
}
function buttonDisabled(name: RegExp) {
  return screen.getByRole('button', { name }).hasAttribute('disabled')
}
function deferred<T>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next, fail) => {
    reject = fail
    resolve = next
  })
  return { promise, reject, resolve }
}
afterEach(() => {
  cleanup()
  resetWalletDiscoveryForTests()
  synchronizeEmptyFeed.mockClear()
  waitForSafePost.mockClear()
  vi.unstubAllGlobals()
})
describe('App', () => {
  it('states the deliberately public product boundary', () => {
    renderApp()
    expect(
      screen.getByRole('heading', { name: /privacy was a bug/i }),
    ).toBeTruthy()
    expect(screen.getByText(/no delete button/i)).toBeTruthy()
    expect(screen.getByText(/unofficial parody project/i)).toBeTruthy()
  })
  it('offers an honest wallet entry point without claiming a wallet exists', () => {
    renderApp()
    expect(
      screen.getByRole('link', {
        name: /invade with your wallet/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/no injected wallet found/i)).toBeTruthy()
    expect(screen.getByText(/there are no private actions/i)).toBeTruthy()
  })
  it('refreshes after concurrent deployment and rejected post preflights', async () => {
    let protocolChecks = 0
    const provider = {
      request: vi.fn(
        async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_requestAccounts') return [ACCOUNT]
          if (method === 'eth_accounts') return [ACCOUNT]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getCode') {
            const [address] = params as [string]
            expect([PROTOCOL_ADDRESS, FACTORY_ADDRESS]).toContain(address)
            if (address === FACTORY_ADDRESS) return FACTORY_RUNTIME_CODE
            protocolChecks += 1
            return protocolChecks === 1 || protocolChecks >= 4
              ? '0x'
              : PROTOCOL_RUNTIME_CODE
          }
          throw new Error(`Unexpected method: ${method}`)
        },
      ),
    }
    const stop = announceWallet('Test Wallet', 'test-wallet', provider)
    renderApp()
    fireEvent.click(
      await screen.findByRole('button', { name: /connect test wallet/i }),
    )
    expect(await screen.findByText('1')).toBeTruthy()
    fireEvent.click(
      await screen.findByRole('button', { name: /deploy protocol here/i }),
    )
    expect(
      await screen.findByText(/verified Lifeinvader v1 code is ready/i),
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/permanent public statement/i), {
      target: { value: 'About to be reorged.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect(
      await screen.findByRole('button', { name: /deploy protocol here/i }),
    ).toBeTruthy()
    expect(screen.queryByLabelText(/permanent public statement/i)).toBeNull()
    stop()
  })
  it('does not trust a reused local chain ID at a different head', async () => {
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
        if (method === 'eth_requestAccounts') return [ACCOUNT]
        if (method === 'eth_accounts') return [ACCOUNT]
        if (method === 'eth_chainId') return '0x7a69'
        if (method === 'eth_blockNumber') return '0x2b'
        throw new Error(`Unexpected method: ${method}`)
      }),
    }
    const stop = announceWallet('Other Local Wallet', 'other', provider)
    renderApp()
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
    stop()
  })
  it('refreshes the feed only after a post receipt is confirmed', async () => {
    const body = 'The feed should remember this.'
    const provider = {
      request: vi.fn(
        async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_requestAccounts') return [ACCOUNT]
          if (method === 'eth_accounts') return [ACCOUNT]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
          if (method === 'eth_sendTransaction') return TRANSACTION_HASH
          if (method === 'eth_getTransactionReceipt') {
            return {
              blockHash: RECEIPT_BLOCK_HASH,
              blockNumber: '0x2a',
              logs: [
                {
                  address: PROTOCOL_ADDRESS,
                  blockHash: RECEIPT_BLOCK_HASH,
                  blockNumber: '0x2a',
                  data: encodeAbiParameters(
                    [{ type: 'string' }, { type: 'bytes' }],
                    [body, MEDIA_CID.bytes],
                  ),
                  topics: [
                    POST_PUBLISHED_TOPIC,
                    padHex(toHex(1n), { size: 32 }),
                    padHex(ACCOUNT, { size: 32 }),
                  ],
                  transactionHash: TRANSACTION_HASH,
                },
              ],
              status: '0x1',
              transactionHash: TRANSACTION_HASH,
            }
          }
          if (method === 'eth_getBlockByNumber') {
            return {
              hash: RECEIPT_BLOCK_HASH,
              number: (params as [string])[0],
            }
          }
          throw new Error(`Unexpected method: ${method}`)
        },
      ),
    }
    const stop = announceWallet('Publishing Wallet', 'publishing', provider)
    renderApp()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /connect publishing wallet/i,
      }),
    )
    const textarea = await screen.findByLabelText(/permanent public statement/i)
    expect(synchronizeEmptyFeed).toHaveBeenCalledTimes(1)
    fireEvent.change(textarea, { target: { value: body } })
    const mediaInput = screen.getByLabelText(/IPFS media CID/i)
    fireEvent.change(mediaInput, { target: { value: 'not-a-cid' } })
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    expect(screen.getByText(/invalid media CID/i)).toBeTruthy()
    fireEvent.change(mediaInput, { target: { value: MEDIA_CID_V0 } })
    expect(screen.getByText(/canonical CIDv1 bytes/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))

    expect(await screen.findByText(/included in block 42/i)).toBeTruthy()
    expect((textarea as HTMLTextAreaElement).value).toBe('')
    expect((mediaInput as HTMLInputElement).value).toBe('')
    expect(waitForSafePost).toHaveBeenCalledWith(
      provider,
      1n,
      expect.objectContaining({
        blockHash: RECEIPT_BLOCK_HASH,
        blockNumber: 42n,
        expectedPost: { author: ACCOUNT, body, mediaCid: MEDIA_CID.bytes },
        hash: TRANSACTION_HASH,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(synchronizeEmptyFeed).toHaveBeenCalledTimes(2)
    stop()
  })
  it('locks posting when a wallet may broadcast without returning a hash', async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [ACCOUNT]
        if (method === 'eth_accounts') return [ACCOUNT]
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_sendTransaction') {
          throw new Error('Provider response timed out.')
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }
    const stop = announceWallet('Ambiguous Wallet', 'ambiguous', provider)
    renderApp()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /connect ambiguous wallet/i,
      }),
    )
    const textarea = await screen.findByLabelText(/permanent public statement/i)
    fireEvent.change(textarea, { target: { value: 'Did this publish?' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))

    const acknowledge = await screen.findByRole('button', {
      name: /i checked my wallet/i,
    })
    expect(screen.getByText(/may have broadcast/i)).toBeTruthy()
    expect(acknowledge.closest('.transaction-pending')?.textContent).toMatch(
      /chain 1.*Ambiguous Wallet/i,
    )
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    expect((textarea as HTMLTextAreaElement).value).toBe('Did this publish?')

    fireEvent.click(acknowledge)
    expect(buttonDisabled(/publish on-chain/i)).toBe(false)
    stop()
  })
  it('scopes concurrent busy writes to their original wallet context', async () => {
    let chainId = '0x1'
    let submissions = 0
    const firstSubmission = deferred<string>()
    const secondSubmission = deferred<string>()
    const listeners = new Map<string, Set<(value: unknown) => void>>()
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [ACCOUNT]
        if (method === 'eth_accounts') return [ACCOUNT]
        if (method === 'eth_chainId') return chainId
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_sendTransaction') {
          submissions += 1
          return submissions === 1
            ? firstSubmission.promise
            : secondSubmission.promise
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        const registered = listeners.get(event) ?? new Set()
        registered.add(listener)
        listeners.set(event, registered)
      }),
      removeListener: vi.fn(
        (event: string, listener: (value: unknown) => void) => {
          listeners.get(event)?.delete(listener)
        },
      ),
    }
    const emitChain = (value: string) => {
      chainId = value
      listeners.get('chainChanged')?.forEach((listener) => listener(value))
    }
    const rejection = Object.assign(new Error('User rejected.'), { code: 4001 })
    const stop = announceWallet('Busy Wallet', 'busy-context', provider)
    renderApp()
    fireEvent.click(
      await screen.findByRole('button', { name: /connect busy wallet/i }),
    )
    const textarea = await screen.findByLabelText(/permanent public statement/i)
    fireEvent.change(textarea, { target: { value: 'Waiting on chain A.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    await waitFor(() => expect(submissions).toBe(1))

    await act(async () => emitChain('0x2'))
    const chainBPublish = await screen.findByRole('button', {
      name: /publish on-chain/i,
    })
    expect(chainBPublish.hasAttribute('disabled')).toBe(false)
    fireEvent.change(textarea, { target: { value: 'Waiting on chain B.' } })
    fireEvent.click(chainBPublish)
    await waitFor(() => expect(submissions).toBe(2))
    expect(buttonDisabled(/publishing/i)).toBe(true)

    await act(async () => {
      firstSubmission.reject(rejection)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(buttonDisabled(/publishing/i)).toBe(true)

    await act(async () => {
      secondSubmission.reject(rejection)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      await screen.findByRole('button', { name: /publish on-chain/i }),
    ).toBeTruthy()
    stop()
  })
  it('does not let a stale post completion clear the current draft', async () => {
    let selectedChain = '0x1'
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return selectedChain
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        throw new Error(`Unexpected method: ${method}`)
      }),
    } as Eip1193Provider
    const controller = (chainId: bigint): WalletSessionController => ({
      connect: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      session: {
        account: ACCOUNT,
        chainId,
        name: 'Completion Wallet',
        provider,
        status: 'connected',
      },
    })
    const completion = deferred<TransactionReceipt>()
    const publishPostAction = vi.fn<typeof publishPost>(
      async () => completion.promise,
    )
    const onPostConfirmed = vi.fn()
    const { rerender } = render(
      <WalletPanel
        onPostConfirmed={onPostConfirmed}
        publishPostAction={publishPostAction}
        walletSession={controller(1n)}
      />,
    )
    const textarea = await screen.findByLabelText(/permanent public statement/i)
    fireEvent.change(textarea, { target: { value: 'Submitted on chain A.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    await waitFor(() => expect(publishPostAction).toHaveBeenCalledTimes(1))

    selectedChain = '0x2'
    rerender(
      <WalletPanel
        onPostConfirmed={onPostConfirmed}
        publishPostAction={publishPostAction}
        walletSession={controller(2n)}
      />,
    )
    await screen.findByText(/verified Lifeinvader v1 code is ready/i)
    fireEvent.change(textarea, { target: { value: 'Unsent chain B draft.' } })
    const mediaInput = screen.getByLabelText(/IPFS media CID/i)
    fireEvent.change(mediaInput, { target: { value: MEDIA_CID_V0 } })

    await act(async () =>
      completion.resolve({
        blockHash: RECEIPT_BLOCK_HASH as TransactionReceipt['blockHash'],
        blockNumber: 42n,
        hash: TRANSACTION_HASH,
      }),
    )

    expect(onPostConfirmed).not.toHaveBeenCalled()
    expect((textarea as HTMLTextAreaElement).value).toBe(
      'Unsent chain B draft.',
    )
    expect((mediaInput as HTMLInputElement).value).toBe(MEDIA_CID_V0)
    expect(screen.queryByText(/included in block 42/i)).toBeNull()

    selectedChain = '0x1'
    rerender(
      <WalletPanel
        onPostConfirmed={onPostConfirmed}
        publishPostAction={publishPostAction}
        walletSession={controller(1n)}
      />,
    )
    expect(await screen.findByText(/included in block 42/i)).toBeTruthy()
  })
  it('preserves an unknown post while another chain starts a write', async () => {
    let chainId = '0x1'
    let submissions = 0
    const listeners = new Map<string, Set<(value: unknown) => void>>()
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [ACCOUNT]
        if (method === 'eth_accounts') return [ACCOUNT]
        if (method === 'eth_chainId') return chainId
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_sendTransaction') {
          submissions += 1
          if (submissions === 1) return UNKNOWN_TRANSACTION_HASH
          throw Object.assign(new Error('User rejected.'), { code: 4001 })
        }
        if (method === 'eth_getTransactionReceipt') {
          throw new Error('Temporary receipt outage.')
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
      on: vi.fn((event: string, listener: (value: unknown) => void) => {
        const registered = listeners.get(event) ?? new Set()
        registered.add(listener)
        listeners.set(event, registered)
      }),
      removeListener: vi.fn(
        (event: string, listener: (value: unknown) => void) => {
          listeners.get(event)?.delete(listener)
        },
      ),
    }
    const emitChain = (value: string) => {
      chainId = value
      listeners.get('chainChanged')?.forEach((listener) => listener(value))
    }
    const stop = announceWallet('Context Wallet', 'context', provider)
    renderApp()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /connect context wallet/i,
      }),
    )
    const textarea = await screen.findByLabelText(/permanent public statement/i)
    fireEvent.change(textarea, { target: { value: 'Uncertain on chain A.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))

    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()
    expect(screen.getByTitle(UNKNOWN_TRANSACTION_HASH)).toBeTruthy()
    await act(async () => emitChain('0x2'))
    expect(
      await screen.findByText(/another wallet context.*current console/i),
    ).toBeTruthy()
    expect(buttonDisabled(/publish on-chain/i)).toBe(false)

    fireEvent.change(textarea, { target: { value: 'Rejected on chain B.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /request was rejected/i,
    )

    await act(async () => emitChain('0x1'))
    expect(
      await screen.findByRole('button', { name: /check receipt again/i }),
    ).toBeTruthy()
    expect(screen.getByTitle(UNKNOWN_TRANSACTION_HASH)).toBeTruthy()
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    stop()
  })
  it('keeps a submitted hash pending and preserves its receipt if refresh fails', async () => {
    let deployed = false
    let failNextInspection = false
    let transactionNumber = 0
    let unknownReceiptAttempts = 0
    let resolveReceipt: ((value: unknown) => void) | undefined
    let resolvePostSubmission: ((value: string) => void) | undefined
    const receiptResponse = new Promise<unknown>((resolve) => {
      resolveReceipt = resolve
    })
    const postSubmission = new Promise<string>((resolve) => {
      resolvePostSubmission = resolve
    })
    const provider = {
      request: vi.fn(
        async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_requestAccounts') return [ACCOUNT]
          if (method === 'eth_accounts') return [ACCOUNT]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getCode') {
            const [address, blockTag] = params as [string, string]
            if (failNextInspection && blockTag === 'latest') {
              failNextInspection = false
              throw new Error('Temporary RPC outage.')
            }
            if (address === PROTOCOL_ADDRESS) {
              return deployed ? PROTOCOL_RUNTIME_CODE : '0x'
            }
            if (address === FACTORY_ADDRESS) return FACTORY_RUNTIME_CODE
          }
          if (method === 'eth_sendTransaction') {
            transactionNumber += 1
            const hash = [
              TRANSACTION_HASH,
              REVERTED_TRANSACTION_HASH,
              UNKNOWN_TRANSACTION_HASH,
            ][transactionNumber - 1]
            return transactionNumber === 2 ? postSubmission : hash
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
                blockHash: RECEIPT_BLOCK_HASH,
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
              blockHash: RECEIPT_BLOCK_HASH,
              blockNumber: '0x2c',
              logs: [],
              status: '0x1',
              transactionHash: UNKNOWN_TRANSACTION_HASH,
            }
          }
          if (method === 'eth_getBlockByNumber') {
            const [number] = params as [string]
            return { hash: RECEIPT_BLOCK_HASH, number }
          }
          throw new Error(`Unexpected method: ${method}`)
        },
      ),
    }
    const stop = announceWallet('Pending Wallet', 'pending', provider)
    renderApp()
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
    expect(buttonDisabled(/deploying/i)).toBe(true)
    await act(async () => {
      resolveReceipt?.({
        blockHash: RECEIPT_BLOCK_HASH,
        blockNumber: '0x2a',
        status: '0x1',
        transactionHash: TRANSACTION_HASH,
      })
    })
    expect(await screen.findByText(/included in block 42/i)).toBeTruthy()
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
    expect(textarea.hasAttribute('disabled')).toBe(true)
    await act(async () => resolvePostSubmission?.(REVERTED_TRANSACTION_HASH))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /reverted on-chain/i,
    )
    expect(screen.getByTitle(REVERTED_TRANSACTION_HASH)).toBeTruthy()
    expect(buttonDisabled(/publish on-chain/i)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()
    expect(screen.getByTitle(UNKNOWN_TRANSACTION_HASH)).toBeTruthy()
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    expect(buttonDisabled(/connect pending wallet/i)).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: /check receipt again/i }),
    )
    expect(
      await screen.findByText(/did not contain the expected post event/i),
    ).toBeTruthy()
    expect(screen.getByText(/final status is unknown/i)).toBeTruthy()
    expect((textarea as HTMLTextAreaElement).value).toBe('Try, try again.')
    stop()
  })
})
