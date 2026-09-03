import { useCallback, useEffect, useRef, useState } from 'react'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import type {
  PostCommentProjectionReadOptions,
  PostCommentProjectionReadPage,
} from './post-comment-projection'
import {
  openPostCommentProjectionRun,
  type PostCommentProjectionRun,
  type PostCommentProjectionRunSnapshot,
} from './post-comment-projection-run'
import {
  synchronizePostCommentStream,
  type PostCommentProjectionAnchor,
  type PostCommentStreamSnapshot,
  type PostCommentStreamSynchronizer,
} from './post-comment-stream'
import type { PublishedPost } from './protocol-events'
import type { WalletSession } from './wallet-session'

export type PostCommentProjectionReader = Pick<
  PostCommentProjectionRun,
  'advance' | 'close' | 'readComments' | 'snapshot' | 'trackedPostIds'
>

export type PostCommentProjectionOpener = (
  anchor: PostCommentProjectionAnchor,
  postIds: readonly bigint[],
) => Promise<PostCommentProjectionReader>

export type PostCommentReadModelState =
  | { phase: 'idle' }
  | { phase: 'synchronizing' }
  | { phase: 'catchup'; stream: PostCommentStreamSnapshot }
  | {
      busy: boolean
      phase: 'projecting'
      projection: PostCommentProjectionRunSnapshot
    }
  | {
      phase: 'complete'
      projection: PostCommentProjectionRunSnapshot
    }
  | { message: string; phase: 'failed' }

type ScopedReadModelState = {
  chainId: bigint
  postScope: string
  provider: Eip1193Provider
  state: PostCommentReadModelState
}

export type UsePostCommentReadModelOptions = {
  openProjection?: PostCommentProjectionOpener
  synchronize?: PostCommentStreamSynchronizer
}

export type PostCommentReadTarget = Pick<
  PublishedPost,
  'blockHash' | 'logIndex' | 'postId'
>

const IDLE_STATE = { phase: 'idle' } as const

function getPostScope(posts: readonly PostCommentReadTarget[]) {
  return posts
    .map(
      (post) =>
        `${post.postId.toString(16)},${post.blockHash.toLowerCase()},${post.logIndex.toString(16)}`,
    )
    .toSorted()
    .join(';')
}

function getScopedPostIds(postScope: string) {
  return postScope === ''
    ? []
    : postScope.split(';').map((post) => BigInt(`0x${post.split(',')[0]}`))
}

function stateForProjection(
  projection: PostCommentProjectionRunSnapshot,
): PostCommentReadModelState {
  if (projection.phase === 'complete') {
    return { phase: 'complete', projection }
  }
  if (projection.phase === 'comments' || projection.phase === 'authenticate') {
    return { busy: false, phase: 'projecting', projection }
  }
  throw new Error('The local comment projection became unavailable.')
}

export function usePostCommentReadModel(
  session: WalletSession,
  posts: readonly PostCommentReadTarget[],
  {
    openProjection = openPostCommentProjectionRun,
    synchronize = synchronizePostCommentStream,
  }: UsePostCommentReadModelOptions = {},
) {
  const [scopedState, setScopedState] = useState<ScopedReadModelState>()
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeRun = useRef<PostCommentProjectionReader | undefined>(undefined)
  const busy = useRef(false)
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
  }, [chainId, connected, postScope, provider])

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
    activeRun.current?.close()
    activeRun.current = undefined
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
        openedRun = await openProjection(
          stream.projectionAnchor,
          getScopedPostIds(postScope),
        )
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
          postScope,
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
          postScope,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public comment history could not be synchronized.',
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
  }, [chainId, openProjection, postScope, provider, readable, synchronize])

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
    const run = activeRun.current
    if (!run) return
    busy.current = true
    const requestId = ++requestSequence.current
    setScopedState({
      chainId,
      postScope,
      provider,
      state: { ...state, busy: true },
    })
    void run
      .advance()
      .then((projection) => {
        if (requestSequence.current !== requestId) return
        setScopedState({
          chainId,
          postScope,
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
          postScope,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The local comment projection could not be completed.',
            ),
            phase: 'failed',
          },
        })
      })
      .finally(() => {
        if (requestSequence.current === requestId) busy.current = false
      })
  }, [chainId, postScope, provider, readable, state])

  const readComments = useCallback(
    (
      postId: bigint,
      options?: PostCommentProjectionReadOptions,
    ): PostCommentProjectionReadPage | undefined => {
      if (!readable || state.phase !== 'complete') return undefined
      return activeRun.current?.readComments(postId, options)
    },
    [readable, state.phase],
  )

  return { advanceProjection, loadNextRange, readComments, state }
}
