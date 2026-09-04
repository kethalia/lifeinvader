import { useCallback, useEffect, useRef, useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { isDeferredEventCacheCorruptionError } from './event-cache'
import type {
  FollowDirection,
  FollowProjectionReadOptions,
  FollowProjectionReadPage,
} from './follow-projection'
import {
  openFollowProjectionRun,
  type FollowProjectionRun,
  type FollowProjectionRunSnapshot,
} from './follow-projection-run'
import {
  resetFollowStreamCache,
  synchronizeFollowStream,
  type FollowProjectionAnchor,
  type FollowStreamSnapshot,
  type FollowStreamSynchronizer,
} from './follow-stream'
import type { FollowSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type FollowProjectionReader = Pick<
  FollowProjectionRun,
  | 'advance'
  | 'account'
  | 'close'
  | 'direction'
  | 'getRelationship'
  | 'hasRelationship'
  | 'readRelationships'
  | 'snapshot'
>

export type FollowProjectionOpener = (
  anchor: FollowProjectionAnchor,
) => Promise<FollowProjectionReader>

export type FollowCacheResetter = (
  chainId: bigint,
  account: Address,
  direction: FollowDirection,
) => Promise<void>

export type FollowReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: FollowStreamSnapshot }
  | {
      busy: boolean
      phase: 'projecting'
      projection: FollowProjectionRunSnapshot
    }
  | {
      phase: 'complete'
      projection: FollowProjectionRunSnapshot
    }
  | { message: string; phase: 'failed'; retryable: boolean }

type ScopedReadModelState = {
  account: Address
  chainId: bigint
  direction: FollowDirection
  provider: Eip1193Provider
  state: FollowReadModelState
}

export type UseFollowReadModelOptions = {
  openProjection?: FollowProjectionOpener
  resetCache?: FollowCacheResetter
  synchronize?: FollowStreamSynchronizer
}

const IDLE_STATE = { phase: 'idle' } as const

function normalizeAccount(value: unknown) {
  if (typeof value !== 'string' || !isAddress(value)) return undefined
  const account = getAddress(value)
  return account.toLowerCase() === ZERO_ADDRESS ? undefined : account
}

function normalizeDirection(value: unknown): FollowDirection | undefined {
  return value === 'followers' || value === 'following' ? value : undefined
}

function sameAccount(first: Address, second: Address) {
  return first.toLowerCase() === second.toLowerCase()
}

function assertStreamScope(
  stream: FollowStreamSnapshot,
  chainId: bigint,
  account: Address,
  direction: FollowDirection,
) {
  if (!sameAccount(stream.account, account) || stream.direction !== direction) {
    throw new Error(
      'The public follow stream belongs to another selected account or direction.',
    )
  }
  const anchor = stream.projectionAnchor
  if (stream.caughtUp !== (anchor !== undefined)) {
    throw new Error(
      'The public follow relationship stream has an invalid boundary.',
    )
  }
  if (
    anchor &&
    (anchor.chainId !== chainId ||
      !sameAccount(anchor.account, account) ||
      anchor.direction !== direction ||
      anchor.head !== stream.head ||
      anchor.safeHead !== stream.safeHead)
  ) {
    throw new Error(
      'The public follow relationship projection belongs to another chain boundary.',
    )
  }
}

function stateForProjection(
  projection: FollowProjectionRunSnapshot,
  chainId: bigint,
  account: Address,
  direction: FollowDirection,
): FollowReadModelState {
  if (
    projection.chainId !== chainId ||
    !sameAccount(projection.account, account) ||
    projection.direction !== direction
  ) {
    throw new Error(
      'The local follow projection belongs to another selected account or direction.',
    )
  }
  if (projection.phase === 'complete') {
    return { phase: 'complete', projection }
  }
  if (projection.phase === 'follows' || projection.phase === 'authenticate') {
    return { busy: false, phase: 'projecting', projection }
  }
  throw new Error(
    'The local follow relationship projection became unavailable.',
  )
}

const defaultProjectionOpener: FollowProjectionOpener = (anchor) =>
  openFollowProjectionRun(anchor)

const defaultCacheResetter: FollowCacheResetter = (
  chainId,
  account,
  direction,
) => resetFollowStreamCache(chainId, account, direction)

export function useFollowReadModel(
  session: WalletSession,
  accountValue?: Address,
  directionValue?: FollowDirection,
  {
    openProjection = defaultProjectionOpener,
    resetCache = defaultCacheResetter,
    synchronize = synchronizeFollowStream,
  }: UseFollowReadModelOptions = {},
) {
  const [scopedState, setScopedState] = useState<ScopedReadModelState>()
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeRun = useRef<FollowProjectionReader | undefined>(undefined)
  const busy = useRef(false)
  const requestSequence = useRef(0)
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
  const provider = session.provider
  const chainId = session.chainId
  const account = normalizeAccount(accountValue)
  const direction = normalizeDirection(directionValue)
  const readable = connected && account !== undefined && direction !== undefined
  const state =
    readable &&
    scopedState !== undefined &&
    scopedState.provider === provider &&
    scopedState.chainId === chainId &&
    sameAccount(scopedState.account, account) &&
    scopedState.direction === direction
      ? scopedState.state
      : IDLE_STATE

  useEffect(() => {
    requestSequence.current += 1
    activeController.current?.abort()
    activeController.current = undefined
    activeRun.current?.close()
    activeRun.current = undefined
    busy.current = false
    setScopedState(undefined)
    return () => {
      requestSequence.current += 1
      activeController.current?.abort()
      activeController.current = undefined
      activeRun.current?.close()
      activeRun.current = undefined
      busy.current = false
    }
  }, [account, chainId, connected, direction, provider])

  const loadNextRange = useCallback(() => {
    if (
      !readable ||
      provider === undefined ||
      chainId === undefined ||
      account === undefined ||
      direction === undefined ||
      busy.current
    ) {
      return
    }
    busy.current = true
    const requestId = ++requestSequence.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    activeRun.current?.close()
    activeRun.current = undefined
    setScopedState({
      account,
      chainId,
      direction,
      provider,
      state: { phase: 'synchronizing' },
    })
    let openedRun: FollowProjectionReader | undefined
    void (async () => {
      try {
        const stream = await synchronize(
          provider,
          chainId,
          account,
          direction,
          { signal: controller.signal },
        )
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        assertStreamScope(stream, chainId, account, direction)
        if (!stream.projectionAnchor) {
          setScopedState({
            account,
            chainId,
            direction,
            provider,
            state: { phase: 'catchup', stream },
          })
          return
        }
        openedRun = await openProjection(stream.projectionAnchor)
        if (
          controller.signal.aborted ||
          requestSequence.current !== requestId
        ) {
          openedRun.close()
          openedRun = undefined
          return
        }
        if (
          !sameAccount(openedRun.account, account) ||
          openedRun.direction !== direction
        ) {
          throw new Error(
            'The local follow projection belongs to another selected account or direction.',
          )
        }
        const projectionState = stateForProjection(
          openedRun.snapshot,
          chainId,
          account,
          direction,
        )
        activeRun.current = openedRun
        setScopedState({
          account,
          chainId,
          direction,
          provider,
          state: projectionState,
        })
        openedRun = undefined
      } catch (error) {
        openedRun?.close()
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        setScopedState({
          account,
          chainId,
          direction,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public follow could not be synchronized.',
            ),
            phase: 'failed',
            retryable: true,
          },
        })
      } finally {
        if (requestSequence.current === requestId) {
          activeController.current = undefined
          busy.current = false
        }
      }
    })()
  }, [
    account,
    chainId,
    direction,
    openProjection,
    provider,
    readable,
    synchronize,
  ])

  const advanceProjection = useCallback(() => {
    if (
      !readable ||
      provider === undefined ||
      chainId === undefined ||
      account === undefined ||
      direction === undefined ||
      state.phase !== 'projecting' ||
      busy.current
    ) {
      return
    }
    const run = activeRun.current
    if (!run) return
    busy.current = true
    const requestId = ++requestSequence.current
    setScopedState({
      account,
      chainId,
      direction,
      provider,
      state: { ...state, busy: true },
    })
    void run
      .advance()
      .then((projection) => {
        if (requestSequence.current !== requestId) return
        setScopedState({
          account,
          chainId,
          direction,
          provider,
          state: stateForProjection(projection, chainId, account, direction),
        })
      })
      .catch(async (error: unknown) => {
        if (requestSequence.current !== requestId) return
        run.close()
        activeRun.current = undefined
        let message = describeRpcError(
          error,
          'The local follow relationship projection could not be completed.',
        )
        let retryable = true
        if (isDeferredEventCacheCorruptionError(error)) {
          try {
            await resetCache(chainId, account, direction)
            if (requestSequence.current !== requestId) return
            message =
              'The corrupt local follow relationship cache was reset. Retry to rebuild it from confirmed chain events.'
          } catch (resetError) {
            if (requestSequence.current !== requestId) return
            const detail = describeRpcError(
              resetError,
              'The corrupt local follow relationship cache could not be reset.',
            )
            message = `${detail} Clear this site’s browser data and reload.`
            retryable = false
          }
        }
        if (requestSequence.current !== requestId) return
        setScopedState({
          account,
          chainId,
          direction,
          provider,
          state: { message, phase: 'failed', retryable },
        })
      })
      .finally(() => {
        if (requestSequence.current === requestId) busy.current = false
      })
  }, [account, chainId, direction, provider, readable, resetCache, state])

  const getRelationship = useCallback(
    (counterpart: Address): FollowSet | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.getRelationship(counterpart)
    },
    [readable, state.phase],
  )

  const hasRelationship = useCallback(
    (counterpart: Address): boolean | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.hasRelationship(counterpart)
    },
    [readable, state.phase],
  )

  const readRelationships = useCallback(
    (
      options?: FollowProjectionReadOptions,
    ): FollowProjectionReadPage | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.readRelationships(options)
    },
    [readable, state.phase],
  )

  return {
    advanceProjection,
    getRelationship,
    hasRelationship,
    loadNextRange,
    readRelationships,
    state,
  }
}
