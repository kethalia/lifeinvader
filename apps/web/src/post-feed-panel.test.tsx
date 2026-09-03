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
import {
  publishRepost,
  setPostLike,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
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

  it('submits explicit like, unlike, and repost events for a confirmed post', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const receipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    }
    const setPostLikeAction = vi.fn<typeof setPostLike>(
      async (_provider, _account, _chainId, _postId, _liked, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        return receipt
      },
    )
    const publishRepostAction = vi.fn<typeof publishRepost>(
      async (_provider, _account, _chainId, _postId, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        return receipt
      },
    )

    render(
      <PostFeedPanel
        publishRepostAction={publishRepostAction}
        session={connectedSession(provider)}
        setPostLikeAction={setPostLikeAction}
        synchronize={vi.fn().mockResolvedValue(snapshot([post('React.')]))}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /record like for post 1/i,
      }),
    )
    expect(
      await screen.findByText(/like for post #1 was included/i),
    ).toBeTruthy()
    expect(setPostLikeAction).toHaveBeenLastCalledWith(
      provider,
      ACCOUNT,
      1n,
      1n,
      true,
      expect.any(Function),
    )

    fireEvent.click(
      screen.getByRole('button', { name: /record unlike for post 1/i }),
    )
    expect(
      await screen.findByText(/unlike for post #1 was included/i),
    ).toBeTruthy()
    expect(setPostLikeAction).toHaveBeenLastCalledWith(
      provider,
      ACCOUNT,
      1n,
      1n,
      false,
      expect.any(Function),
    )

    fireEvent.click(screen.getByRole('button', { name: /repost post 1/i }))
    expect(
      await screen.findByText(/repost for post #1 was included/i),
    ).toBeTruthy()
    expect(publishRepostAction).toHaveBeenCalledWith(
      provider,
      ACCOUNT,
      1n,
      1n,
      expect.any(Function),
    )
  })

  it('locks duplicate actions around an unknown hash and safely retries its receipt', async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_accounts') return [ACCOUNT]
        throw new Error(`Unexpected method: ${method}`)
      }),
    } as Eip1193Provider
    const publishRepostAction = vi.fn<typeof publishRepost>(
      async (_provider, _account, _chainId, _postId, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Receipt transport timed out.')
      },
    )
    const receipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    }
    const waitForActionReceipt = vi.fn<typeof waitForTransactionReceipt>(
      async () => receipt,
    )

    render(
      <PostFeedPanel
        publishRepostAction={publishRepostAction}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(snapshot([post('Again.')]))}
        waitForActionReceipt={waitForActionReceipt}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: /repost post 1/i }),
    )
    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /record like for post 1/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    fireEvent.click(
      screen.getByRole('button', { name: /check action receipt again/i }),
    )
    expect(
      await screen.findByText(/repost for post #1 was included/i),
    ).toBeTruthy()
    expect(waitForActionReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      expect.objectContaining({
        assertCurrentChain: expect.any(Function),
        assertUnchanged: expect.any(Function),
        expectedPostAction: {
          account: ACCOUNT,
          kind: 'repost',
          postId: 1n,
        },
        selectedChainId: 1n,
      }),
    )
  })

  it('requires wallet acknowledgment when a broadcast returns no hash', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const publishRepostAction = vi.fn<typeof publishRepost>(async () => {
      throw new TransactionSubmissionUnknownError(
        new Error('Provider response timed out.'),
      )
    })

    render(
      <PostFeedPanel
        publishRepostAction={publishRepostAction}
        session={connectedSession(provider)}
        synchronize={vi
          .fn()
          .mockResolvedValue(snapshot([post('Maybe twice.')]))}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: /repost post 1/i }),
    )
    const acknowledge = await screen.findByRole('button', {
      name: /i checked my wallet/i,
    })
    expect(screen.getByText(/may have broadcast it/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /record like for post 1/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    fireEvent.click(acknowledge)
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /record like for post 1/i })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
  })

  it('retains delayed old-chain recovery without locking the new chain', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const delayedAction = deferred<TransactionReceipt>()
    let reportSubmitted: TransactionSubmitted | undefined
    const setPostLikeAction = vi.fn<typeof setPostLike>(
      async (_provider, _account, _chainId, _postId, _liked, onSubmitted) => {
        reportSubmitted = onSubmitted
        return delayedAction.promise
      },
    )
    const synchronize = vi.fn().mockResolvedValue(snapshot([post('Move.')]))
    const { rerender } = render(
      <PostFeedPanel
        session={connectedSession(provider)}
        setPostLikeAction={setPostLikeAction}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /record like for post 1/i,
      }),
    )
    await waitFor(() => expect(reportSubmitted).toBeDefined())
    rerender(
      <PostFeedPanel
        session={connectedSession(provider, 2n)}
        setPostLikeAction={setPostLikeAction}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    act(() => reportSubmitted?.(TRANSACTION_HASH))

    expect(
      await screen.findByText(/belongs to another wallet context/i),
    ).toBeTruthy()
    expect(screen.getByText(/post #1 on chain 1 from/i)).toBeTruthy()
    expect(screen.getByText(/via Test Wallet/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /record like for post 1/i })
        .hasAttribute('disabled'),
    ).toBe(false)

    await act(async () =>
      delayedAction.resolve({
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        hash: TRANSACTION_HASH,
      }),
    )
    await waitFor(() =>
      expect(
        screen.queryByText(/belongs to another wallet context/i),
      ).toBeNull(),
    )
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
