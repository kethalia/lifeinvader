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
import type { PostCommentProjectionReader } from './post-comment-read-model'
import type { PostCommentProjectionRunSnapshot } from './post-comment-projection-run'
import type {
  PostCommentProjectionAnchor,
  PostCommentStreamSnapshot,
} from './post-comment-stream'
import { PostFeedPanel } from './post-feed-panel'
import type { PostFeedSnapshot } from './post-feed'
import type { PostFeedConfirmationWaiter } from './post-feed-confirmation'
import type { PostReactionProjectionReader } from './post-reaction-read-model'
import type { PostReactionProjectionRunSnapshot } from './post-reaction-projection-run'
import type {
  PostReactionProjectionAnchor,
  PostReactionStreamSnapshot,
} from './post-reaction-stream'
import {
  publishComment,
  publishRepost,
  setPostLike,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
import type { PublishedComment, PublishedPost } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const REPLACEMENT_BLOCK_HASH = `0x${'33'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const COMMENT_ANCHOR = {
  chainId: 1n,
  safeHead: 18n,
} as PostCommentProjectionAnchor
const REACTION_ANCHOR = { chainId: 1n } as PostReactionProjectionAnchor

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

function comment(
  body: string,
  commentId: bigint,
  postId = 1n,
  mediaCid: Hex = '0x',
): PublishedComment {
  return {
    author: ACCOUNT,
    blockHash: BLOCK_HASH,
    blockNumber: commentId + 30n,
    body,
    commentId,
    logIndex: Number(commentId),
    mediaCid,
    postId,
    transactionHash: TRANSACTION_HASH,
    transactionIndex: Number(commentId),
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

function reactionStream(): PostReactionStreamSnapshot {
  return {
    likes: {
      cacheReset: false,
      caughtUp: true,
      head: 20n,
      indexedThrough: 8n,
      recentSignals: [],
      safeHead: 8n,
      scannedRanges: 1,
    },
    projectionAnchor: REACTION_ANCHOR,
    reposts: {
      cacheReset: false,
      caughtUp: true,
      head: 20n,
      indexedThrough: 8n,
      recentReposts: [],
      safeHead: 8n,
      scannedRanges: 1,
    },
  }
}

function commentStream(
  projectionAnchor?: PostCommentProjectionAnchor,
): PostCommentStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    head: 20n,
    indexedThrough: 18n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentComments: [],
    safeHead: 18n,
    scannedRanges: 1,
  }
}

function reactionProjection(
  phase: PostReactionProjectionRunSnapshot['phase'],
): PostReactionProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    chainId: 1n,
    head: 20n,
    likes: { complete, logsProcessed: 2n, pagesScanned: 1n },
    phase,
    reposts: {
      complete,
      logsProcessed: complete ? 1n : 0n,
      pagesScanned: complete ? 1n : 0n,
    },
    safeHead: 8n,
  }
}

function commentProjection(
  phase: PostCommentProjectionRunSnapshot['phase'],
): PostCommentProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    chainId: 1n,
    commentsRetained: complete ? 12n : 10n,
    head: 20n,
    logsProcessed: complete ? 12n : 10n,
    pagesScanned: complete ? 2n : 1n,
    phase,
    safeHead: 18n,
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

  it('loads exact reaction totals through explicit bounded user steps', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronizePostReactions = vi.fn().mockResolvedValue(reactionStream())
    const run = {
      advance: vi
        .fn()
        .mockResolvedValueOnce(reactionProjection('reposts'))
        .mockResolvedValueOnce(reactionProjection('authenticate'))
        .mockResolvedValueOnce(reactionProjection('complete')),
      close: vi.fn(),
      getSummary: vi.fn().mockReturnValue({
        likeCount: 2n,
        likedByAccount: true,
        repostCount: 1n,
      }),
      snapshot: reactionProjection('likes'),
    } satisfies PostReactionProjectionReader
    const openReactionProjection = vi.fn().mockResolvedValue(run)
    render(
      <PostFeedPanel
        openReactionProjection={openReactionProjection}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(snapshot([post('Count me.')]))}
        synchronizePostReactions={synchronizePostReactions}
      />,
    )

    expect(await screen.findByText('Count me.')).toBeTruthy()
    expect(synchronizePostReactions).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: /load reaction counts/i }),
    )
    expect(
      await screen.findByRole('button', {
        name: /process next local reaction page/i,
      }),
    ).toBeTruthy()
    expect(synchronizePostReactions).toHaveBeenCalledTimes(1)
    expect(openReactionProjection).toHaveBeenCalledWith(REACTION_ANCHOR)

    for (let step = 1; step <= 3; step += 1) {
      fireEvent.click(
        screen.getByRole('button', {
          name: /process next local reaction page/i,
        }),
      )
      await waitFor(() => expect(run.advance).toHaveBeenCalledTimes(step))
      if (step < 3) {
        await screen.findByRole('button', {
          name: /process next local reaction page/i,
        })
      }
    }

    expect(
      await screen.findByRole('button', {
        name: /check for newer reactions/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/exact through confirmed block 8/i)).toBeTruthy()
    expect(
      screen.getByText(/2 likes · 1 repost · You liked this/i),
    ).toBeTruthy()
    expect(run.getSummary).toHaveBeenCalledWith(1n, ACCOUNT)
  })

  it('derives and paginates exact visible comment histories only on request', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const mediaCid = parseMediaCid(
      'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
    )!
    const comments = Array.from({ length: 12 }, (_, index) =>
      comment(
        `Public comment ${index + 1}.`,
        BigInt(index + 1),
        1n,
        index === 10 ? mediaCid.bytes : '0x',
      ),
    )
    const readComments = vi.fn(
      (postId: bigint, options: { limit?: number; offset?: number } = {}) => {
        const selected = postId === 1n ? comments : []
        const limit = options.limit ?? 50
        const offset = options.offset ?? 0
        const end = Math.min(offset + limit, selected.length)
        const complete = end >= selected.length
        return {
          comments: selected.slice(offset, end),
          complete,
          ...(complete ? {} : { nextOffset: end }),
          totalComments: BigInt(selected.length),
        }
      },
    )
    const run = {
      advance: vi
        .fn()
        .mockResolvedValueOnce(commentProjection('authenticate'))
        .mockResolvedValueOnce(commentProjection('complete')),
      close: vi.fn(),
      readComments,
      snapshot: commentProjection('comments'),
      trackedPostIds: [1n, 2n],
    } satisfies PostCommentProjectionReader
    const refreshedRun = {
      advance: vi.fn(),
      close: vi.fn(),
      readComments,
      snapshot: commentProjection('complete'),
      trackedPostIds: [1n, 2n],
    } satisfies PostCommentProjectionReader
    const synchronizePostComments = vi
      .fn()
      .mockResolvedValueOnce(commentStream())
      .mockResolvedValueOnce(commentStream(COMMENT_ANCHOR))
      .mockResolvedValueOnce(commentStream(COMMENT_ANCHOR))
    const openCommentProjection = vi
      .fn()
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(refreshedRun)

    render(
      <PostFeedPanel
        openCommentProjection={openCommentProjection}
        session={connectedSession(provider)}
        synchronize={vi
          .fn()
          .mockResolvedValue(
            snapshot([post('First post.'), post('Second post.', 2n)]),
          )}
        synchronizePostComments={synchronizePostComments}
      />,
    )

    expect(await screen.findByText('First post.')).toBeTruthy()
    expect(synchronizePostComments).not.toHaveBeenCalled()
    expect(readComments).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: /load comment histories/i }),
    )
    expect(
      await screen.findByRole('button', {
        name: /load next comment range/i,
      }),
    ).toBeTruthy()
    expect(synchronizePostComments).toHaveBeenCalledTimes(1)
    expect(openCommentProjection).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: /load next comment range/i }),
    )
    expect(
      await screen.findByRole('button', {
        name: /process next local comment page/i,
      }),
    ).toBeTruthy()
    expect(synchronizePostComments).toHaveBeenCalledTimes(2)
    expect(openCommentProjection).toHaveBeenCalledWith(COMMENT_ANCHOR, [1n, 2n])
    expect(run.advance).not.toHaveBeenCalled()

    for (let step = 1; step <= 2; step += 1) {
      fireEvent.click(
        screen.getByRole('button', {
          name: /process next local comment page/i,
        }),
      )
      await waitFor(() => expect(run.advance).toHaveBeenCalledTimes(step))
      if (step < 2) {
        await screen.findByRole('button', {
          name: /process next local comment page/i,
        })
      }
    }

    expect(
      await screen.findByRole('button', {
        name: /check for newer comments/i,
      }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /comment histories are exact through confirmed block 18/i,
      ),
    ).toBeTruthy()
    expect(screen.getByText('Public comment 1.')).toBeTruthy()
    expect(screen.getByText('Public comments · 12')).toBeTruthy()
    expect(
      screen.getByText('No confirmed comments as of this block.'),
    ).toBeTruthy()
    expect(screen.queryByText('Public comment 11.')).toBeNull()
    expect(readComments).toHaveBeenCalledWith(1n, { limit: 10, offset: 0 })
    expect(readComments).toHaveBeenCalledWith(2n, { limit: 10, offset: 0 })

    fireEvent.click(
      screen.getByRole('button', { name: /show next comments for post 1/i }),
    )
    expect(await screen.findByText('Public comment 11.')).toBeTruthy()
    expect(screen.getByText(mediaCid.text)).toBeTruthy()
    expect(screen.queryByText('Public comment 1.')).toBeNull()
    expect(readComments).toHaveBeenCalledWith(1n, { limit: 10, offset: 10 })

    fireEvent.click(
      screen.getByRole('button', {
        name: /show previous comments for post 1/i,
      }),
    )
    expect(await screen.findByText('Public comment 1.')).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: /show next comments for post 1/i }),
    )
    expect(await screen.findByText('Public comment 11.')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: /check for newer comments/i }),
    )
    await waitFor(() => expect(openCommentProjection).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const firstPostCalls = readComments.mock.calls.filter(
        ([postId]) => postId === 1n,
      )
      expect(firstPostCalls.at(-1)?.[1]).toEqual({ limit: 10, offset: 0 })
    })
    expect(screen.getByText('Public comment 1.')).toBeTruthy()
    expect(run.close).toHaveBeenCalledTimes(1)
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

  it('publishes a text and media comment as one verified post action', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const mediaCid = parseMediaCid(
      'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
    )!
    const receipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    }
    const publishCommentAction = vi.fn<typeof publishComment>(
      async (_provider, _account, _chainId, _postId, _payload, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        return receipt
      },
    )
    render(
      <PostFeedPanel
        publishCommentAction={publishCommentAction}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(snapshot([post('Discuss.')]))}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /write comment for post 1/i,
      }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: /permanent public comment/i }),
      { target: { value: 'This comment is public forever.' } },
    )
    fireEvent.change(screen.getByRole('textbox', { name: /IPFS media CID/i }), {
      target: { value: mediaCid.text },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /publish comment on-chain/i }),
    )

    expect(
      await screen.findByText(/comment for post #1 was included in block 42/i),
    ).toBeTruthy()
    expect(publishCommentAction).toHaveBeenCalledWith(
      provider,
      ACCOUNT,
      1n,
      1n,
      {
        body: 'This comment is public forever.',
        mediaCid: mediaCid.bytes,
      },
      expect.any(Function),
    )
    expect(
      screen.queryByRole('textbox', { name: /permanent public comment/i }),
    ).toBeNull()
  })

  it('retains independent unsent comment drafts across chain contexts', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi.fn().mockResolvedValue(snapshot([post('Move.')]))
    const { rerender } = render(
      <PostFeedPanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /write comment for post 1/i,
      }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: /permanent public comment/i }),
      { target: { value: 'Chain-one draft.' } },
    )

    rerender(
      <PostFeedPanel
        session={connectedSession(provider, 2n)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    fireEvent.click(
      await screen.findByRole('button', {
        name: /write comment for post 1/i,
      }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: /permanent public comment/i }),
      { target: { value: 'Chain-two draft.' } },
    )

    rerender(
      <PostFeedPanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(3))
    expect(
      (await screen.findByRole('textbox', {
        name: /permanent public comment/i,
      })) as HTMLTextAreaElement,
    ).toHaveProperty('value', 'Chain-one draft.')

    rerender(
      <PostFeedPanel
        session={connectedSession(provider, 2n)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(4))
    expect(
      (await screen.findByRole('textbox', {
        name: /permanent public comment/i,
      })) as HTMLTextAreaElement,
    ).toHaveProperty('value', 'Chain-two draft.')
  })

  it('pauses a draft when its canonical post event is replaced', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const replacement = {
      ...post('Replacement content.'),
      blockHash: REPLACEMENT_BLOCK_HASH,
      logIndex: 2,
    }
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(snapshot([post('Original content.')]))
      .mockResolvedValueOnce(snapshot([replacement]))
    render(
      <PostFeedPanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /write comment for post 1/i,
      }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: /permanent public comment/i }),
      { target: { value: 'Only for the original.' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: /check for newer posts/i }),
    )

    expect(await screen.findByText('Replacement content.')).toBeTruthy()
    expect(screen.getByText(/comment draft paused/i)).toBeTruthy()
    expect(
      screen.getByRole('textbox', { name: /paused draft text/i }),
    ).toHaveProperty('value', 'Only for the original.')
    expect(
      screen
        .getByRole('button', { name: /write comment for post 1/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    fireEvent.click(
      screen.getByRole('button', { name: /discard paused draft/i }),
    )
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /write comment for post 1/i })
          .hasAttribute('disabled'),
      ).toBe(false),
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

  it('clears the published context draft without clearing a new-chain draft', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const delayedComment = deferred<TransactionReceipt>()
    const publishCommentAction = vi
      .fn<typeof publishComment>()
      .mockImplementationOnce(
        async (
          _provider,
          _account,
          _chainId,
          _postId,
          _payload,
          onSubmitted,
        ) => {
          onSubmitted?.(TRANSACTION_HASH)
          return delayedComment.promise
        },
      )
    const synchronize = vi.fn().mockResolvedValue(snapshot([post('Move.')]))
    const { rerender } = render(
      <PostFeedPanel
        publishCommentAction={publishCommentAction}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: /write comment for post 1/i,
      }),
    )
    fireEvent.change(
      screen.getByRole('textbox', { name: /permanent public comment/i }),
      { target: { value: 'Old-chain draft.' } },
    )
    fireEvent.click(
      screen.getByRole('button', { name: /publish comment on-chain/i }),
    )
    await waitFor(() => expect(publishCommentAction).toHaveBeenCalledTimes(1))

    rerender(
      <PostFeedPanel
        publishCommentAction={publishCommentAction}
        session={connectedSession(provider, 2n)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    fireEvent.click(
      screen.getByRole('button', { name: /write comment for post 1/i }),
    )
    const newDraft = screen.getByRole('textbox', {
      name: /permanent public comment/i,
    })
    fireEvent.change(newDraft, { target: { value: 'New-chain draft.' } })

    await act(async () =>
      delayedComment.resolve({
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        hash: TRANSACTION_HASH,
      }),
    )
    expect(
      (
        screen.getByRole('textbox', {
          name: /permanent public comment/i,
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('New-chain draft.')

    rerender(
      <PostFeedPanel
        publishCommentAction={publishCommentAction}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(3))
    expect(
      screen.queryByRole('textbox', { name: /permanent public comment/i }),
    ).toBeNull()

    rerender(
      <PostFeedPanel
        publishCommentAction={publishCommentAction}
        session={connectedSession(provider, 2n)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(4))
    expect(
      (await screen.findByRole('textbox', {
        name: /permanent public comment/i,
      })) as HTMLTextAreaElement,
    ).toHaveProperty('value', 'New-chain draft.')
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
