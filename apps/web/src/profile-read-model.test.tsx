import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hash } from 'viem'
import type { Eip1193Provider } from './ethereum'
import {
  useProfileReadModel,
  type ProfileProjectionReader,
} from './profile-read-model'
import type {
  ProfileProjectionResumeState,
  ProfileProjectionRunSnapshot,
} from './profile-projection-run'
import type { ProfileResumeStore } from './profile-resume-store'
import type {
  ProfileProjectionAnchor,
  ProfileStreamSnapshot,
} from './profile-stream'
import type { ProfileSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ACCOUNT_A = '0x000000000000000000000000000000000000a11c' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000b0bb' as Address
const HASH_A = `0x${'aa'.repeat(32)}` as Hash
const HASH_B = `0x${'bb'.repeat(32)}` as Hash
const ANCHOR = { chainId: 1n } as ProfileProjectionAnchor
const RESUME = { marker: 'resume' } as unknown as ProfileProjectionResumeState

const PROFILE: ProfileSet = {
  account: ACCOUNT_A,
  avatarCid: '0x',
  bio: 'Nothing here is private.',
  blockHash: HASH_A,
  blockNumber: 7n,
  displayName: 'Tracey',
  logIndex: 0,
  transactionHash: HASH_B,
  transactionIndex: 0,
}

function connectedSession(
  provider: Eip1193Provider,
  { account = ACCOUNT_A, chainId = 1n } = {},
): WalletSession {
  return {
    account,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function stream(
  projectionAnchor?: ProfileProjectionAnchor,
): ProfileStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    head: 20n,
    indexedThrough: 8n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentProfiles: [],
    safeHead: 8n,
    scannedRanges: 1,
  }
}

function projection(
  phase: ProfileProjectionRunSnapshot['phase'],
): ProfileProjectionRunSnapshot {
  return {
    chainId: 1n,
    head: 20n,
    logsProcessed: phase === 'complete' ? 2n : 1n,
    pagesScanned: 1n,
    phase,
    profilesRetained: phase === 'profiles' ? 0n : 1n,
    safeHead: 8n,
  }
}

function resumeStore(
  overrides: Partial<ProfileResumeStore> = {},
): ProfileResumeStore {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function projectionRun(
  overrides: Partial<ProfileProjectionReader> = {},
): ProfileProjectionReader {
  return {
    advance: vi.fn(),
    close: vi.fn(),
    getProfile: vi.fn().mockReturnValue(PROFILE),
    resumeState: RESUME,
    snapshot: projection('profiles'),
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

describe('useProfileReadModel', () => {
  it('does no RPC or local-cache work before a connected user requests it', () => {
    const synchronize = vi.fn()
    const store = resumeStore()
    const { result } = renderHook(() =>
      useProfileReadModel(
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
      useProfileReadModel(connectedSession(provider), {
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
    expect(store.load).toHaveBeenCalledWith(1n, ACCOUNT_A)
    expect(openProjection).toHaveBeenCalledWith(ANCHOR, [ACCOUNT_A], RESUME)
    expect(result.current.state).toMatchObject({
      phase: 'projecting',
      resumed: true,
    })
    expect(run.advance).not.toHaveBeenCalled()
  })

  it('advances exactly one local page per action and saves before publication', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const firstAdvance = deferred<ProfileProjectionRunSnapshot>()
    const run = projectionRun({
      advance: vi
        .fn()
        .mockReturnValueOnce(firstAdvance.promise)
        .mockResolvedValueOnce(projection('complete')),
    })
    const save = vi.fn().mockResolvedValue(undefined)
    const store = resumeStore({ save })
    const { result } = renderHook(() =>
      useProfileReadModel(connectedSession(provider), {
        openProjection: vi.fn().mockResolvedValue(run),
        resumeStore: store,
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
    expect(result.current.state).toMatchObject({ busy: true })
    await act(async () => firstAdvance.resolve(projection('authenticate')))
    expect(result.current.state).toMatchObject({
      busy: false,
      phase: 'projecting',
      projection: { phase: 'authenticate' },
    })

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))
    expect(run.advance).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledWith(1n, ACCOUNT_A, RESUME)
    expect(run.getProfile).toHaveBeenCalledWith(ACCOUNT_A)
    expect(run.close).toHaveBeenCalledTimes(1)
    expect(result.current.state).toMatchObject({
      phase: 'complete',
      profile: PROFILE,
      resumeSaved: true,
      resumed: false,
    })
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
      useProfileReadModel(connectedSession(provider), {
        openProjection,
        resumeStore: store,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    expect(openProjection).toHaveBeenNthCalledWith(
      1,
      ANCHOR,
      [ACCOUNT_A],
      RESUME,
    )
    expect(openProjection).toHaveBeenNthCalledWith(2, ANCHOR, [ACCOUNT_A])
    expect(store.remove).toHaveBeenCalledWith(1n, ACCOUNT_A)
    expect(result.current.state).toMatchObject({
      notice: expect.stringMatching(/discarded and rebuilt/i),
      phase: 'projecting',
      resumed: false,
    })
  })

  it('rebuilds when resume storage is unreadable and keeps the result usable if saving fails', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const store = resumeStore({
      load: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable.')),
      remove: vi.fn().mockRejectedValue(new Error('IndexedDB unavailable.')),
      save: vi.fn().mockRejectedValue(new Error('Quota exceeded.')),
    })
    const run = projectionRun({
      snapshot: projection('complete'),
    })
    const openProjection = vi.fn().mockResolvedValue(run)
    const { result } = renderHook(() =>
      useProfileReadModel(connectedSession(provider), {
        openProjection,
        resumeStore: store,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))

    expect(openProjection).toHaveBeenCalledWith(ANCHOR, [ACCOUNT_A], undefined)
    expect(store.remove).toHaveBeenCalledWith(1n, ACCOUNT_A)
    expect(result.current.state).toMatchObject({
      notice: expect.stringMatching(/could not be saved/i),
      phase: 'complete',
      profile: PROFILE,
      resumeSaved: false,
    })
  })

  it('surfaces failures and permits an explicit bounded retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC range refused.'))
      .mockResolvedValueOnce(stream())
    const { result } = renderHook(() =>
      useProfileReadModel(connectedSession(provider), {
        resumeStore: resumeStore(),
        synchronize,
      }),
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

  it('aborts and ignores work from an old account context', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<ProfileStreamSnapshot>()
    const synchronize = vi.fn().mockReturnValue(pending.promise)
    const openProjection = vi.fn()
    const store = resumeStore()
    const { rerender, result } = renderHook(
      ({ account }) =>
        useProfileReadModel(connectedSession(provider, { account }), {
          openProjection,
          resumeStore: store,
          synchronize,
        }),
      { initialProps: { account: ACCOUNT_A } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalled())
    const signal = synchronize.mock.calls[0]![2].signal as AbortSignal
    rerender({ account: ACCOUNT_B })
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(stream(ANCHOR)))

    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(store.load).not.toHaveBeenCalled()
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('closes a projection that finishes opening after the wallet context changes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingOpen = deferred<ProfileProjectionReader>()
    const run = projectionRun()
    const openProjection = vi.fn().mockReturnValue(pendingOpen.promise)
    const { rerender, result } = renderHook(
      ({ account }) =>
        useProfileReadModel(connectedSession(provider, { account }), {
          openProjection,
          resumeStore: resumeStore(),
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        }),
      { initialProps: { account: ACCOUNT_A } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(openProjection).toHaveBeenCalled())
    rerender({ account: ACCOUNT_B })
    await act(async () => pendingOpen.resolve(run))

    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(run.close).toHaveBeenCalledTimes(1)
  })
})
