import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider } from './ethereum'
import {
  usePostReactionReadModel,
  type PostReactionProjectionReader,
} from './post-reaction-read-model'
import type { PostReactionProjectionRunSnapshot } from './post-reaction-projection-run'
import type {
  PostReactionProjectionAnchor,
  PostReactionStreamSnapshot,
} from './post-reaction-stream'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const ANCHOR = { chainId: 1n } as PostReactionProjectionAnchor

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
  projectionAnchor?: PostReactionProjectionAnchor,
): PostReactionStreamSnapshot {
  return {
    likes: {
      cacheReset: false,
      caughtUp: projectionAnchor !== undefined,
      head: 20n,
      indexedThrough: 8n,
      recentSignals: [],
      safeHead: 8n,
      scannedRanges: 1,
    },
    ...(projectionAnchor ? { projectionAnchor } : {}),
    reposts: {
      cacheReset: false,
      caughtUp: projectionAnchor !== undefined,
      head: 20n,
      indexedThrough: 8n,
      recentReposts: [],
      safeHead: 8n,
      scannedRanges: 1,
    },
  }
}

function projection(
  phase: PostReactionProjectionRunSnapshot['phase'],
): PostReactionProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    chainId: 1n,
    head: 20n,
    likes: { complete, logsProcessed: complete ? 2n : 1n, pagesScanned: 1n },
    phase,
    reposts: {
      complete,
      logsProcessed: complete ? 1n : 0n,
      pagesScanned: complete ? 1n : 0n,
    },
    safeHead: 8n,
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

describe('usePostReactionReadModel', () => {
  it('does no reaction RPC work until a connected user requests it', () => {
    const synchronize = vi.fn()
    const { result } = renderHook(() =>
      usePostReactionReadModel({ status: 'disconnected' }, { synchronize }),
    )

    act(() => result.current.loadNextRange())
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('performs one bounded synchronization per request before opening a run', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = {
      advance: vi.fn(),
      close: vi.fn(),
      getSummary: vi.fn(),
      snapshot: projection('likes'),
    } satisfies PostReactionProjectionReader
    const openProjection = vi.fn().mockResolvedValue(run)
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection,
        synchronize,
      }),
    )

    expect(synchronize).not.toHaveBeenCalled()
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('catchup'))
    expect(synchronize).toHaveBeenCalledTimes(1)
    expect(synchronize).toHaveBeenLastCalledWith(
      provider,
      1n,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(openProjection).not.toHaveBeenCalled()

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(openProjection).toHaveBeenCalledWith(ANCHOR)
    expect(run.advance).not.toHaveBeenCalled()
  })

  it('advances exactly one local page per action and publishes exact summaries', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingAdvance = deferred<PostReactionProjectionRunSnapshot>()
    const getSummary = vi.fn().mockReturnValue({
      likeCount: 2n,
      likedByAccount: true,
      repostCount: 1n,
    })
    const run = {
      advance: vi
        .fn()
        .mockReturnValueOnce(pendingAdvance.promise)
        .mockResolvedValueOnce(projection('complete')),
      close: vi.fn(),
      getSummary,
      snapshot: projection('likes'),
    } satisfies PostReactionProjectionReader
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => {
      result.current.advanceProjection()
      result.current.advanceProjection()
    })
    expect(run.advance).toHaveBeenCalledTimes(1)
    expect(result.current.getSummary(7n, ACCOUNT)).toBeUndefined()
    await act(async () => pendingAdvance.resolve(projection('reposts')))
    expect(result.current.state.phase).toBe('projecting')

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))
    expect(run.advance).toHaveBeenCalledTimes(2)
    expect(result.current.getSummary(7n, ACCOUNT)).toEqual({
      likeCount: 2n,
      likedByAccount: true,
      repostCount: 1n,
    })
    expect(getSummary).toHaveBeenCalledWith(7n, ACCOUNT)
  })

  it('surfaces a bounded synchronization failure and permits an explicit retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC range refused.'))
      .mockResolvedValueOnce(stream())
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), { synchronize }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'RPC range refused.',
      phase: 'failed',
    })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('catchup'))
    expect(synchronize).toHaveBeenCalledTimes(2)
  })

  it('fails closed when an opened projection is already unavailable', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = {
      advance: vi.fn(),
      close: vi.fn(),
      getSummary: vi.fn(),
      snapshot: projection('closed'),
    } satisfies PostReactionProjectionReader
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'The local reaction projection became unavailable.',
      phase: 'failed',
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('aborts and ignores a synchronization from an old wallet chain', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<PostReactionStreamSnapshot>()
    const synchronize = vi.fn().mockReturnValue(pending.promise)
    const openProjection = vi.fn()
    const { rerender, result } = renderHook(
      ({ chainId }) =>
        usePostReactionReadModel(connectedSession(provider, chainId), {
          openProjection,
          synchronize,
        }),
      { initialProps: { chainId: 1n } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalled())
    const signal = synchronize.mock.calls[0]![2].signal as AbortSignal
    rerender({ chainId: 2n })
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('closes a run that finishes opening after its wallet chain changed', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingOpen = deferred<PostReactionProjectionReader>()
    const openProjection = vi.fn().mockReturnValue(pendingOpen.promise)
    const run = {
      advance: vi.fn(),
      close: vi.fn(),
      getSummary: vi.fn(),
      snapshot: projection('likes'),
    } satisfies PostReactionProjectionReader
    const { rerender, result } = renderHook(
      ({ chainId }) =>
        usePostReactionReadModel(connectedSession(provider, chainId), {
          openProjection,
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        }),
      { initialProps: { chainId: 1n } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(openProjection).toHaveBeenCalled())
    rerender({ chainId: 2n })
    await act(async () => pendingOpen.resolve(run))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('closes a projection run when its wallet context is left', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = {
      advance: vi.fn(),
      close: vi.fn(),
      getSummary: vi.fn(),
      snapshot: projection('likes'),
    } satisfies PostReactionProjectionReader
    const { rerender, result } = renderHook(
      ({ chainId }) =>
        usePostReactionReadModel(connectedSession(provider, chainId), {
          openProjection: vi.fn().mockResolvedValue(run),
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        }),
      { initialProps: { chainId: 1n } },
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ chainId: 2n })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(run.close).toHaveBeenCalledTimes(1)
  })
})
