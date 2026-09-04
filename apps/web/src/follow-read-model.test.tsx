import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { Eip1193Provider } from './ethereum'
import { DeferredEventCacheCorruptionError } from './event-cache'
import type {
  FollowDirection,
  FollowProjectionReadPage,
} from './follow-projection'
import {
  useFollowReadModel,
  type FollowProjectionReader,
} from './follow-read-model'
import type { FollowProjectionRunSnapshot } from './follow-projection-run'
import type {
  FollowProjectionAnchor,
  FollowStreamSnapshot,
} from './follow-stream'
import type { FollowSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const SELECTED_A = '0x000000000000000000000000000000000000a11c' as Address
const SELECTED_B = '0x000000000000000000000000000000000000b0bb' as Address
const COUNTERPART = '0x000000000000000000000000000000000000c0cc' as Address
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const ANCHOR = {
  account: SELECTED_A,
  chainId: 1n,
  direction: 'following',
  head: 20n,
  safeHead: 8n,
} as FollowProjectionAnchor
const RELATIONSHIP = {
  blockHash: BLOCK_HASH,
  blockNumber: 3n,
  followed: COUNTERPART,
  follower: SELECTED_A,
  following: true,
  logIndex: 0,
  transactionHash: TRANSACTION_HASH,
  transactionIndex: 0,
} satisfies FollowSet
const RELATIONSHIP_PAGE = {
  complete: true,
  relationships: [RELATIONSHIP],
  totalRelationships: 1n,
} satisfies FollowProjectionReadPage

function connectedSession(
  provider: Eip1193Provider,
  chainId = 1n,
): WalletSession {
  return {
    account: SELECTED_A,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function stream(
  projectionAnchor?: FollowProjectionAnchor,
  account = SELECTED_A,
  direction: FollowDirection = 'following',
): FollowStreamSnapshot {
  return {
    account,
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    direction,
    head: 20n,
    indexedThrough: 8n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentSignals: [],
    safeHead: 8n,
    scannedRanges: 1,
    startBlock: 0n,
  }
}

function projection(
  phase: FollowProjectionRunSnapshot['phase'],
  account = SELECTED_A,
  direction: FollowDirection = 'following',
  chainId = 1n,
): FollowProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    account,
    chainId,
    direction,
    head: 20n,
    logsProcessed: complete ? 3n : 1n,
    relationshipsRetained: complete ? 1n : 0n,
    pagesScanned: 1n,
    phase,
    safeHead: 8n,
    startBlock: 0n,
  }
}

function reader(
  overrides: Partial<FollowProjectionReader> = {},
): FollowProjectionReader {
  return {
    advance: vi.fn(),
    account: SELECTED_A,
    close: vi.fn(),
    direction: 'following',
    getRelationship: vi.fn().mockReturnValue(RELATIONSHIP),
    hasRelationship: vi.fn().mockReturnValue(true),
    readRelationships: vi.fn().mockReturnValue(RELATIONSHIP_PAGE),
    snapshot: projection('follows'),
    startBlock: 0n,
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

describe('useFollowReadModel', () => {
  it('does no follow work without a wallet and valid selected scope', () => {
    const synchronize = vi.fn()
    const disconnected = renderHook(() =>
      useFollowReadModel({ status: 'disconnected' }, SELECTED_A, 'following', {
        synchronize,
      }),
    )
    act(() => disconnected.result.current.loadNextRange())

    const provider = { request: vi.fn() } as Eip1193Provider
    const missing = renderHook(() =>
      useFollowReadModel(connectedSession(provider), undefined, 'following', {
        synchronize,
      }),
    )
    act(() => missing.result.current.loadNextRange())
    const missingDirection = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, undefined, {
        synchronize,
      }),
    )
    act(() => missingDirection.result.current.loadNextRange())
    const zero = renderHook(() =>
      useFollowReadModel(
        connectedSession(provider),
        '0x0000000000000000000000000000000000000000',
        'following',
        { synchronize },
      ),
    )
    act(() => zero.result.current.loadNextRange())

    expect(disconnected.result.current.state).toEqual({ phase: 'idle' })
    expect(missing.result.current.state).toEqual({ phase: 'idle' })
    expect(missingDirection.result.current.state).toEqual({ phase: 'idle' })
    expect(zero.result.current.state).toEqual({ phase: 'idle' })
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('performs one exact-scope synchronization per request before opening', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = reader()
    const openProjection = vi.fn().mockResolvedValue(run)
    const { result } = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
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
      SELECTED_A,
      'following',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(openProjection).not.toHaveBeenCalled()

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(openProjection).toHaveBeenCalledWith(ANCHOR)
    expect(run.advance).not.toHaveBeenCalled()
  })

  it('advances one local page per action and publishes only completed reads', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingAdvance = deferred<FollowProjectionRunSnapshot>()
    const getRelationship = vi.fn().mockReturnValue(RELATIONSHIP)
    const hasRelationship = vi.fn().mockReturnValue(true)
    const readRelationships = vi.fn().mockReturnValue(RELATIONSHIP_PAGE)
    const run = reader({
      advance: vi
        .fn()
        .mockReturnValueOnce(pendingAdvance.promise)
        .mockResolvedValueOnce(projection('complete')),
      getRelationship,
      hasRelationship,
      readRelationships,
    })
    const { result } = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
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
    expect(result.current.getRelationship(COUNTERPART)).toBeUndefined()
    expect(result.current.hasRelationship(COUNTERPART)).toBeUndefined()
    expect(result.current.readRelationships()).toBeUndefined()
    await act(async () => pendingAdvance.resolve(projection('authenticate')))
    expect(result.current.state.phase).toBe('projecting')

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))
    const options = { after: COUNTERPART, limit: 20 }
    expect(result.current.getRelationship(COUNTERPART)).toBe(RELATIONSHIP)
    expect(result.current.hasRelationship(COUNTERPART)).toBe(true)
    expect(result.current.readRelationships(options)).toBe(RELATIONSHIP_PAGE)
    expect(getRelationship).toHaveBeenCalledWith(COUNTERPART)
    expect(hasRelationship).toHaveBeenCalledWith(COUNTERPART)
    expect(readRelationships).toHaveBeenCalledWith(options)
    expect(run.advance).toHaveBeenCalledTimes(2)
  })

  it('surfaces synchronization and projection failures for retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC range refused.'))
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = reader({
      advance: vi.fn().mockRejectedValue(new Error('Cache proof changed.')),
    })
    const { result } = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
        openProjection: vi.fn().mockResolvedValue(run),
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
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))
    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'Cache proof changed.',
      phase: 'failed',
      retryable: true,
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('resets only the selected scope after deferred cache corruption', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const resetCache = vi.fn().mockResolvedValue(undefined)
    const run = reader({
      advance: vi
        .fn()
        .mockRejectedValue(new DeferredEventCacheCorruptionError()),
      startBlock: 3_456n,
    })
    const { result } = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
        openProjection: vi.fn().mockResolvedValue(run),
        resetCache,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))

    expect(resetCache).toHaveBeenCalledWith(1n, SELECTED_A, 'following', 3_456n)
    expect(result.current.state).toMatchObject({
      message: expect.stringMatching(/cache was reset.*retry/i),
      phase: 'failed',
      retryable: true,
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('makes failed cache recovery non-retryable in the current page', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = reader({
      advance: vi
        .fn()
        .mockRejectedValue(new DeferredEventCacheCorruptionError()),
    })
    const { result } = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
        openProjection: vi.fn().mockResolvedValue(run),
        resetCache: vi.fn().mockRejectedValue(new Error('IndexedDB denied.')),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))

    expect(result.current.state).toMatchObject({
      message: expect.stringMatching(/IndexedDB denied.*browser data/i),
      phase: 'failed',
      retryable: false,
    })
  })

  it('rejects inconsistent stream and projection scopes before publication', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const openProjection = vi.fn()
    const wrongStream = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
        openProjection,
        synchronize: vi
          .fn()
          .mockResolvedValue(stream(undefined, SELECTED_B, 'following')),
      }),
    )
    act(() => wrongStream.result.current.loadNextRange())
    await waitFor(() =>
      expect(wrongStream.result.current.state.phase).toBe('failed'),
    )
    expect(wrongStream.result.current.state).toMatchObject({
      message: expect.stringMatching(/another selected account or direction/i),
      phase: 'failed',
    })
    expect(openProjection).not.toHaveBeenCalled()

    const wrongRun = reader({
      close: vi.fn(),
      direction: 'followers',
      snapshot: projection('follows', SELECTED_A, 'followers'),
    })
    const mismatchedProjection = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
        openProjection: vi.fn().mockResolvedValue(wrongRun),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => mismatchedProjection.result.current.loadNextRange())
    await waitFor(() =>
      expect(mismatchedProjection.result.current.state.phase).toBe('failed'),
    )
    expect(mismatchedProjection.result.current.state).toMatchObject({
      message: expect.stringMatching(/another selected account or direction/i),
      phase: 'failed',
    })
    expect(wrongRun.close).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an opened projection is already unavailable', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = reader({ snapshot: projection('closed') })
    const { result } = renderHook(() =>
      useFollowReadModel(connectedSession(provider), SELECTED_A, 'following', {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'The local follow relationship projection became unavailable.',
      phase: 'failed',
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('aborts and ignores synchronization from an old chain or direction', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const first = deferred<FollowStreamSnapshot>()
    const second = deferred<FollowStreamSnapshot>()
    const synchronize = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const openProjection = vi.fn()
    const { rerender, result } = renderHook(
      ({ chainId, direction }) =>
        useFollowReadModel(
          connectedSession(provider, chainId),
          SELECTED_A,
          direction,
          { openProjection, synchronize },
        ),
      {
        initialProps: {
          chainId: 1n,
          direction: 'following' as FollowDirection,
        },
      },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]![4].signal as AbortSignal
    rerender({ chainId: 2n, direction: 'following' })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => first.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    const secondSignal = synchronize.mock.calls[1]![4].signal as AbortSignal
    rerender({ chainId: 2n, direction: 'followers' })
    expect(secondSignal.aborted).toBe(true)
    await act(async () => second.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('closes a late run after the selected direction changes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingOpen = deferred<FollowProjectionReader>()
    const openProjection = vi.fn().mockReturnValue(pendingOpen.promise)
    const run = reader()
    const { rerender, result } = renderHook(
      ({ direction }) =>
        useFollowReadModel(connectedSession(provider), SELECTED_A, direction, {
          openProjection,
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        }),
      { initialProps: { direction: 'following' as FollowDirection } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(openProjection).toHaveBeenCalled())
    rerender({ direction: 'followers' })
    await act(async () => pendingOpen.resolve(run))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('closes active state when the provider or selected account changes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const replacementProvider = { request: vi.fn() } as Eip1193Provider
    const firstRun = reader()
    const secondRun = reader({
      account: SELECTED_B,
      snapshot: projection('follows', SELECTED_B),
    })
    const openProjection = vi
      .fn()
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(secondRun)
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream(ANCHOR))
      .mockResolvedValueOnce(
        stream({ ...ANCHOR, account: SELECTED_B }, SELECTED_B, 'following'),
      )
    const { rerender, result } = renderHook(
      ({ account, selectedProvider }) =>
        useFollowReadModel(
          connectedSession(selectedProvider),
          account,
          'following',
          { openProjection, synchronize },
        ),
      { initialProps: { account: SELECTED_A, selectedProvider: provider } },
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ account: SELECTED_B, selectedProvider: provider })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(firstRun.close).toHaveBeenCalledTimes(1)
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ account: SELECTED_B, selectedProvider: replacementProvider })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(secondRun.close).toHaveBeenCalledTimes(1)
    expect(result.current.getRelationship(COUNTERPART)).toBeUndefined()
  })
})
