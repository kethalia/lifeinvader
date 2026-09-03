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
import {
  synchronizePostFeed,
  type PostFeedSnapshot,
  type PostFeedSynchronizer,
} from './post-feed'
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
  synchronizePosts?: PostFeedSynchronizer
}

export type PostCommentReadTarget = Pick<
  PublishedPost,
  'blockHash' | 'blockNumber' | 'logIndex' | 'postId'
>

const IDLE_STATE = { phase: 'idle' } as const

function getPostScope(posts: readonly PostCommentReadTarget[]) {
  return posts
    .map(
      (post) =>
        `${post.postId.toString(16)},${post.blockNumber.toString(16)},${post.blockHash.toLowerCase()},${post.logIndex.toString(16)}`,
    )
    .toSorted()
    .join(';')
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
    synchronizePosts = synchronizePostFeed,
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
        openedRun = await openProjection(
          stream.projectionAnchor,
          scopedPosts.map((post) => post.postId),
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
  }, [
    chainId,
    openProjection,
    postScope,
    provider,
    readable,
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
