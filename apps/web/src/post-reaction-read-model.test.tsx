import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider } from './ethereum'
import { DeferredEventCacheCorruptionError } from './event-cache'
import {
  usePostReactionReadModel,
  type PostReactionProjectionReader,
} from './post-reaction-read-model'
import type {
  PostReactionProjectionResumeState,
  PostReactionProjectionRunSnapshot,
} from './post-reaction-projection-run'
import type { PostReactionResumeStore } from './post-reaction-resume-store'
import type {
  PostReactionProjectionAnchor,
  PostReactionStreamSnapshot,
} from './post-reaction-stream'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const ANCHOR = { chainId: 1n } as PostReactionProjectionAnchor
const RESUME = {
  marker: 'resume',
} as unknown as PostReactionProjectionResumeState

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
    startBlock: 0n,
  }
}

function projection(
  phase: PostReactionProjectionRunSnapshot['phase'],
  startBlock = 0n,
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
    startBlock,
  }
}

function resumeStore(
  overrides: Partial<PostReactionResumeStore> = {},
): PostReactionResumeStore {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function projectionRun(
  overrides: Partial<PostReactionProjectionReader> = {},
): PostReactionProjectionReader {
  return {
    advance: vi.fn(),
    close: vi.fn(),
    getSummary: vi.fn(),
    resumeState: RESUME,
    snapshot: projection('likes'),
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

describe('usePostReactionReadModel', () => {
  it('does no RPC or local-cache work before a connected user requests it', () => {
    const synchronize = vi.fn()
    const store = resumeStore()
    const { result } = renderHook(() =>
      usePostReactionReadModel(
        { status: 'disconnected' },
        { resumeStore: store, synchronize },
      ),
    )

    act(() => result.current.loadNextRange())

    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(synchronize).not.toHaveBeenCalled()
    expect(store.load).not.toHaveBeenCalled()
  })

  it('performs one bounded synchronization per request and resumes only after catchup', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(stream(ANCHOR))
    const store = resumeStore({ load: vi.fn().mockResolvedValue(RESUME) })
    const run = projectionRun()
    const openProjection = vi.fn().mockResolvedValue(run)
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection,
        resumeStore: store,
        synchronize,
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('catchup'))
    expect(synchronize).toHaveBeenCalledTimes(1)
    expect(synchronize).toHaveBeenLastCalledWith(
      provider,
      1n,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.load).not.toHaveBeenCalled()
    expect(openProjection).not.toHaveBeenCalled()

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(store.load).toHaveBeenCalledWith(1n)
    expect(openProjection).toHaveBeenCalledWith(ANCHOR, RESUME)
    expect(result.current.state).toMatchObject({
      phase: 'projecting',
      resumed: true,
    })
    expect(run.advance).not.toHaveBeenCalled()
  })

  it('advances exactly one local page per action and saves before publication', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingAdvance = deferred<PostReactionProjectionRunSnapshot>()
    const getSummary = vi.fn().mockReturnValue({
      likeCount: 2n,
      likedByAccount: true,
      repostCount: 1n,
    })
    const run = projectionRun({
      advance: vi
        .fn()
        .mockReturnValueOnce(pendingAdvance.promise)
        .mockResolvedValueOnce(projection('complete')),
      getSummary,
    })
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection: vi.fn().mockResolvedValue(run),
        resumeStore: resumeStore({ save }),
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
    expect(result.current.state).toMatchObject({
      busy: false,
      phase: 'projecting',
    })

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))
    expect(run.advance).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledWith(1n, RESUME)
    expect(result.current.state).toMatchObject({
      phase: 'complete',
      resumeSaved: true,
      resumed: false,
    })
    expect(result.current.getSummary(7n, ACCOUNT)).toEqual({
      likeCount: 2n,
      likedByAccount: true,
      repostCount: 1n,
    })
    expect(getSummary).toHaveBeenCalledWith(7n, ACCOUNT)
  })

  it('discards a rejected resume and opens a fresh projection', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const store = resumeStore({ load: vi.fn().mockResolvedValue(RESUME) })
    const run = projectionRun()
    const openProjection = vi
      .fn()
      .mockRejectedValueOnce(new Error('Derived state binding changed.'))
      .mockResolvedValueOnce(run)
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection,
        resumeStore: store,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    expect(openProjection).toHaveBeenNthCalledWith(1, ANCHOR, RESUME)
    expect(openProjection).toHaveBeenNthCalledWith(2, ANCHOR)
    expect(store.remove).toHaveBeenCalledWith(1n)
    expect(result.current.state).toMatchObject({
      notice: expect.stringMatching(/discarded and rebuilt/i),
      phase: 'projecting',
      resumed: false,
    })
  })

  it('rebuilds when resume storage is unreadable and keeps totals usable if saving fails', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const store = resumeStore({
      load: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable.')),
      remove: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable.')),
      save: vi.fn().mockRejectedValue(new Error('Quota exceeded.')),
    })
    const run = projectionRun({ snapshot: projection('complete') })
    const openProjection = vi.fn().mockResolvedValue(run)
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection,
        resumeStore: store,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))

    expect(openProjection).toHaveBeenCalledWith(ANCHOR, undefined)
    expect(store.remove).toHaveBeenCalledWith(1n)
    expect(result.current.state).toMatchObject({
      notice: expect.stringMatching(/could not be saved/i),
      phase: 'complete',
      resumeSaved: false,
    })
  })

  it('surfaces a bounded synchronization failure and permits an explicit retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC range refused.'))
      .mockResolvedValueOnce(stream())
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        resumeStore: resumeStore(),
        synchronize,
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'RPC range refused.',
      phase: 'failed',
      retryable: true,
    })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('catchup'))
    expect(synchronize).toHaveBeenCalledTimes(2)
  })

  it('resets deferred event-cache corruption before offering another retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const resetCache = vi.fn().mockResolvedValue(undefined)
    const store = resumeStore({
      load: vi.fn().mockResolvedValue(RESUME),
      remove: vi.fn().mockRejectedValue(new Error('Resume store unavailable.')),
    })
    const corruptedRun = projectionRun({
      advance: vi
        .fn()
        .mockRejectedValue(new DeferredEventCacheCorruptionError()),
      snapshot: projection('likes', 123n),
    })
    const nextRun = projectionRun()
    const openProjection = vi
      .fn()
      .mockResolvedValueOnce(corruptedRun)
      .mockResolvedValueOnce(nextRun)
    const synchronize = vi.fn().mockResolvedValue(stream(ANCHOR))
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection,
        resetCache,
        resumeStore: store,
        synchronize,
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))

    expect(resetCache).toHaveBeenCalledWith(1n, 123n)
    expect(store.remove).toHaveBeenCalledWith(1n)
    expect(result.current.state).toMatchObject({
      message: expect.stringMatching(
        /corrupt local reaction caches were reset/i,
      ),
      phase: 'failed',
      retryable: true,
    })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(openProjection).toHaveBeenNthCalledWith(2, ANCHOR, undefined)
    expect(store.load).toHaveBeenCalledTimes(1)
  })

  it('does not offer a futile retry when bounded corruption cleanup fails', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = projectionRun({
      advance: vi
        .fn()
        .mockRejectedValue(new DeferredEventCacheCorruptionError()),
    })
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection: vi.fn().mockResolvedValue(run),
        resetCache: vi
          .fn()
          .mockRejectedValue(new Error('Repair limit exceeded.')),
        resumeStore: resumeStore(),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))

    expect(result.current.state).toMatchObject({
      message: expect.stringMatching(/clear this site’s browser data/i),
      phase: 'failed',
      retryable: false,
    })
  })

  it('fails closed when an opened projection is already unavailable', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = projectionRun({ snapshot: projection('closed') })
    const { result } = renderHook(() =>
      usePostReactionReadModel(connectedSession(provider), {
        openProjection: vi.fn().mockResolvedValue(run),
        resumeStore: resumeStore(),
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
    const store = resumeStore()
    const { rerender, result } = renderHook(
      ({ chainId }) =>
        usePostReactionReadModel(connectedSession(provider, chainId), {
          openProjection,
          resumeStore: store,
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
    expect(store.load).not.toHaveBeenCalled()
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('closes a run that finishes opening after its wallet chain changed', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingOpen = deferred<PostReactionProjectionReader>()
    const openProjection = vi.fn().mockReturnValue(pendingOpen.promise)
    const run = projectionRun()
    const { rerender, result } = renderHook(
      ({ chainId }) =>
        usePostReactionReadModel(connectedSession(provider, chainId), {
          openProjection,
          resumeStore: resumeStore(),
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
    const run = projectionRun()
    const { rerender, result } = renderHook(
      ({ chainId }) =>
        usePostReactionReadModel(connectedSession(provider, chainId), {
          openProjection: vi.fn().mockResolvedValue(run),
          resumeStore: resumeStore(),
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
