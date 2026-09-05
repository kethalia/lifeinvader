import { useCallback, useEffect, useRef, useState } from 'react'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { isDeferredEventCacheCorruptionError } from './event-cache'
import type {
  PostCommentProjectionReadOptions,
  PostCommentProjectionReadPage,
} from './post-comment-projection'
import {
  openPostCommentProjectionRun,
  type PostCommentProjectionResumeState,
  type PostCommentProjectionRun,
  type PostCommentProjectionRunSnapshot,
} from './post-comment-projection-run'
import {
  createPostCommentResumeStore,
  getPostCommentResumeScope,
  type PostCommentResumeStore,
} from './post-comment-resume-store'
import {
  resetPostCommentStreamCache,
  synchronizePostCommentStream,
  type PostCommentProjectionAnchor,
  type PostCommentStreamCacheResetter,
  type PostCommentStreamSnapshot,
  type PostCommentStreamSynchronizer,
} from './post-comment-stream'
import {
  synchronizePostFeed,
  type PostFeedSnapshot,
  type PostFeedSynchronizer,
} from './post-feed'
import type { PublishedPost } from './protocol-events'
import type { WalletSession } from './wallet-session'

export type PostCommentProjectionReader = Pick<
  PostCommentProjectionRun,
  | 'advance'
  | 'close'
  | 'readComments'
  | 'resumeState'
  | 'snapshot'
  | 'trackedPostIds'
>

export type PostCommentProjectionOpener = (
  anchor: PostCommentProjectionAnchor,
  postIds: readonly bigint[],
  resume?: PostCommentProjectionResumeState,
) => Promise<PostCommentProjectionReader>

export type PostCommentReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: PostCommentStreamSnapshot }
  | {
      busy: boolean
      notice?: string
      phase: 'projecting'
      projection: PostCommentProjectionRunSnapshot
      resumed: boolean
    }
  | {
      notice?: string
      phase: 'complete'
      projection: PostCommentProjectionRunSnapshot
      resumeSaved: boolean
      resumed: boolean
    }
  | { message: string; phase: 'failed'; retryable: boolean }

type ScopedReadModelState = {
  chainId: bigint
  postScope: string
  provider: Eip1193Provider
  state: PostCommentReadModelState
}

type ActiveProjection = {
  notice?: string
  resumed: boolean
  run: PostCommentProjectionReader
}

export type UsePostCommentReadModelOptions = {
  openProjection?: PostCommentProjectionOpener
  resetCache?: PostCommentStreamCacheResetter
  resumeStore?: PostCommentResumeStore
  synchronize?: PostCommentStreamSynchronizer
  synchronizePosts?: PostFeedSynchronizer
}

export type PostCommentReadTarget = Pick<
  PublishedPost,
  'blockHash' | 'blockNumber' | 'logIndex' | 'postId'
>

const IDLE_STATE = { phase: 'idle' } as const
const defaultResumeStore = createPostCommentResumeStore()

const defaultProjectionOpener: PostCommentProjectionOpener = (
  anchor,
  postIds,
  resume,
) => openPostCommentProjectionRun(anchor, postIds, { resume })

const defaultCacheResetter: PostCommentStreamCacheResetter = (
  chainId,
  startBlock,
) => resetPostCommentStreamCache(chainId, {}, startBlock)

function getPostScope(posts: readonly PostCommentReadTarget[]) {
  return posts.length === 0 ? '' : getPostCommentResumeScope(posts)
}

function getScopedPosts(postScope: string): PostCommentReadTarget[] {
  return postScope === ''
    ? []
    : postScope.split(';').map((post) => {
        const [postId, blockNumber, blockHash, logIndex] = post.split(',')
        return {
          blockHash: blockHash as PublishedPost['blockHash'],
          blockNumber: BigInt(`0x${blockNumber}`),
          logIndex: Number.parseInt(logIndex!, 16),
          postId: BigInt(`0x${postId}`),
        }
      })
}

function assertAuthenticatedPostScope(
  anchor: PostCommentProjectionAnchor,
  expectedScope: string,
  posts: readonly PostCommentReadTarget[],
  snapshot: PostFeedSnapshot,
) {
  if (!snapshot.caughtUp) {
    throw new Error(
      'The confirmed post feed is not caught up. Load the next post range before retrying comment histories.',
    )
  }
  if (getPostScope(snapshot.posts) !== expectedScope) {
    throw new Error(
      'The confirmed post feed changed while comment histories were loading. Refresh posts before retrying.',
    )
  }
  const lastPostBlock = posts.reduce(
    (latest, post) => (post.blockNumber > latest ? post.blockNumber : latest),
    0n,
  )
  if (
    anchor.safeHead === undefined ||
    snapshot.safeHead === undefined ||
    anchor.safeHead < lastPostBlock ||
    snapshot.safeHead < lastPostBlock
  ) {
    throw new Error(
      'The confirmed comment boundary predates a visible post. Load newer chain ranges before retrying.',
    )
  }
}

function stateForProjection(
  projection: PostCommentProjectionRunSnapshot,
  resumed: boolean,
  notice?: string,
): PostCommentReadModelState {
  if (projection.phase === 'comments' || projection.phase === 'authenticate') {
    return {
      busy: false,
      notice,
      phase: 'projecting',
      projection,
      resumed,
    }
  }
  throw new Error('The local comment projection became unavailable.')
}

export function usePostCommentReadModel(
  session: WalletSession,
  posts: readonly PostCommentReadTarget[],
  {
    openProjection = defaultProjectionOpener,
    resetCache = defaultCacheResetter,
    resumeStore = defaultResumeStore,
    synchronize = synchronizePostCommentStream,
    synchronizePosts = synchronizePostFeed,
  }: UsePostCommentReadModelOptions = {},
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
  const postScope = getPostScope(posts)
  const readable = connected && postScope !== ''
  const state =
    readable &&
    scopedState !== undefined &&
    scopedState.provider === provider &&
    scopedState.chainId === chainId &&
    scopedState.postScope === postScope
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
  }, [chainId, connected, postScope, provider])

  const publishCompletedRun = useCallback(
    async (
      active: ActiveProjection,
      projection: PostCommentProjectionRunSnapshot,
      context: {
        chainId: bigint
        postScope: string
        provider: Eip1193Provider
        requestId: number
      },
    ) => {
      const { chainId, postScope, provider, requestId } = context
      const resume = active.run.resumeState
      let notice = active.notice
      let resumeSaved = true
      try {
        await resumeStore.save(chainId, postScope, resume)
      } catch {
        resumeSaved = false
        notice =
          'Confirmed comment histories are available, but resumable local progress could not be saved.'
      }
      if (requestSequence.current !== requestId) return
      if (resumeSaved) ignoreSavedResume.current = false
      // A completed run keeps its immutable projection after close, so retain
      // it for bounded pagination while releasing the IndexedDB connection.
      active.run.close()
      activeProjection.current = active
      setScopedState({
        chainId,
        postScope,
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
      !readable ||
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
      postScope,
      provider,
      state: { phase: 'synchronizing' },
    })
    let openedRun: PostCommentProjectionReader | undefined
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
            postScope,
            provider,
            state: { phase: 'catchup', stream },
          })
          return
        }
        const scopedPosts = getScopedPosts(postScope)
        const authenticatedFeed = await synchronizePosts(provider, chainId, {
          signal: controller.signal,
        })
        if (controller.signal.aborted || requestSequence.current !== requestId)
          return
        assertAuthenticatedPostScope(
          stream.projectionAnchor,
          postScope,
          scopedPosts,
          authenticatedFeed,
        )
        const postIds = scopedPosts.map((post) => post.postId)
        let notice: string | undefined
        let resume: PostCommentProjectionResumeState | undefined
        let resumeReadFailed = false
        if (ignoreSavedResume.current) {
          notice =
            'Previously rejected comment progress is being bypassed while the canonical projection is rebuilt.'
        } else {
          try {
            resume = await resumeStore.load(chainId, postScope)
          } catch {
            resumeReadFailed = true
            notice =
              'Saved comment progress was unreadable and will not be trusted. Rebuilding from canonical events.'
            try {
              await resumeStore.remove(chainId, postScope)
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
            postIds,
            resume,
          )
        } catch (error) {
          if (!resume) throw error
          ignoreSavedResume.current = true
          notice =
            'Saved comment progress no longer matched the authenticated event cache. It was discarded and rebuilt.'
          try {
            await resumeStore.remove(chainId, postScope)
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
          openedRun = await openProjection(stream.projectionAnchor, postIds)
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
            postScope,
            provider,
            requestId,
          })
        } else {
          setScopedState({
            chainId,
            postScope,
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
          postScope,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public comment history could not be synchronized.',
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
    openProjection,
    postScope,
    provider,
    publishCompletedRun,
    readable,
    resumeStore,
    synchronize,
    synchronizePosts,
  ])

  const advanceProjection = useCallback(() => {
    if (
      !readable ||
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
      postScope,
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
            postScope,
            provider,
            requestId,
          })
          return
        }
        setScopedState({
          chainId,
          postScope,
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
          'The local comment projection could not be completed.',
        )
        let retryable = true
        if (isDeferredEventCacheCorruptionError(error)) {
          try {
            await resetCache(chainId, startBlock)
            if (requestSequence.current !== requestId) return
            ignoreSavedResume.current = true
            try {
              await resumeStore.remove(chainId, postScope)
            } catch {
              // A stale resume is independently rejected on the next open.
            }
            message =
              'The corrupt local comment cache was reset. Retry to rebuild it from confirmed chain events.'
          } catch (resetError) {
            const detail = describeRpcError(
              resetError,
              'The corrupt local comment cache could not be reset.',
            )
            message = `${detail} Clear this site’s browser data and reload.`
            retryable = false
          }
        }
        if (requestSequence.current !== requestId) return
        setScopedState({
          chainId,
          postScope,
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
    chainId,
    postScope,
    provider,
    publishCompletedRun,
    readable,
    resetCache,
    resumeStore,
    state,
  ])

  const readComments = useCallback(
    (
      postId: bigint,
      options?: PostCommentProjectionReadOptions,
    ): PostCommentProjectionReadPage | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeProjection.current?.run.readComments(postId, options)
    },
    [readable, state.phase],
  )

  return { advanceProjection, loadNextRange, readComments, state }
}
