import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider } from './ethereum'
import type { PostCommentProjectionReadPage } from './post-comment-projection'
import {
  usePostCommentReadModel,
  type PostCommentProjectionReader,
  type PostCommentReadTarget,
} from './post-comment-read-model'
import type { PostCommentProjectionRunSnapshot } from './post-comment-projection-run'
import type {
  PostCommentProjectionAnchor,
  PostCommentStreamSnapshot,
} from './post-comment-stream'
import type { PostFeedSnapshot } from './post-feed'
import type { PublishedPost } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const ANCHOR = { chainId: 1n, safeHead: 8n } as PostCommentProjectionAnchor
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const REPLACEMENT_BLOCK_HASH = `0x${'22'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'33'.repeat(32)}` as const
const COMMENT_PAGE = {
  comments: [],
  complete: true,
  totalComments: 0n,
} satisfies PostCommentProjectionReadPage

function target(
  postId: bigint,
  blockHash: PostCommentReadTarget['blockHash'] = BLOCK_HASH,
): PostCommentReadTarget {
  return {
    blockHash,
    blockNumber: postId,
    logIndex: Number(postId),
    postId,
  }
}

function feedSnapshot(
  targets: readonly PostCommentReadTarget[],
): PostFeedSnapshot {
  return {
    cacheReset: false,
    caughtUp: true,
    head: 20n,
    indexedThrough: 8n,
    posts: targets.map((entry): PublishedPost => ({
      ...entry,
      author: ACCOUNT,
      body: `Post ${entry.postId.toString()}`,
      mediaCid: '0x',
      transactionHash: TRANSACTION_HASH,
      transactionIndex: 0,
    })),
    safeHead: 8n,
    scannedRanges: 1,
    startBlock: 0n,
  }
}

function postSynchronizer(...targets: PostCommentReadTarget[]) {
  return vi.fn().mockResolvedValue(feedSnapshot(targets))
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

function stream(
  projectionAnchor?: PostCommentProjectionAnchor,
): PostCommentStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    head: 20n,
    indexedThrough: 8n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentComments: [],
    safeHead: 8n,
    scannedRanges: 1,
  }
}

function projection(
  phase: PostCommentProjectionRunSnapshot['phase'],
): PostCommentProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    chainId: 1n,
    commentsRetained: complete ? 2n : 1n,
    head: 20n,
    logsProcessed: complete ? 3n : 1n,
    pagesScanned: 1n,
    phase,
    safeHead: 8n,
  }
}

function reader(
  overrides: Partial<PostCommentProjectionReader> = {},
): PostCommentProjectionReader {
  return {
    advance: vi.fn(),
    close: vi.fn(),
    readComments: vi.fn().mockReturnValue(COMMENT_PAGE),
    snapshot: projection('comments'),
    trackedPostIds: [7n, 8n],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, reject, resolve }
}

afterEach(cleanup)

describe('usePostCommentReadModel', () => {
  it('does no comment RPC work without a connected wallet and visible post', () => {
    const synchronize = vi.fn()
    const disconnected = renderHook(() =>
      usePostCommentReadModel({ status: 'disconnected' }, [target(7n)], {
        synchronize,
      }),
    )

    act(() => disconnected.result.current.loadNextRange())
    expect(disconnected.result.current.state).toEqual({ phase: 'idle' })

    const provider = { request: vi.fn() } as Eip1193Provider
    const empty = renderHook(() =>
      usePostCommentReadModel(connectedSession(provider), [], { synchronize }),
    )
    act(() => empty.result.current.loadNextRange())
    expect(empty.result.current.state).toEqual({ phase: 'idle' })
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('performs one bounded synchronization before opening the selected scope', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = reader()
    const openProjection = vi.fn().mockResolvedValue(run)
    const synchronizePosts = postSynchronizer(target(7n), target(8n))
    const { result } = renderHook(() =>
      usePostCommentReadModel(
        connectedSession(provider),
        [target(8n), target(7n)],
        {
          openProjection,
          synchronize,
          synchronizePosts,
        },
      ),
    )

    expect(synchronize).not.toHaveBeenCalled()
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('catchup'))
    expect(synchronize).toHaveBeenCalledTimes(1)
    expect(synchronizePosts).not.toHaveBeenCalled()
    expect(synchronize).toHaveBeenLastCalledWith(
      provider,
      1n,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(openProjection).not.toHaveBeenCalled()

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(synchronizePosts).toHaveBeenCalledWith(
      provider,
      1n,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(openProjection).toHaveBeenCalledWith(ANCHOR, [7n, 8n])
    expect(run.advance).not.toHaveBeenCalled()
  })

  it('advances one local page per action and exposes only bounded completed reads', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingAdvance = deferred<PostCommentProjectionRunSnapshot>()
    const readComments = vi.fn().mockReturnValue(COMMENT_PAGE)
    const run = reader({
      advance: vi
        .fn()
        .mockReturnValueOnce(pendingAdvance.promise)
        .mockResolvedValueOnce(projection('complete')),
      readComments,
    })
    const { result } = renderHook(() =>
      usePostCommentReadModel(connectedSession(provider), [target(7n)], {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        synchronizePosts: postSynchronizer(target(7n)),
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => {
      result.current.advanceProjection()
      result.current.advanceProjection()
    })
    expect(run.advance).toHaveBeenCalledTimes(1)
    expect(result.current.readComments(7n)).toBeUndefined()
    await act(async () => pendingAdvance.resolve(projection('authenticate')))
    expect(result.current.state.phase).toBe('projecting')

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))
    const options = { limit: 50, offset: 50 }
    expect(result.current.readComments(7n, options)).toBe(COMMENT_PAGE)
    expect(readComments).toHaveBeenCalledWith(7n, options)
    expect(run.advance).toHaveBeenCalledTimes(2)
  })

  it('surfaces synchronization and projection failures for explicit retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC range refused.'))
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = reader({
      advance: vi.fn().mockRejectedValue(new Error('Cache proof changed.')),
    })
    const { result } = renderHook(() =>
      usePostCommentReadModel(connectedSession(provider), [target(7n)], {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize,
        synchronizePosts: postSynchronizer(target(7n)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'RPC range refused.',
      phase: 'failed',
    })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'Cache proof changed.',
      phase: 'failed',
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an opened projection is already unavailable', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = reader({ snapshot: projection('closed') })
    const { result } = renderHook(() =>
      usePostCommentReadModel(connectedSession(provider), [target(7n)], {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        synchronizePosts: postSynchronizer(target(7n)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'The local comment projection became unavailable.',
      phase: 'failed',
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('aborts and ignores synchronization from an old chain or post scope', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const first = deferred<PostCommentStreamSnapshot>()
    const second = deferred<PostCommentStreamSnapshot>()
    const synchronize = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const openProjection = vi.fn()
    const { rerender, result } = renderHook(
      ({ chainId, postId }) =>
        usePostCommentReadModel(
          connectedSession(provider, chainId),
          [target(postId)],
          { openProjection, synchronize },
        ),
      { initialProps: { chainId: 1n, postId: 7n } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]![2].signal as AbortSignal
    rerender({ chainId: 2n, postId: 7n })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => first.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    const secondSignal = synchronize.mock.calls[1]![2].signal as AbortSignal
    rerender({ chainId: 2n, postId: 8n })
    expect(secondSignal.aborted).toBe(true)
    await act(async () => second.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('refuses to publish comments beneath a post replaced on the authenticated feed', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const openProjection = vi.fn()
    const { result } = renderHook(() =>
      usePostCommentReadModel(connectedSession(provider), [target(7n)], {
        openProjection,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        synchronizePosts: postSynchronizer(target(7n, REPLACEMENT_BLOCK_HASH)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: expect.stringMatching(/post feed changed.*refresh posts/i),
      phase: 'failed',
    })
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('aborts an authenticated feed refresh when the visible post scope changes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingFeed = deferred<PostFeedSnapshot>()
    const synchronizePosts = vi.fn().mockReturnValue(pendingFeed.promise)
    const openProjection = vi.fn()
    const { rerender, result } = renderHook(
      ({ postId }) =>
        usePostCommentReadModel(connectedSession(provider), [target(postId)], {
          openProjection,
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
          synchronizePosts,
        }),
      { initialProps: { postId: 7n } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronizePosts).toHaveBeenCalledTimes(1))
    const signal = synchronizePosts.mock.calls[0]![2].signal as AbortSignal
    rerender({ postId: 8n })
    expect(signal.aborted).toBe(true)
    await act(async () => pendingFeed.resolve(feedSnapshot([target(7n)])))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('closes a late run when the canonical event for the same post ID changes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingOpen = deferred<PostCommentProjectionReader>()
    const openProjection = vi.fn().mockReturnValue(pendingOpen.promise)
    const run = reader()
    const { rerender, result } = renderHook(
      ({ replaced }) =>
        usePostCommentReadModel(
          connectedSession(provider),
          [target(7n, replaced ? REPLACEMENT_BLOCK_HASH : BLOCK_HASH)],
          {
            openProjection,
            synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
            synchronizePosts: postSynchronizer(target(7n)),
          },
        ),
      { initialProps: { replaced: false } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(openProjection).toHaveBeenCalled())
    rerender({ replaced: true })
    await act(async () => pendingOpen.resolve(run))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('closes an active projection when its wallet or post scope is left', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const firstRun = reader()
    const secondRun = reader()
    const openProjection = vi
      .fn()
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(secondRun)
    const synchronize = vi.fn().mockResolvedValue(stream(ANCHOR))
    const synchronizePosts = vi
      .fn()
      .mockResolvedValueOnce(feedSnapshot([target(7n)]))
      .mockResolvedValueOnce(feedSnapshot([target(8n)]))
    const { rerender, result } = renderHook(
      ({ chainId, postId }) =>
        usePostCommentReadModel(
          connectedSession(provider, chainId),
          [target(postId)],
          { openProjection, synchronize, synchronizePosts },
        ),
      { initialProps: { chainId: 1n, postId: 7n } },
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ chainId: 1n, postId: 8n })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(firstRun.close).toHaveBeenCalledTimes(1)
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ chainId: 2n, postId: 8n })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(secondRun.close).toHaveBeenCalledTimes(1)
  })
})
