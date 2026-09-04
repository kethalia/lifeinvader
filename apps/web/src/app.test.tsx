import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import { encodeAbiParameters, padHex, toHex } from 'viem'
import { App } from './app'
import type { DirectMessageStreamSynchronizer } from './direct-message-stream'
import type { Eip1193Provider } from './ethereum'
import type { FollowStreamSynchronizer } from './follow-stream'
import type { GroupDirectorySynchronizer } from './group-directory'
import { parseMediaCid } from './media-cid'
import type { PreparedMediaCar } from './paid-media-car'
import type { PostFeedSynchronizer } from './post-feed'
import type { ProfileStreamSynchronizer } from './profile-stream'
import {
  FACTORY_ADDRESS,
  getDirectConversationId,
  LIFEINVADER_INIT_CODE,
  POST_PUBLISHED_TOPIC,
  PROTOCOL_ADDRESS,
  publishPost,
  type TransactionReceipt,
} from './protocol'
import { WalletPanel } from './wallet-panel'
import { resetWalletDiscoveryForTests } from './wallet-providers'
import type { WalletSessionController } from './wallet-session'
import {
  WalletWriteBoundary,
  useWalletWriteBoundary,
} from './wallet-write-boundary'
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
const MESSAGE_RECIPIENT = '0x0000000000000000000000000000000000000b0b'
const MEDIA_CID_V0 = 'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C'
const MEDIA_CID = parseMediaCid(MEDIA_CID_V0)!
const synchronizeEmptyFeed = vi.fn<PostFeedSynchronizer>(async () => ({
  cacheReset: false,
  caughtUp: true,
  head: 0n,
  posts: [],
  safeHead: 0n,
  scannedRanges: 0,
  startBlock: 0n,
}))
const synchronizeEmptyProfile = vi.fn<ProfileStreamSynchronizer>(async () => ({
  cacheReset: false,
  caughtUp: false,
  head: 100n,
  indexedThrough: 88n,
  recentProfiles: [],
  safeHead: 88n,
  scannedRanges: 1,
  startBlock: 0n,
}))
const synchronizeEmptyMessages = vi.fn<DirectMessageStreamSynchronizer>(
  async (_provider, _chainId, account, recipient) => ({
    cacheReset: false,
    caughtUp: false,
    conversationId: getDirectConversationId(account, recipient),
    head: 100n,
    indexedThrough: 88n,
    recentMessages: [],
    safeHead: 88n,
    scannedRanges: 1,
    startBlock: 0n,
  }),
)
const synchronizeEmptyFollows = vi.fn<FollowStreamSynchronizer>(
  async (_provider, _chainId, account, direction) => ({
    account,
    cacheReset: false,
    caughtUp: false,
    direction,
    head: 100n,
    indexedThrough: 88n,
    recentSignals: [],
    safeHead: 88n,
    scannedRanges: 1,
    startBlock: 0n,
  }),
)
const synchronizeEmptyGroups = vi.fn<GroupDirectorySynchronizer>(async () => ({
  cacheReset: false,
  caughtUp: false,
  groups: [],
  head: 100n,
  historyBoundaryKind: 'confirmed',
  indexedThrough: 88n,
  safeHead: 88n,
  scannedRanges: 1,
  startBlock: 0n,
}))
const waitForSafePost = vi.fn(async () => undefined)
function renderApp() {
  return render(
    <App
      synchronizeDirectMessages={synchronizeEmptyMessages}
      synchronizeFollows={synchronizeEmptyFollows}
      synchronizeGroupDirectory={synchronizeEmptyGroups}
      synchronizePostFeed={synchronizeEmptyFeed}
      synchronizeProfile={synchronizeEmptyProfile}
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
function ActiveWalletWrite() {
  useWalletWriteBoundary('feed', true)
  return null
}
afterEach(() => {
  cleanup()
  resetWalletDiscoveryForTests()
  synchronizeEmptyFeed.mockClear()
  synchronizeEmptyFollows.mockClear()
  synchronizeEmptyGroups.mockClear()
  synchronizeEmptyMessages.mockClear()
  synchronizeEmptyProfile.mockClear()
  waitForSafePost.mockClear()
  vi.unstubAllGlobals()
})
describe('App', () => {
  it('states the deliberately public product boundary', async () => {
    renderApp()
    expect(
      screen.getByRole('heading', { name: /privacy was a bug/i }),
    ).toBeTruthy()
    expect(screen.getByText(/no delete button/i)).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: /^public messages/i }),
    ).toBeTruthy()
    expect(
      await screen.findByRole('heading', {
        name: /public groups\. public membership/i,
      }),
    ).toBeTruthy()
    expect(
      await screen.findByRole('heading', {
        name: /form a circle\. expose the membership list/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/“Direct” only names the recipient/i)).toBeTruthy()
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
  it('keeps wallet reconnection available while another write is unresolved', async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        throw new Error(`Unexpected method: ${method}`)
      }),
    } as Eip1193Provider
    const connect = vi.fn(async () => undefined)
    const stop = announceWallet('Recovery Wallet', 'recovery-wallet', provider)

    render(
      <WalletWriteBoundary>
        <ActiveWalletWrite />
        <WalletPanel
          onPostConfirmed={vi.fn()}
          walletSession={{
            connect,
            refresh: vi.fn(async () => undefined),
            session: {
              account: ACCOUNT,
              chainId: 1n,
              name: 'Recovery Wallet',
              provider,
              status: 'connected',
            },
          }}
        />
      </WalletWriteBoundary>,
    )

    const reconnect = await screen.findByRole('button', {
      name: /connect recovery wallet/i,
    })
    const body = await screen.findByLabelText(/permanent public statement/i)
    fireEvent.change(body, { target: { value: 'Wait for the other receipt.' } })

    expect(reconnect.hasAttribute('disabled')).toBe(false)
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    fireEvent.click(reconnect)
    expect(connect).toHaveBeenCalledTimes(1)
    stop()
  })
  it('routes public history through an in-memory endpoint with wallet fallback', async () => {
    const commonBlockHash = `0x${'ef'.repeat(32)}`
    const endpointUrl = 'https://rpc.example/account/private-key'
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number
          method: string
          params?: [string, boolean]
        }
        const result =
          request.method === 'eth_chainId'
            ? '0x1'
            : request.method === 'eth_blockNumber'
              ? '0x64'
              : {
                  hash: commonBlockHash,
                  number: request.params?.[0],
                }
        return new Response(
          JSON.stringify({ id: request.id, jsonrpc: '2.0', result }),
        )
      },
    )
    vi.stubGlobal('fetch', fetcher)
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [ACCOUNT]
        if (method === 'eth_accounts') return [ACCOUNT]
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
        if (method === 'eth_blockNumber') return '0x64'
        if (method === 'eth_getBlockByNumber') {
          return { hash: commonBlockHash, number: (params as [string])[0] }
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }
    const stop = announceWallet('Test Wallet', 'read-rpc-wallet', provider)
    renderApp()
    fireEvent.click(
      await screen.findByRole('button', { name: /connect test wallet/i }),
    )
    await waitFor(() => expect(synchronizeEmptyFeed).toHaveBeenCalled())
    expect(synchronizeEmptyFeed.mock.calls[0]?.[0]).toBe(provider)

    const input = screen.getByLabelText(/HTTPS JSON-RPC endpoint/i)
    fireEvent.change(input, { target: { value: endpointUrl } })
    fireEvent.click(screen.getByRole('button', { name: /verify and use RPC/i }))

    expect(
      await screen.findByText(
        /matched to wallet history at confirmed block 88/i,
      ),
    ).toBeTruthy()
    await waitFor(() => expect(synchronizeEmptyFeed).toHaveBeenCalledTimes(2))
    const selectedProvider = synchronizeEmptyFeed.mock.calls[1]?.[0]
    expect(selectedProvider).toBeDefined()
    if (!selectedProvider)
      throw new Error('Expected the selected read provider.')
    expect(selectedProvider).not.toBe(provider)
    expect(selectedProvider).toMatchObject({
      endpoint: {
        origin: 'https://rpc.example',
        url: endpointUrl,
      },
    })
    expect((input as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(/private-key/i)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(4)

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed profile/i }),
    )
    await waitFor(() =>
      expect(synchronizeEmptyProfile).toHaveBeenCalledTimes(1),
    )
    expect(synchronizeEmptyProfile.mock.calls[0]?.[0]).toBe(selectedProvider)
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: MESSAGE_RECIPIENT },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )
    await waitFor(() =>
      expect(synchronizeEmptyMessages).toHaveBeenCalledTimes(1),
    )
    expect(synchronizeEmptyMessages.mock.calls[0]?.[0]).toBe(selectedProvider)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /load confirmed follow history/i,
      }),
    )
    await waitFor(() =>
      expect(synchronizeEmptyFollows).toHaveBeenCalledTimes(1),
    )
    expect(synchronizeEmptyFollows.mock.calls[0]?.[0]).toBe(selectedProvider)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /load confirmed public groups/i,
      }),
    )
    await waitFor(() => expect(synchronizeEmptyGroups).toHaveBeenCalledTimes(1))
    expect(synchronizeEmptyGroups.mock.calls[0]?.[0]).toBe(selectedProvider)

    fireEvent.click(screen.getByRole('button', { name: /use wallet RPC/i }))
    await waitFor(() => expect(synchronizeEmptyFeed).toHaveBeenCalledTimes(3))
    expect(synchronizeEmptyFeed.mock.calls[2]?.[0]).toBe(provider)
    fireEvent.click(
      await screen.findByRole('button', { name: /load confirmed profile/i }),
    )
    await waitFor(() =>
      expect(synchronizeEmptyProfile).toHaveBeenCalledTimes(2),
    )
    expect(synchronizeEmptyProfile.mock.calls[1]?.[0]).toBe(provider)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )
    await waitFor(() =>
      expect(synchronizeEmptyMessages).toHaveBeenCalledTimes(2),
    )
    expect(synchronizeEmptyMessages.mock.calls[1]?.[0]).toBe(provider)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /load confirmed follow history/i,
      }),
    )
    await waitFor(() =>
      expect(synchronizeEmptyFollows).toHaveBeenCalledTimes(2),
    )
    expect(synchronizeEmptyFollows.mock.calls[1]?.[0]).toBe(provider)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /load confirmed public groups/i,
      }),
    )
    await waitFor(() => expect(synchronizeEmptyGroups).toHaveBeenCalledTimes(2))
    expect(synchronizeEmptyGroups.mock.calls[1]?.[0]).toBe(provider)
    await expect(
      selectedProvider.request({ method: 'eth_chainId' }),
    ).rejects.toThrow(/transport was closed/i)
    stop()
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
  it('keeps a busy write locked across wallet context changes', async () => {
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
    expect(chainBPublish.hasAttribute('disabled')).toBe(true)
    fireEvent.click(chainBPublish)
    expect(submissions).toBe(1)

    await act(async () => {
      firstSubmission.reject(rejection)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(buttonDisabled(/publish on-chain/i)).toBe(false))

    fireEvent.change(textarea, { target: { value: 'Waiting on chain B.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    await waitFor(() => expect(submissions).toBe(2))
    expect(buttonDisabled(/^publishing…$/i)).toBe(true)

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
  it('prepares local media, locks publishing, and commits its CID', async () => {
    let selectedChain = '0x1'
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return selectedChain
        if (method === 'eth_getCode')
          return selectedChain === '0x1' ? PROTOCOL_RUNTIME_CODE : '0x'
        throw new Error(`Unexpected method: ${method}`)
      }),
    } as Eip1193Provider
    const walletSession = (chainId: bigint): WalletSessionController => ({
      connect: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      session: {
        account: ACCOUNT,
        chainId,
        name: 'Media Wallet',
        provider,
        status: 'connected',
      },
    })
    const preparation = deferred<PreparedMediaCar>()
    let rejectPreparation = false
    const prepareMediaAction = vi.fn(() =>
      rejectPreparation
        ? Promise.reject(new Error('Cannot prepare media: unreadable file.'))
        : preparation.promise,
    )
    const publishPostAction = vi.fn<typeof publishPost>(async () => ({
      blockHash: RECEIPT_BLOCK_HASH as TransactionReceipt['blockHash'],
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    }))
    const onPostConfirmed = vi.fn()
    const { rerender } = render(
      <WalletPanel
        onPostConfirmed={onPostConfirmed}
        prepareMediaAction={prepareMediaAction}
        publishPostAction={publishPostAction}
        walletSession={walletSession(1n)}
      />,
    )

    const textarea = await screen.findByLabelText(/permanent public statement/i)
    fireEvent.change(textarea, { target: { value: 'The receipt is forever.' } })
    const file = new File(['media'], 'proof.gif', { type: 'image/gif' })
    fireEvent.change(screen.getByLabelText(/prepare a local image/i), {
      target: { files: [file] },
    })
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    expect(prepareMediaAction).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const prepared: PreparedMediaCar = {
      carBytes: new Uint8Array(273),
      file: { name: file.name, size: file.size, type: file.type },
      mediaCid: MEDIA_CID,
      rootCid: CID.parse(MEDIA_CID.text),
    }
    await act(async () => preparation.resolve(prepared))

    expect((await screen.findByRole('status')).textContent).toMatch(
      /proof\.gif.*prepared locally/i,
    )
    const mediaInput = screen.getByLabelText(/IPFS media CID/i)
    expect((mediaInput as HTMLInputElement).value).toBe(MEDIA_CID.text)
    expect((mediaInput as HTMLInputElement).readOnly).toBe(true)

    selectedChain = '0x4cb2f'
    rerender(
      <WalletPanel
        onPostConfirmed={onPostConfirmed}
        prepareMediaAction={prepareMediaAction}
        publishPostAction={publishPostAction}
        walletSession={walletSession(314_159n)}
      />,
    )
    await waitFor(() =>
      expect(screen.queryByLabelText(/permanent public statement/i)).toBeNull(),
    )
    expect(
      screen.getByRole('heading', { name: /Filecoin storage rail/i }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    ).toBeTruthy()
    expect(screen.getByText(/return.*publication chain 1/i)).toBeTruthy()

    selectedChain = '0x1'
    rerender(
      <WalletPanel
        onPostConfirmed={onPostConfirmed}
        prepareMediaAction={prepareMediaAction}
        publishPostAction={publishPostAction}
        walletSession={walletSession(1n)}
      />,
    )
    const restoredMediaInput = await screen.findByLabelText(/IPFS media CID/i)
    const restoredTextarea = screen.getByLabelText(
      /permanent public statement/i,
    )
    expect((restoredMediaInput as HTMLInputElement).value).toBe(MEDIA_CID.text)
    expect(screen.getAllByText('proof.gif')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))

    await waitFor(() => expect(publishPostAction).toHaveBeenCalledTimes(1))
    expect(publishPostAction.mock.calls[0]?.[3]).toEqual({
      body: 'The receipt is forever.',
      mediaCid: MEDIA_CID.bytes,
    })
    expect(onPostConfirmed).toHaveBeenCalledTimes(1)
    expect((restoredTextarea as HTMLTextAreaElement).value).toBe('')
    expect((restoredMediaInput as HTMLInputElement).value).toBe('')
    expect(screen.queryByText(/is prepared locally/i)).toBeNull()

    fireEvent.change(restoredTextarea, {
      target: { value: 'Do not publish me yet.' },
    })
    rejectPreparation = true
    fireEvent.change(screen.getByLabelText(/prepare a local image/i), {
      target: { files: [new File(['bad'], 'bad.gif')] },
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /unreadable file/i,
    )
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    expect((restoredMediaInput as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /clear media error/i }))
    expect(buttonDisabled(/publish on-chain/i)).toBe(false)
    expect((restoredMediaInput as HTMLInputElement).disabled).toBe(false)
  })
  it('keeps an unknown post locked across chains until it is dismissed', async () => {
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
      await screen.findByText(
        /another wallet context.*keeps every wallet write locked/i,
      ),
    ).toBeTruthy()
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect(submissions).toBe(1)

    await act(async () => emitChain('0x1'))
    expect(
      await screen.findByRole('button', { name: /check receipt again/i }),
    ).toBeTruthy()
    expect(screen.getByTitle(UNKNOWN_TRANSACTION_HASH)).toBeTruthy()
    expect(buttonDisabled(/publish on-chain/i)).toBe(true)

    fireEvent.click(
      screen.getByRole('button', { name: /i checked this hash/i }),
    )
    await act(async () => emitChain('0x2'))
    await waitFor(() => expect(buttonDisabled(/publish on-chain/i)).toBe(false))
    fireEvent.change(textarea, { target: { value: 'Rejected on chain B.' } })
    fireEvent.click(screen.getByRole('button', { name: /publish on-chain/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /request was rejected/i,
    )
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
    expect(buttonDisabled(/connect pending wallet/i)).toBe(false)
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
