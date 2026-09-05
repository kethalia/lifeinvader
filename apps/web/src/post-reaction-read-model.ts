import { useCallback, useEffect, useRef, useState } from 'react'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { isDeferredEventCacheCorruptionError } from './event-cache'
import type { PostReactionSummary } from './post-reaction-projection'
import {
  openPostReactionProjectionRun,
  type PostReactionProjectionResumeState,
  type PostReactionProjectionRun,
  type PostReactionProjectionRunSnapshot,
} from './post-reaction-projection-run'
import {
  createPostReactionResumeStore,
  type PostReactionResumeStore,
} from './post-reaction-resume-store'
import {
  resetPostReactionStreamCache,
  synchronizePostReactionStream,
  type PostReactionProjectionAnchor,
  type PostReactionStreamCacheResetter,
  type PostReactionStreamSnapshot,
  type PostReactionStreamSynchronizer,
} from './post-reaction-stream'
import type { WalletSession } from './wallet-session'

export type PostReactionProjectionReader = Pick<
  PostReactionProjectionRun,
  'advance' | 'close' | 'getSummary' | 'resumeState' | 'snapshot'
>

export type PostReactionProjectionOpener = (
  anchor: PostReactionProjectionAnchor,
  resume?: PostReactionProjectionResumeState,
) => Promise<PostReactionProjectionReader>

export type PostReactionReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: PostReactionStreamSnapshot }
  | {
      busy: boolean
      notice?: string
      phase: 'projecting'
      projection: PostReactionProjectionRunSnapshot
      resumed: boolean
    }
  | {
      notice?: string
      phase: 'complete'
      projection: PostReactionProjectionRunSnapshot
      resumeSaved: boolean
      resumed: boolean
    }
  | { message: string; phase: 'failed'; retryable: boolean }

type ScopedReadModelState = {
  chainId: bigint
  provider: Eip1193Provider
  state: PostReactionReadModelState
}

type ActiveProjection = {
  notice?: string
  resumed: boolean
  run: PostReactionProjectionReader
}

export type UsePostReactionReadModelOptions = {
  openProjection?: PostReactionProjectionOpener
  resetCache?: PostReactionStreamCacheResetter
  resumeStore?: PostReactionResumeStore
  synchronize?: PostReactionStreamSynchronizer
}

const IDLE_STATE = { phase: 'idle' } as const
const defaultResumeStore = createPostReactionResumeStore()

const defaultProjectionOpener: PostReactionProjectionOpener = (
  anchor,
  resume,
) => openPostReactionProjectionRun(anchor, { resume })

const defaultCacheResetter: PostReactionStreamCacheResetter = (
  chainId,
  startBlock,
) => resetPostReactionStreamCache(chainId, {}, startBlock)

function stateForProjection(
  projection: PostReactionProjectionRunSnapshot,
  resumed: boolean,
  notice?: string,
): PostReactionReadModelState {
  if (
    projection.phase === 'likes' ||
    projection.phase === 'reposts' ||
    projection.phase === 'authenticate'
  ) {
    return {
      busy: false,
      notice,
      phase: 'projecting',
      projection,
      resumed,
    }
  }
  throw new Error('The local reaction projection became unavailable.')
}

export function usePostReactionReadModel(
  session: WalletSession,
  {
    openProjection = defaultProjectionOpener,
    resetCache = defaultCacheResetter,
    resumeStore = defaultResumeStore,
    synchronize = synchronizePostReactionStream,
  }: UsePostReactionReadModelOptions = {},
) {
  const [scopedState, setScopedState] = useState<ScopedReadModelState>()
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeProjection = useRef<ActiveProjection | undefined>(undefined)
  const busy = useRef(false)
  const ignoreSavedResume = useRef(false)
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
    activeProjection.current?.run.close()
    activeProjection.current = undefined
    busy.current = false
    ignoreSavedResume.current = false
    setScopedState(undefined)
    return () => {
      requestSequence.current += 1
      activeController.current?.abort()
      activeController.current = undefined
      activeProjection.current?.run.close()
      activeProjection.current = undefined
      busy.current = false
      ignoreSavedResume.current = false
    }
  }, [chainId, connected, provider])

  const publishCompletedRun = useCallback(
    async (
      active: ActiveProjection,
      projection: PostReactionProjectionRunSnapshot,
      context: {
        chainId: bigint
        provider: Eip1193Provider
        requestId: number
      },
    ) => {
      const { chainId, provider, requestId } = context
      const resume = active.run.resumeState
      let notice = active.notice
      let resumeSaved = true
      try {
        await resumeStore.save(chainId, resume)
      } catch {
        resumeSaved = false
        notice =
          'Confirmed reaction totals are available, but resumable local progress could not be saved.'
      }
      if (requestSequence.current !== requestId) return
      if (resumeSaved) ignoreSavedResume.current = false
      setScopedState({
        chainId,
        provider,
        state: {
          notice,
          phase: 'complete',
          projection,
          resumeSaved,
          resumed: active.resumed,
        },
      })
    },
    [resumeStore],
  )

  const loadNextRange = useCallback(() => {
    if (
      !connected ||
      provider === undefined ||
      chainId === undefined ||
      busy.current
    ) {
      return
    }
    busy.current = true
    const requestId = ++requestSequence.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    activeProjection.current?.run.close()
    activeProjection.current = undefined
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
        let notice: string | undefined
        let resume: PostReactionProjectionResumeState | undefined
        let resumeReadFailed = false
        if (ignoreSavedResume.current) {
          notice =
            'Previously rejected reaction progress is being bypassed while the canonical projection is rebuilt.'
        } else {
          try {
            resume = await resumeStore.load(chainId)
          } catch {
            resumeReadFailed = true
            notice =
              'Saved reaction progress was unreadable and will not be trusted. Rebuilding from canonical events.'
            try {
              await resumeStore.remove(chainId)
            } catch {
              // A disposable acceleration cache may be unavailable. A fresh
              // projection remains correct without it.
            }
          }
        }
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        if (resumeReadFailed) ignoreSavedResume.current = true
        let resumed = resume !== undefined
        try {
          openedRun = await openProjection(stream.projectionAnchor, resume)
        } catch (error) {
          if (!resume) throw error
          ignoreSavedResume.current = true
          notice =
            'Saved reaction progress no longer matched the authenticated event caches. It was discarded and rebuilt.'
          try {
            await resumeStore.remove(chainId)
          } catch {
            // The invalid tuple has already been rejected by the projection.
          }
          if (
            controller.signal.aborted ||
            requestSequence.current !== requestId
          ) {
            return
          }
          resumed = false
          openedRun = await openProjection(stream.projectionAnchor)
        }
        if (
          controller.signal.aborted ||
          requestSequence.current !== requestId
        ) {
          openedRun.close()
          openedRun = undefined
          return
        }
        const active = { notice, resumed, run: openedRun }
        activeProjection.current = active
        openedRun = undefined
        if (active.run.snapshot.phase === 'complete') {
          await publishCompletedRun(active, active.run.snapshot, {
            chainId,
            provider,
            requestId,
          })
        } else {
          setScopedState({
            chainId,
            provider,
            state: stateForProjection(active.run.snapshot, resumed, notice),
          })
        }
      } catch (error) {
        openedRun?.close()
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        activeProjection.current?.run.close()
        activeProjection.current = undefined
        setScopedState({
          chainId,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public reaction history could not be synchronized.',
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
    chainId,
    connected,
    openProjection,
    provider,
    publishCompletedRun,
    resumeStore,
    synchronize,
  ])

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
    const active = activeProjection.current
    if (!active) return
    busy.current = true
    const requestId = ++requestSequence.current
    setScopedState({
      chainId,
      provider,
      state: { ...state, busy: true },
    })
    void active.run
      .advance()
      .then(async (projection) => {
        if (requestSequence.current !== requestId) return
        if (projection.phase === 'complete') {
          await publishCompletedRun(active, projection, {
            chainId,
            provider,
            requestId,
          })
          return
        }
        setScopedState({
          chainId,
          provider,
          state: stateForProjection(projection, active.resumed, active.notice),
        })
      })
      .catch(async (error: unknown) => {
        if (requestSequence.current !== requestId) return
        const startBlock = active.run.snapshot.startBlock
        active.run.close()
        activeProjection.current = undefined
        let message = describeRpcError(
          error,
          'The local reaction projection could not be completed.',
        )
        let retryable = true
        if (isDeferredEventCacheCorruptionError(error)) {
          try {
            await resetCache(chainId, startBlock)
            if (requestSequence.current !== requestId) return
            ignoreSavedResume.current = true
            try {
              await resumeStore.remove(chainId)
            } catch {
              // A stale resume is independently rejected on the next open.
            }
            message =
              'The corrupt local reaction caches were reset. Retry to rebuild them from confirmed chain events.'
          } catch (resetError) {
            const detail = describeRpcError(
              resetError,
              'The corrupt local reaction caches could not be reset.',
            )
            message = `${detail} Clear this site’s browser data and reload.`
            retryable = false
          }
        }
        if (requestSequence.current !== requestId) return
        setScopedState({
          chainId,
          provider,
          state: { message, phase: 'failed', retryable },
        })
      })
      .finally(() => {
        if (requestSequence.current === requestId) busy.current = false
      })
  }, [
    chainId,
    connected,
    provider,
    publishCompletedRun,
    resetCache,
    resumeStore,
    state,
  ])

  const getSummary = useCallback(
    (postId: bigint, account?: string): PostReactionSummary | undefined => {
      if (!connected || state.phase !== 'complete') return undefined
      return activeProjection.current?.run.getSummary(postId, account)
    },
    [connected, state.phase],
  )

  return { advanceProjection, getSummary, loadNextRange, state }
}
