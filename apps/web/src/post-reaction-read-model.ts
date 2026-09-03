import { useCallback, useEffect, useRef, useState } from 'react'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import {
  openPostReactionProjectionRun,
  type PostReactionProjectionRun,
  type PostReactionProjectionRunSnapshot,
} from './post-reaction-projection-run'
import type { PostReactionSummary } from './post-reaction-projection'
import {
  synchronizePostReactionStream,
  type PostReactionProjectionAnchor,
  type PostReactionStreamSnapshot,
  type PostReactionStreamSynchronizer,
} from './post-reaction-stream'
import type { WalletSession } from './wallet-session'

export type PostReactionProjectionReader = Pick<
  PostReactionProjectionRun,
  'advance' | 'close' | 'getSummary' | 'snapshot'
>

export type PostReactionProjectionOpener = (
  anchor: PostReactionProjectionAnchor,
) => Promise<PostReactionProjectionReader>

export type PostReactionReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: PostReactionStreamSnapshot }
  | {
      busy: boolean
      phase: 'projecting'
      projection: PostReactionProjectionRunSnapshot
    }
  | {
      phase: 'complete'
      projection: PostReactionProjectionRunSnapshot
    }
  | { message: string; phase: 'failed' }

type ScopedReadModelState = {
  chainId: bigint
  provider: Eip1193Provider
  state: PostReactionReadModelState
}

export type UsePostReactionReadModelOptions = {
  openProjection?: PostReactionProjectionOpener
  synchronize?: PostReactionStreamSynchronizer
}

const IDLE_STATE = { phase: 'idle' } as const

function stateForProjection(
  projection: PostReactionProjectionRunSnapshot,
): PostReactionReadModelState {
  if (projection.phase === 'complete') {
    return { phase: 'complete', projection }
  }
  if (
    projection.phase === 'likes' ||
    projection.phase === 'reposts' ||
    projection.phase === 'authenticate'
  ) {
    return { busy: false, phase: 'projecting', projection }
  }
  throw new Error('The local reaction projection became unavailable.')
}

export function usePostReactionReadModel(
  session: WalletSession,
  {
    openProjection = openPostReactionProjectionRun,
    synchronize = synchronizePostReactionStream,
  }: UsePostReactionReadModelOptions = {},
) {
  const [scopedState, setScopedState] = useState<ScopedReadModelState>()
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeRun = useRef<PostReactionProjectionReader | undefined>(undefined)
  const busy = useRef(false)
  const requestSequence = useRef(0)
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
  const provider = session.provider
  const chainId = session.chainId
  const state =
    connected &&
    scopedState !== undefined &&
    scopedState.provider === provider &&
    scopedState.chainId === chainId
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
  }, [chainId, connected, provider])

  const loadNextRange = useCallback(() => {
    if (!connected || provider === undefined || chainId === undefined) return
    if (busy.current) return
    busy.current = true
    const requestId = ++requestSequence.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    activeRun.current?.close()
    activeRun.current = undefined
    setScopedState({
      chainId,
      provider,
      state: { phase: 'synchronizing' },
    })
    let openedRun: PostReactionProjectionReader | undefined
    void (async () => {
      try {
        const stream = await synchronize(provider, chainId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        if (!stream.projectionAnchor) {
          setScopedState({
            chainId,
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
        const projectionState = stateForProjection(openedRun.snapshot)
        activeRun.current = openedRun
        setScopedState({
          chainId,
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
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public reaction history could not be synchronized.',
            ),
            phase: 'failed',
          },
        })
      } finally {
        if (requestSequence.current === requestId) {
          activeController.current = undefined
          busy.current = false
        }
      }
    })()
  }, [chainId, connected, openProjection, provider, synchronize])

  const advanceProjection = useCallback(() => {
    if (
      !connected ||
      provider === undefined ||
      chainId === undefined ||
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
      provider,
      state: { ...state, busy: true },
    })
    void run
      .advance()
      .then((projection) => {
        if (requestSequence.current !== requestId) return
        setScopedState({
          chainId,
          provider,
          state: stateForProjection(projection),
        })
      })
      .catch((error: unknown) => {
        if (requestSequence.current !== requestId) return
        run.close()
        activeRun.current = undefined
        setScopedState({
          chainId,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The local reaction projection could not be completed.',
            ),
            phase: 'failed',
          },
        })
      })
      .finally(() => {
        if (requestSequence.current === requestId) busy.current = false
      })
  }, [chainId, connected, provider, state])

  const getSummary = useCallback(
    (postId: bigint, account?: string): PostReactionSummary | undefined => {
      if (!connected || state.phase !== 'complete') return undefined
      return activeRun.current?.getSummary(postId, account)
    },
    [connected, state.phase],
  )

  return { advanceProjection, getSummary, loadNextRange, state }
}
