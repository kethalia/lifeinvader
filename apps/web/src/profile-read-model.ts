import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { isDeferredEventCacheCorruptionError } from './event-cache'
import {
  openProfileProjectionRun,
  type ProfileProjectionResumeState,
  type ProfileProjectionRun,
  type ProfileProjectionRunSnapshot,
} from './profile-projection-run'
import {
  createProfileResumeStore,
  type ProfileResumeStore,
} from './profile-resume-store'
import {
  resetProfileStreamCache,
  synchronizeProfileStream,
  type ProfileProjectionAnchor,
  type ProfileStreamCacheResetter,
  type ProfileStreamSnapshot,
  type ProfileStreamSynchronizer,
} from './profile-stream'
import type { ProfileSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

export type ProfileProjectionReader = Pick<
  ProfileProjectionRun,
  'advance' | 'close' | 'getProfile' | 'resumeState' | 'snapshot'
>

export type ProfileProjectionOpener = (
  anchor: ProfileProjectionAnchor,
  accounts: readonly Address[],
  resume?: ProfileProjectionResumeState,
) => Promise<ProfileProjectionReader>

export type ProfileReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: ProfileStreamSnapshot }
  | {
      busy: boolean
      notice?: string
      phase: 'projecting'
      projection: ProfileProjectionRunSnapshot
      resumed: boolean
    }
  | {
      notice?: string
      phase: 'complete'
      profile?: ProfileSet
      projection: ProfileProjectionRunSnapshot
      resumeSaved: boolean
      resumed: boolean
    }
  | { message: string; phase: 'failed'; retryable: boolean }

type ScopedReadModelState = {
  account: Address
  chainId: bigint
  provider: Eip1193Provider
  state: ProfileReadModelState
}

type ActiveProjection = {
  notice?: string
  resumed: boolean
  run: ProfileProjectionReader
}

export type UseProfileReadModelOptions = {
  openProjection?: ProfileProjectionOpener
  resetCache?: ProfileStreamCacheResetter
  resumeStore?: ProfileResumeStore
  synchronize?: ProfileStreamSynchronizer
}

const IDLE_STATE = { phase: 'idle' } as const
const defaultResumeStore = createProfileResumeStore()

const defaultProjectionOpener: ProfileProjectionOpener = (
  anchor,
  accounts,
  resume,
) => openProfileProjectionRun(anchor, accounts, { resume })

function stateForProjection(
  projection: ProfileProjectionRunSnapshot,
  resumed: boolean,
  notice?: string,
): ProfileReadModelState {
  if (projection.phase === 'profiles' || projection.phase === 'authenticate') {
    return {
      busy: false,
      notice,
      phase: 'projecting',
      projection,
      resumed,
    }
  }
  throw new Error('The local profile projection became unavailable.')
}

export function useProfileReadModel(
  session: WalletSession,
  {
    openProjection = defaultProjectionOpener,
    resetCache = resetProfileStreamCache,
    resumeStore = defaultResumeStore,
    synchronize = synchronizeProfileStream,
  }: UseProfileReadModelOptions = {},
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
    session.chainId !== undefined &&
    session.account !== undefined
  const provider = session.provider
  const chainId = session.chainId
  const account = session.account
  const state =
    connected &&
    scopedState !== undefined &&
    scopedState.provider === provider &&
    scopedState.chainId === chainId &&
    account !== undefined &&
    scopedState.account.toLowerCase() === account.toLowerCase()
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
  }, [account, chainId, connected, provider])

  const publishCompletedRun = useCallback(
    async (
      active: ActiveProjection,
      projection: ProfileProjectionRunSnapshot,
      context: {
        account: Address
        chainId: bigint
        provider: Eip1193Provider
        requestId: number
      },
    ) => {
      const { account, chainId, provider, requestId } = context
      const profile = active.run.getProfile(account)
      const resume = active.run.resumeState
      let notice = active.notice
      let resumeSaved = true
      try {
        await resumeStore.save(chainId, account, resume)
      } catch {
        resumeSaved = false
        notice =
          'The confirmed profile is available, but resumable local progress could not be saved.'
      }
      if (requestSequence.current !== requestId) return
      if (resumeSaved) ignoreSavedResume.current = false
      active.run.close()
      activeProjection.current = undefined
      setScopedState({
        account,
        chainId,
        provider,
        state: {
          notice,
          phase: 'complete',
          profile,
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
      account === undefined ||
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
      account,
      chainId,
      provider,
      state: { phase: 'synchronizing' },
    })
    let openedRun: ProfileProjectionReader | undefined
    void (async () => {
      try {
        const stream = await synchronize(provider, chainId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        if (!stream.projectionAnchor) {
          setScopedState({
            account,
            chainId,
            provider,
            state: { phase: 'catchup', stream },
          })
          return
        }
        let notice: string | undefined
        let resume: ProfileProjectionResumeState | undefined
        let resumeReadFailed = false
        if (ignoreSavedResume.current) {
          notice =
            'Previously rejected profile progress is being bypassed while the canonical projection is rebuilt.'
        } else {
          try {
            resume = await resumeStore.load(chainId, account)
          } catch {
            resumeReadFailed = true
            notice =
              'Saved profile progress was unreadable and will not be trusted. Rebuilding from canonical events.'
            try {
              await resumeStore.remove(chainId, account)
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
          openedRun = await openProjection(
            stream.projectionAnchor,
            [account],
            resume,
          )
        } catch (error) {
          if (!resume) throw error
          ignoreSavedResume.current = true
          notice =
            'Saved profile progress no longer matched the authenticated event cache. It was discarded and rebuilt.'
          try {
            await resumeStore.remove(chainId, account)
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
          openedRun = await openProjection(stream.projectionAnchor, [account])
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
            account,
            chainId,
            provider,
            requestId,
          })
        } else {
          setScopedState({
            account,
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
          account,
          chainId,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public profile could not be synchronized.',
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
    connected,
    openProjection,
    provider,
    publishCompletedRun,
    resetCache,
    resumeStore,
    synchronize,
  ])

  const advanceProjection = useCallback(() => {
    if (
      !connected ||
      provider === undefined ||
      chainId === undefined ||
      account === undefined ||
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
      account,
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
            account,
            chainId,
            provider,
            requestId,
          })
          return
        }
        setScopedState({
          account,
          chainId,
          provider,
          state: stateForProjection(projection, active.resumed, active.notice),
        })
      })
      .catch(async (error: unknown) => {
        if (requestSequence.current !== requestId) return
        active.run.close()
        activeProjection.current = undefined
        let message = describeRpcError(
          error,
          'The local profile projection could not be completed.',
        )
        let retryable = true
        if (isDeferredEventCacheCorruptionError(error)) {
          try {
            await resetCache(chainId)
            if (requestSequence.current !== requestId) return
            ignoreSavedResume.current = true
            try {
              await resumeStore.remove(chainId, account)
            } catch {
              // A stale resume is independently rejected on the next open.
            }
            message =
              'The corrupt local profile cache was reset. Retry to rebuild it from confirmed chain events.'
          } catch (resetError) {
            const detail = describeRpcError(
              resetError,
              'The corrupt local profile cache could not be reset.',
            )
            message = `${detail} Clear this site’s browser data and reload.`
            retryable = false
          }
        }
        if (requestSequence.current !== requestId) return
        setScopedState({
          account,
          chainId,
          provider,
          state: {
            message,
            phase: 'failed',
            retryable,
          },
        })
      })
      .finally(() => {
        if (requestSequence.current === requestId) busy.current = false
      })
  }, [
    account,
    chainId,
    connected,
    provider,
    publishCompletedRun,
    resetCache,
    resumeStore,
    state,
  ])

  return { advanceProjection, loadNextRange, state }
}
