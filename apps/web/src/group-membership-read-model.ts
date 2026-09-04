import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { isDeferredEventCacheCorruptionError } from './event-cache'
import type {
  GroupMembershipProjectionReadOptions,
  GroupMembershipProjectionReadPage,
} from './group-membership-projection'
import {
  openGroupMembershipProjectionRun,
  type GroupMembershipProjectionRun,
  type GroupMembershipProjectionRunSnapshot,
} from './group-membership-projection-run'
import {
  resetGroupMembershipStreamCache,
  synchronizeGroupMembershipStream,
  type GroupMembershipProjectionAnchor,
  type GroupMembershipStreamSnapshot,
  type GroupMembershipStreamSynchronizer,
} from './group-membership-stream'
import type { GroupMembershipSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

export type GroupMembershipProjectionReader = Pick<
  GroupMembershipProjectionRun,
  | 'advance'
  | 'close'
  | 'getMember'
  | 'groupId'
  | 'isMember'
  | 'readMembers'
  | 'snapshot'
  | 'startBlock'
>

export type GroupMembershipProjectionOpener = (
  anchor: GroupMembershipProjectionAnchor,
) => Promise<GroupMembershipProjectionReader>

export type GroupMembershipCacheResetter = (
  chainId: bigint,
  groupId: bigint,
  startBlock: bigint,
) => Promise<void>

export type GroupMembershipReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: GroupMembershipStreamSnapshot }
  | {
      busy: boolean
      phase: 'projecting'
      projection: GroupMembershipProjectionRunSnapshot
    }
  | {
      phase: 'complete'
      projection: GroupMembershipProjectionRunSnapshot
    }
  | { message: string; phase: 'failed'; retryable: boolean }

type ScopedReadModelState = {
  chainId: bigint
  groupId: bigint
  provider: Eip1193Provider
  state: GroupMembershipReadModelState
}

export type UseGroupMembershipReadModelOptions = {
  openProjection?: GroupMembershipProjectionOpener
  resetCache?: GroupMembershipCacheResetter
  synchronize?: GroupMembershipStreamSynchronizer
}

const IDLE_STATE = { phase: 'idle' } as const

function isGroupId(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 1n && value <= MAX_EVM_QUANTITY
}

function assertStreamScope(
  stream: GroupMembershipStreamSnapshot,
  chainId: bigint,
  groupId: bigint,
) {
  if (stream.groupId !== groupId) {
    throw new Error(
      'The public membership stream belongs to another selected group.',
    )
  }
  const anchor = stream.projectionAnchor
  if (stream.caughtUp !== (anchor !== undefined)) {
    throw new Error('The public membership stream has an invalid boundary.')
  }
  if (
    anchor &&
    (anchor.chainId !== chainId ||
      anchor.groupId !== groupId ||
      anchor.head !== stream.head ||
      anchor.safeHead !== stream.safeHead ||
      anchor.memberships.cursor.startBlock !== stream.startBlock)
  ) {
    throw new Error(
      'The public membership projection belongs to another chain boundary.',
    )
  }
}

function stateForProjection(
  projection: GroupMembershipProjectionRunSnapshot,
  chainId: bigint,
  groupId: bigint,
  startBlock: bigint,
): GroupMembershipReadModelState {
  if (
    projection.chainId !== chainId ||
    projection.groupId !== groupId ||
    projection.startBlock !== startBlock
  ) {
    throw new Error(
      'The local membership projection belongs to another selected history boundary.',
    )
  }
  if (projection.phase === 'complete') {
    return { phase: 'complete', projection }
  }
  if (
    projection.phase === 'memberships' ||
    projection.phase === 'authenticate'
  ) {
    return { busy: false, phase: 'projecting', projection }
  }
  throw new Error('The local membership projection became unavailable.')
}

const defaultProjectionOpener: GroupMembershipProjectionOpener = (anchor) =>
  openGroupMembershipProjectionRun(anchor)

const defaultCacheResetter: GroupMembershipCacheResetter = (
  chainId,
  groupId,
  startBlock,
) => resetGroupMembershipStreamCache(chainId, groupId, {}, startBlock)

export function useGroupMembershipReadModel(
  session: WalletSession,
  groupIdValue?: bigint,
  {
    openProjection = defaultProjectionOpener,
    resetCache = defaultCacheResetter,
    synchronize = synchronizeGroupMembershipStream,
  }: UseGroupMembershipReadModelOptions = {},
) {
  const [scopedState, setScopedState] = useState<ScopedReadModelState>()
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeRun = useRef<GroupMembershipProjectionReader | undefined>(
    undefined,
  )
  const busy = useRef(false)
  const requestSequence = useRef(0)
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
  const provider = session.provider
  const chainId = session.chainId
  const groupId = isGroupId(groupIdValue) ? groupIdValue : undefined
  const readable = connected && groupId !== undefined
  const state =
    readable &&
    scopedState !== undefined &&
    scopedState.provider === provider &&
    scopedState.chainId === chainId &&
    scopedState.groupId === groupId
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
  }, [chainId, connected, groupId, provider])

  const loadNextRange = useCallback(() => {
    if (
      !readable ||
      provider === undefined ||
      chainId === undefined ||
      groupId === undefined ||
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
      chainId,
      groupId,
      provider,
      state: { phase: 'synchronizing' },
    })
    let openedRun: GroupMembershipProjectionReader | undefined
    void (async () => {
      try {
        const stream = await synchronize(provider, chainId, groupId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        assertStreamScope(stream, chainId, groupId)
        if (!stream.projectionAnchor) {
          setScopedState({
            chainId,
            groupId,
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
          openedRun.groupId !== groupId ||
          openedRun.startBlock !== stream.startBlock
        ) {
          throw new Error(
            'The local membership projection belongs to another selected group or history boundary.',
          )
        }
        const projectionState = stateForProjection(
          openedRun.snapshot,
          chainId,
          groupId,
          stream.startBlock,
        )
        activeRun.current = openedRun
        setScopedState({
          chainId,
          groupId,
          provider,
          state: projectionState,
        })
        openedRun = undefined
      } catch (error) {
        openedRun?.close()
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        setScopedState({
          chainId,
          groupId,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public group membership could not be synchronized.',
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
  }, [chainId, groupId, openProjection, provider, readable, synchronize])

  const advanceProjection = useCallback(() => {
    if (
      !readable ||
      provider === undefined ||
      chainId === undefined ||
      groupId === undefined ||
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
      chainId,
      groupId,
      provider,
      state: { ...state, busy: true },
    })
    void run
      .advance()
      .then((projection) => {
        if (requestSequence.current !== requestId) return
        setScopedState({
          chainId,
          groupId,
          provider,
          state: stateForProjection(
            projection,
            chainId,
            groupId,
            state.projection.startBlock,
          ),
        })
      })
      .catch(async (error: unknown) => {
        if (requestSequence.current !== requestId) return
        const startBlock = run.startBlock
        run.close()
        activeRun.current = undefined
        let message = describeRpcError(
          error,
          'The local membership projection could not be completed.',
        )
        let retryable = true
        if (isDeferredEventCacheCorruptionError(error)) {
          try {
            await resetCache(chainId, groupId, startBlock)
            if (requestSequence.current !== requestId) return
            message =
              'The corrupt local membership cache was reset. Retry to rebuild it from confirmed chain events.'
          } catch (resetError) {
            if (requestSequence.current !== requestId) return
            const detail = describeRpcError(
              resetError,
              'The corrupt local membership cache could not be reset.',
            )
            message = `${detail} Clear this site’s browser data and reload.`
            retryable = false
          }
        }
        if (requestSequence.current !== requestId) return
        setScopedState({
          chainId,
          groupId,
          provider,
          state: { message, phase: 'failed', retryable },
        })
      })
      .finally(() => {
        if (requestSequence.current === requestId) busy.current = false
      })
  }, [chainId, groupId, provider, readable, resetCache, state])

  const getMember = useCallback(
    (account: Address): GroupMembershipSet | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.getMember(account)
    },
    [readable, state.phase],
  )

  const isMember = useCallback(
    (account: Address): boolean | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.isMember(account)
    },
    [readable, state.phase],
  )

  const readMembers = useCallback(
    (
      options?: GroupMembershipProjectionReadOptions,
    ): GroupMembershipProjectionReadPage | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.readMembers(options)
    },
    [readable, state.phase],
  )

  return {
    advanceProjection,
    getMember,
    isMember,
    loadNextRange,
    readMembers,
    state,
  }
}
