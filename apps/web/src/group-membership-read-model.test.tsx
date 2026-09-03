import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { Eip1193Provider } from './ethereum'
import { DeferredEventCacheCorruptionError } from './event-cache'
import type { GroupMembershipProjectionReadPage } from './group-membership-projection'
import {
  useGroupMembershipReadModel,
  type GroupMembershipProjectionReader,
} from './group-membership-read-model'
import type { GroupMembershipProjectionRunSnapshot } from './group-membership-projection-run'
import type {
  GroupMembershipProjectionAnchor,
  GroupMembershipStreamSnapshot,
} from './group-membership-stream'
import type { GroupMembershipSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c' as Address
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb' as Address
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const GROUP_A = 17n
const GROUP_B = 18n
const ANCHOR = {
  chainId: 1n,
  groupId: GROUP_A,
  head: 20n,
  safeHead: 8n,
} as GroupMembershipProjectionAnchor
const MEMBER = {
  account: ACCOUNT,
  blockHash: BLOCK_HASH,
  blockNumber: 3n,
  groupId: GROUP_A,
  joined: true,
  logIndex: 0,
  transactionHash: TRANSACTION_HASH,
  transactionIndex: 0,
} satisfies GroupMembershipSet
const MEMBER_PAGE = {
  complete: true,
  members: [MEMBER],
  totalMembers: 1n,
} satisfies GroupMembershipProjectionReadPage

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
  projectionAnchor?: GroupMembershipProjectionAnchor,
  groupId = GROUP_A,
): GroupMembershipStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    groupId,
    head: 20n,
    indexedThrough: 8n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentSignals: [],
    safeHead: 8n,
    scannedRanges: 1,
  }
}

function projection(
  phase: GroupMembershipProjectionRunSnapshot['phase'],
  groupId = GROUP_A,
  chainId = 1n,
): GroupMembershipProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    chainId,
    groupId,
    head: 20n,
    logsProcessed: complete ? 3n : 1n,
    membersRetained: complete ? 1n : 0n,
    pagesScanned: 1n,
    phase,
    safeHead: 8n,
  }
}

function reader(
  overrides: Partial<GroupMembershipProjectionReader> = {},
): GroupMembershipProjectionReader {
  return {
    advance: vi.fn(),
    close: vi.fn(),
    getMember: vi.fn().mockReturnValue(MEMBER),
    groupId: GROUP_A,
    isMember: vi.fn().mockReturnValue(true),
    readMembers: vi.fn().mockReturnValue(MEMBER_PAGE),
    snapshot: projection('memberships'),
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

describe('useGroupMembershipReadModel', () => {
  it('does no membership work without a wallet and valid selected group', () => {
    const synchronize = vi.fn()
    const disconnected = renderHook(() =>
      useGroupMembershipReadModel({ status: 'disconnected' }, GROUP_A, {
        synchronize,
      }),
    )
    act(() => disconnected.result.current.loadNextRange())

    const provider = { request: vi.fn() } as Eip1193Provider
    const missing = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), undefined, {
        synchronize,
      }),
    )
    act(() => missing.result.current.loadNextRange())
    const zero = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), 0n, {
        synchronize,
      }),
    )
    act(() => zero.result.current.loadNextRange())

    expect(disconnected.result.current.state).toEqual({ phase: 'idle' })
    expect(missing.result.current.state).toEqual({ phase: 'idle' })
    expect(zero.result.current.state).toEqual({ phase: 'idle' })
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('performs one exact-group synchronization per request before opening', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = reader()
    const openProjection = vi.fn().mockResolvedValue(run)
    const { result } = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
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
      GROUP_A,
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
    const pendingAdvance = deferred<GroupMembershipProjectionRunSnapshot>()
    const getMember = vi.fn().mockReturnValue(MEMBER)
    const isMember = vi.fn().mockReturnValue(true)
    const readMembers = vi.fn().mockReturnValue(MEMBER_PAGE)
    const run = reader({
      advance: vi
        .fn()
        .mockReturnValueOnce(pendingAdvance.promise)
        .mockResolvedValueOnce(projection('complete')),
      getMember,
      isMember,
      readMembers,
    })
    const { result } = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
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
    expect(result.current.getMember(ACCOUNT)).toBeUndefined()
    expect(result.current.isMember(ACCOUNT)).toBeUndefined()
    expect(result.current.readMembers()).toBeUndefined()
    await act(async () => pendingAdvance.resolve(projection('authenticate')))
    expect(result.current.state.phase).toBe('projecting')

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('complete'))
    const options = { after: ACCOUNT, limit: 20 }
    expect(result.current.getMember(ACCOUNT)).toBe(MEMBER)
    expect(result.current.isMember(ACCOUNT)).toBe(true)
    expect(result.current.readMembers(options)).toBe(MEMBER_PAGE)
    expect(getMember).toHaveBeenCalledWith(ACCOUNT)
    expect(isMember).toHaveBeenCalledWith(ACCOUNT)
    expect(readMembers).toHaveBeenCalledWith(options)
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
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
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
    })
    const { result } = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
        openProjection: vi.fn().mockResolvedValue(run),
        resetCache,
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    act(() => result.current.advanceProjection())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))

    expect(resetCache).toHaveBeenCalledWith(1n, GROUP_A)
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
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
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
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
        openProjection,
        synchronize: vi.fn().mockResolvedValue(stream(undefined, GROUP_B)),
      }),
    )
    act(() => wrongStream.result.current.loadNextRange())
    await waitFor(() =>
      expect(wrongStream.result.current.state.phase).toBe('failed'),
    )
    expect(wrongStream.result.current.state).toMatchObject({
      message: expect.stringMatching(/another selected group/i),
      phase: 'failed',
    })
    expect(openProjection).not.toHaveBeenCalled()

    const wrongRun = reader({
      close: vi.fn(),
      groupId: GROUP_B,
      snapshot: projection('memberships', GROUP_B),
    })
    const mismatchedProjection = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
        openProjection: vi.fn().mockResolvedValue(wrongRun),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )
    act(() => mismatchedProjection.result.current.loadNextRange())
    await waitFor(() =>
      expect(mismatchedProjection.result.current.state.phase).toBe('failed'),
    )
    expect(mismatchedProjection.result.current.state).toMatchObject({
      message: expect.stringMatching(/another selected group/i),
      phase: 'failed',
    })
    expect(wrongRun.close).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an opened projection is already unavailable', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const run = reader({ snapshot: projection('closed') })
    const { result } = renderHook(() =>
      useGroupMembershipReadModel(connectedSession(provider), GROUP_A, {
        openProjection: vi.fn().mockResolvedValue(run),
        synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
      }),
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state).toMatchObject({
      message: 'The local membership projection became unavailable.',
      phase: 'failed',
    })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('aborts and ignores synchronization from an old chain or group', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const first = deferred<GroupMembershipStreamSnapshot>()
    const second = deferred<GroupMembershipStreamSnapshot>()
    const synchronize = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const openProjection = vi.fn()
    const { rerender, result } = renderHook(
      ({ chainId, groupId }) =>
        useGroupMembershipReadModel(
          connectedSession(provider, chainId),
          groupId,
          { openProjection, synchronize },
        ),
      { initialProps: { chainId: 1n, groupId: GROUP_A } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]![3].signal as AbortSignal
    rerender({ chainId: 2n, groupId: GROUP_A })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => first.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    const secondSignal = synchronize.mock.calls[1]![3].signal as AbortSignal
    rerender({ chainId: 2n, groupId: GROUP_B })
    expect(secondSignal.aborted).toBe(true)
    await act(async () => second.resolve(stream(ANCHOR)))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(openProjection).not.toHaveBeenCalled()
  })

  it('closes a late run after the selected group changes', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingOpen = deferred<GroupMembershipProjectionReader>()
    const openProjection = vi.fn().mockReturnValue(pendingOpen.promise)
    const run = reader()
    const { rerender, result } = renderHook(
      ({ groupId }) =>
        useGroupMembershipReadModel(connectedSession(provider), groupId, {
          openProjection,
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        }),
      { initialProps: { groupId: GROUP_A } },
    )

    act(() => result.current.loadNextRange())
    await waitFor(() => expect(openProjection).toHaveBeenCalled())
    rerender({ groupId: GROUP_B })
    await act(async () => pendingOpen.resolve(run))
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(run.close).toHaveBeenCalledTimes(1)
  })

  it('closes active state when the wallet or selected group is left', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const firstRun = reader()
    const secondRun = reader({
      groupId: GROUP_B,
      snapshot: projection('memberships', GROUP_B),
    })
    const openProjection = vi
      .fn()
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(secondRun)
    const synchronize = vi
      .fn()
      .mockResolvedValueOnce(stream(ANCHOR))
      .mockResolvedValueOnce(stream({ ...ANCHOR, groupId: GROUP_B }, GROUP_B))
    const { rerender, result } = renderHook(
      ({ chainId, groupId }) =>
        useGroupMembershipReadModel(
          connectedSession(provider, chainId),
          groupId,
          { openProjection, synchronize },
        ),
      { initialProps: { chainId: 1n, groupId: GROUP_A } },
    )
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ chainId: 1n, groupId: GROUP_B })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(firstRun.close).toHaveBeenCalledTimes(1)
    act(() => result.current.loadNextRange())
    await waitFor(() => expect(result.current.state.phase).toBe('projecting'))

    rerender({ chainId: 2n, groupId: GROUP_B })
    expect(result.current.state).toEqual({ phase: 'idle' })
    expect(secondRun.close).toHaveBeenCalledTimes(1)
    expect(result.current.getMember(OTHER_ACCOUNT)).toBeUndefined()
  })
})
