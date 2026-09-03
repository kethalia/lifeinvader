import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import type { Eip1193Provider } from './ethereum'
import { parseMediaCid } from './media-cid'
import { PostFeedPanel } from './post-feed-panel'
import type { PostFeedSnapshot } from './post-feed'
import type { PostFeedConfirmationWaiter } from './post-feed-confirmation'
import type { PublishedPost } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const

function post(body: string, postId = 1n, mediaCid: Hex = '0x'): PublishedPost {
  return {
    author: ACCOUNT,
    blockHash: BLOCK_HASH,
    blockNumber: postId + 10n,
    body,
    logIndex: Number(postId),
    mediaCid,
    postId,
    transactionHash: TRANSACTION_HASH,
    transactionIndex: Number(postId),
  }
}

function snapshot(
  posts: readonly PublishedPost[],
  caughtUp = true,
): PostFeedSnapshot {
  return {
    cacheReset: false,
    caughtUp,
    head: 20n,
    indexedThrough: 18n,
    posts,
    safeHead: 18n,
    scannedRanges: 1,
  }
}

function connectedSession(
  provider: Eip1193Provider,
  chainId = 1n,
): WalletSession {
  return {
    account: ACCOUNT,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('PostFeedPanel', () => {
  it('does not select an RPC until a wallet is connected', () => {
    const synchronize = vi.fn()
    render(
      <PostFeedPanel
        session={{ status: 'disconnected' }}
        synchronize={synchronize}
      />,
    )

    expect(screen.getByText(/connect a wallet to read/i)).toBeTruthy()
    expect(screen.getByText(/no hidden feed server/i)).toBeTruthy()
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('renders decoded posts and performs one more range only on request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(snapshot([post('Public forever.')], false))
      .mockResolvedValueOnce(snapshot([post('Public forever.')]))

    render(
      <PostFeedPanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    expect(await screen.findByText('Public forever.')).toBeTruthy()
    expect(screen.getByText(/indexed through block 18/i)).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: /load next block range/i }),
    )
    expect(
      await screen.findByRole('button', { name: /check for newer posts/i }),
    ).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(2)
  })

  it('shows canonical media commitments without trusting malformed bytes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const mediaCid = parseMediaCid(
      'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
    )!
    const synchronize = vi
      .fn()
      .mockResolvedValue(
        snapshot([
          post('', 1n, mediaCid.bytes),
          post('Bad attachment bytes.', 2n, '0x0102'),
        ]),
      )

    render(
      <PostFeedPanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    expect(await screen.findByText(mediaCid.text)).toBeTruthy()
    expect(screen.getByText(/IPFS media commitment · dag-pb/i)).toBeTruthy()
    expect(screen.getByText(/availability is not guaranteed/i)).toBeTruthy()
    expect(screen.getByText(/invalid media CID bytes/i)).toBeTruthy()
    expect(screen.getByText('0x0102')).toBeTruthy()
  })

  it('refreshes automatically only after an included post reaches feed depth', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const confirmation = deferred<void>()
    const waitForConfirmation = vi.fn<PostFeedConfirmationWaiter>(
      () => confirmation.promise,
    )
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot([post('Now safely confirmed.')]))

    render(
      <PostFeedPanel
        includedPost={{
          blockHash: BLOCK_HASH,
          blockNumber: 8n,
          chainId: 1n,
          expectedPost: {
            author: ACCOUNT,
            body: 'Now safely confirmed.',
            mediaCid: '0x',
          },
          hash: TRANSACTION_HASH,
          provider,
        }}
        session={connectedSession(provider)}
        synchronize={synchronize}
        waitForConfirmation={waitForConfirmation}
      />,
    )

    expect(await screen.findByText(/included in block 8/i)).toBeTruthy()
    expect(screen.getByText(/once it is 12 blocks deep/i)).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(1)
    await act(async () => confirmation.resolve())
    expect(await screen.findByText('Now safely confirmed.')).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(2)
  })

  it('aborts stale chain work and ignores its result', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const first = deferred<PostFeedSnapshot>()
    const second = deferred<PostFeedSnapshot>()
    const pendingConfirmation = deferred<void>()
    const waitForConfirmation = vi.fn<PostFeedConfirmationWaiter>(
      () => pendingConfirmation.promise,
    )
    const synchronize = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { rerender } = render(
      <PostFeedPanel
        includedPost={{
          blockHash: BLOCK_HASH,
          blockNumber: 8n,
          chainId: 1n,
          expectedPost: {
            author: ACCOUNT,
            body: 'Pending post.',
            mediaCid: '0x',
          },
          hash: TRANSACTION_HASH,
          provider,
        }}
        session={connectedSession(provider)}
        synchronize={synchronize}
        waitForConfirmation={waitForConfirmation}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]?.[2]?.signal
    const confirmationSignal = waitForConfirmation.mock.calls[0]?.[3]?.signal

    rerender(
      <PostFeedPanel
        includedPost={{
          blockHash: BLOCK_HASH,
          blockNumber: 8n,
          chainId: 1n,
          expectedPost: {
            author: ACCOUNT,
            body: 'Pending post.',
            mediaCid: '0x',
          },
          hash: TRANSACTION_HASH,
          provider,
        }}
        session={connectedSession(provider, 2n)}
        synchronize={synchronize}
        waitForConfirmation={waitForConfirmation}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)
    expect(confirmationSignal?.aborted).toBe(true)

    await act(async () => {
      first.resolve(snapshot([post('Wrong chain.')]))
      second.resolve(snapshot([post('Canonical chain.', 2n)]))
      pendingConfirmation.resolve(undefined)
    })
    expect(await screen.findByText('Canonical chain.')).toBeTruthy()
    expect(screen.queryByText('Wrong chain.')).toBeNull()
  })
})
