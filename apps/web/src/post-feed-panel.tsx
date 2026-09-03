import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Hex } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import {
  decodeMediaCid,
  MAX_MEDIA_CID_TEXT_LENGTH,
  parseMediaCid,
} from './media-cid'
import {
  synchronizePostFeed,
  type PostFeedSnapshot,
  type PostFeedSynchronizer,
} from './post-feed'
import {
  POST_FEED_CONFIRMATION_DEPTH,
  waitForPostFeedConfirmation,
  type IncludedPost,
  type PostFeedConfirmationWaiter,
} from './post-feed-confirmation'
import {
  createTransactionGuard,
  getPostBodyByteLength,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  MAX_POST_BODY_BYTES,
  publishComment,
  publishRepost,
  setPostLike,
  waitForTransactionReceipt,
  type ExpectedPostAction,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
import {
  usePostReactionReadModel,
  type PostReactionProjectionOpener,
  type PostReactionReadModelState,
} from './post-reaction-read-model'
import type { PostReactionStreamSynchronizer } from './post-reaction-stream'
import type { WalletSession } from './wallet-session'

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function MediaCommitment({ value }: { value: Hex }) {
  try {
    const cid = decodeMediaCid(value)
    return (
      <div className="post-media-commitment">
        <span>IPFS media commitment · {cid.codec}</span>
        <code>{cid.text}</code>
        <span>Address only; availability is not guaranteed.</span>
      </div>
    )
  } catch {
    return (
      <div className="post-media-commitment invalid-media-commitment">
        <span>Invalid media CID bytes committed on-chain.</span>
        <code>{value}</code>
      </div>
    )
  }
}

function syncStatus(snapshot: PostFeedSnapshot) {
  if (snapshot.caughtUp) {
    return snapshot.safeHead === undefined
      ? 'Caught up. No block has reached the selected confirmation depth yet.'
      : `Caught up through confirmed block ${snapshot.safeHead.toString()}.`
  }
  return snapshot.indexedThrough === undefined
    ? 'The first bounded chain range is still waiting to be indexed.'
    : `Indexed through block ${snapshot.indexedThrough.toString()} of confirmed head ${snapshot.safeHead?.toString() ?? 'unknown'}.`
}

function reactionStatus(state: PostReactionReadModelState) {
  if (state.phase === 'idle') {
    return 'Reaction totals are not loaded. One request reads at most two bounded RPC ranges; exceptional cache repair is capped at 5,000 records per stream.'
  }
  if (state.phase === 'synchronizing') {
    return 'Reading one bounded range for likes and one for reposts…'
  }
  if (state.phase === 'catchup') {
    const likes = state.stream.likes.indexedThrough?.toString() ?? 'none'
    const reposts = state.stream.reposts.indexedThrough?.toString() ?? 'none'
    return `More confirmed reaction history remains. Likes indexed through ${likes}; reposts through ${reposts}.`
  }
  if (state.phase === 'projecting') {
    const events =
      state.projection.likes.logsProcessed +
      state.projection.reposts.logsProcessed
    const pages =
      state.projection.likes.pagesScanned +
      state.projection.reposts.pagesScanned
    return `Local ${state.projection.phase} projection: ${events.toString()} events across ${pages.toString()} bounded pages.`
  }
  if (state.phase === 'complete') {
    return state.projection.safeHead === undefined
      ? 'Reaction totals are exact for the currently confirmed empty range.'
      : `Reaction totals are exact through confirmed block ${state.projection.safeHead.toString()}.`
  }
  return state.message
}

function reactionButtonLabel(state: PostReactionReadModelState) {
  if (state.phase === 'synchronizing') return 'Reading reactions…'
  if (state.phase === 'catchup') return 'Load next reaction range'
  if (state.phase === 'projecting') {
    return state.busy
      ? 'Processing reaction page…'
      : 'Process next local reaction page'
  }
  if (state.phase === 'complete') return 'Check for newer reactions'
  if (state.phase === 'failed') return 'Retry reaction counts'
  return 'Load reaction counts'
}

type PostActionContext = {
  chainId: bigint
  commentRevision?: number
  expected: ExpectedPostAction
  provider: Eip1193Provider
  walletName: string
}

type CommentDraft = {
  account: string
  body: string
  chainId: bigint
  mediaCidInput: string
  postId: bigint
  provider: Eip1193Provider
  revision: number
}

type PostActionAttempt = PostActionContext & {
  hash?: TransactionReceipt['hash']
  id: number
  status: 'ambiguous' | 'failed' | 'opening' | 'pending' | 'unknown'
}

type CompletedPostAction = PostActionContext & {
  receipt: TransactionReceipt
}

type PostActionProblem = PostActionContext & { message: string }

function actionLabel(expected: ExpectedPostAction) {
  if (expected.kind === 'comment') return 'Comment'
  if (expected.kind === 'repost') return 'Repost'
  return expected.liked ? 'Like' : 'Unlike'
}

function actionContextMatchesSession(
  context: PostActionContext,
  session: WalletSession,
) {
  return (
    session.status === 'connected' &&
    context.provider === session.provider &&
    context.chainId === session.chainId &&
    context.expected.account.toLowerCase() === session.account?.toLowerCase()
  )
}

function sameActionContext(
  first: PostActionContext,
  second: PostActionContext,
) {
  return (
    first.provider === second.provider &&
    first.chainId === second.chainId &&
    first.expected.account.toLowerCase() ===
      second.expected.account.toLowerCase()
  )
}

export function PostFeedPanel({
  includedPost,
  openReactionProjection,
  publishCommentAction = publishComment,
  publishRepostAction = publishRepost,
  session,
  setPostLikeAction = setPostLike,
  synchronize = synchronizePostFeed,
  synchronizePostReactions,
  waitForActionReceipt = waitForTransactionReceipt,
  waitForConfirmation = waitForPostFeedConfirmation,
}: {
  includedPost?: IncludedPost
  openReactionProjection?: PostReactionProjectionOpener
  publishCommentAction?: typeof publishComment
  publishRepostAction?: typeof publishRepost
  session: WalletSession
  setPostLikeAction?: typeof setPostLike
  synchronize?: PostFeedSynchronizer
  synchronizePostReactions?: PostReactionStreamSynchronizer
  waitForActionReceipt?: typeof waitForTransactionReceipt
  waitForConfirmation?: PostFeedConfirmationWaiter
}) {
  const [loaded, setLoaded] = useState<{
    chainId: bigint
    provider: NonNullable<WalletSession['provider']>
    snapshot: PostFeedSnapshot
  }>()
  const [syncError, setSyncError] = useState<{
    chainId: bigint
    message: string
    provider: NonNullable<WalletSession['provider']>
  }>()
  const [loadingContext, setLoadingContext] = useState<{
    chainId: bigint
    provider: NonNullable<WalletSession['provider']>
  }>()
  const [confirmation, setConfirmation] = useState<{
    hash: IncludedPost['hash']
    message?: string
    status: 'waiting' | 'stopped'
  }>()
  const [completedPostActions, setCompletedPostActions] = useState<
    CompletedPostAction[]
  >([])
  const [postActionAttempts, setPostActionAttempts] = useState<
    PostActionAttempt[]
  >([])
  const [postActionProblems, setPostActionProblems] = useState<
    PostActionProblem[]
  >([])
  const [commentDraft, setCommentDraft] = useState<CommentDraft>()
  const reactionModel = usePostReactionReadModel(session, {
    openProjection: openReactionProjection,
    synchronize: synchronizePostReactions,
  })
  const actionSequence = useRef(0)
  const activeRequest = useRef<AbortController | undefined>(undefined)
  const commentRevision = useRef(0)
  const requestSequence = useRef(0)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
  const activeCommentDraft =
    connected &&
    commentDraft !== undefined &&
    commentDraft.provider === session.provider &&
    commentDraft.chainId === session.chainId &&
    commentDraft.account.toLowerCase() === session.account?.toLowerCase()
      ? commentDraft
      : undefined
  let parsedCommentMediaCid: ReturnType<typeof parseMediaCid>
  let commentMediaCidError: string | undefined
  try {
    parsedCommentMediaCid = parseMediaCid(
      activeCommentDraft?.mediaCidInput ?? '',
    )
  } catch (mediaError) {
    commentMediaCidError =
      mediaError instanceof Error
        ? mediaError.message
        : 'The media CID is invalid.'
  }
  const commentBodyBytes = getPostBodyByteLength(activeCommentDraft?.body ?? '')
  const snapshot =
    connected &&
    loaded !== undefined &&
    loaded.provider === session.provider &&
    loaded.chainId === session.chainId
      ? loaded.snapshot
      : undefined
  const error =
    connected &&
    syncError !== undefined &&
    syncError.provider === session.provider &&
    syncError.chainId === session.chainId
      ? syncError.message
      : undefined
  const loading =
    connected &&
    loadingContext !== undefined &&
    loadingContext.provider === session.provider &&
    loadingContext.chainId === session.chainId
  const activeConfirmation =
    connected &&
    includedPost !== undefined &&
    includedPost.provider === session.provider &&
    includedPost.chainId === session.chainId &&
    confirmation?.hash === includedPost.hash
      ? confirmation
      : undefined
  const activeCompletedPostAction = completedPostActions.findLast((action) =>
    actionContextMatchesSession(action, session),
  )
  const activePostActionProblem = postActionProblems.findLast((problem) =>
    actionContextMatchesSession(problem, session),
  )
  const activePostActionAttempts = postActionAttempts.filter((attempt) =>
    actionContextMatchesSession(attempt, session),
  )
  const postActionsLocked =
    session.account === undefined ||
    activePostActionAttempts.some((attempt) => attempt.status !== 'failed')

  const runSynchronization = useCallback(() => {
    const provider = session.provider
    const chainId = session.chainId
    if (
      session.status !== 'connected' ||
      provider === undefined ||
      chainId === undefined
    ) {
      return
    }
    activeRequest.current?.abort()
    const controller = new AbortController()
    const requestId = ++requestSequence.current
    activeRequest.current = controller
    setLoadingContext({ chainId, provider })
    setSyncError(undefined)
    void synchronize(provider, chainId, { signal: controller.signal })
      .then((nextSnapshot) => {
        if (requestId === requestSequence.current) {
          setLoaded({ chainId, provider, snapshot: nextSnapshot })
        }
      })
      .catch((syncError: unknown) => {
        if (controller.signal.aborted || requestId !== requestSequence.current)
          return
        setSyncError({
          chainId,
          message: describeRpcError(
            syncError,
            'The public post feed could not be synchronized.',
          ),
          provider,
        })
      })
      .finally(() => {
        if (requestId === requestSequence.current) {
          setLoadingContext(undefined)
        }
      })
  }, [session.chainId, session.provider, session.status, synchronize])

  useEffect(() => {
    requestSequence.current += 1
    activeRequest.current?.abort()
    setLoaded(undefined)
    setSyncError(undefined)
    setLoadingContext(undefined)
    if (connected) runSynchronization()
    return () => {
      requestSequence.current += 1
      activeRequest.current?.abort()
    }
  }, [connected, runSynchronization])

  useEffect(() => {
    if (
      !connected ||
      includedPost === undefined ||
      includedPost.provider !== session.provider ||
      includedPost.chainId !== session.chainId
    ) {
      setConfirmation(undefined)
      return
    }
    const controller = new AbortController()
    setConfirmation({ hash: includedPost.hash, status: 'waiting' })
    void waitForConfirmation(
      includedPost.provider,
      includedPost.chainId,
      includedPost,
      { signal: controller.signal },
    )
      .then(() => {
        if (controller.signal.aborted) return
        setConfirmation(undefined)
        runSynchronization()
      })
      .catch((confirmationError: unknown) => {
        if (controller.signal.aborted) return
        setConfirmation({
          hash: includedPost.hash,
          message: describeRpcError(
            confirmationError,
            'Automatic post confirmation monitoring stopped.',
          ),
          status: 'stopped',
        })
      })
    return () => controller.abort()
  }, [
    connected,
    includedPost,
    runSynchronization,
    session.chainId,
    session.provider,
    waitForConfirmation,
  ])

  const clearPublishedCommentDraft = (context: PostActionContext) => {
    const expected = context.expected
    if (
      expected.kind !== 'comment' ||
      !actionContextMatchesSession(context, sessionRef.current)
    ) {
      return
    }
    setCommentDraft((current) =>
      current?.provider === context.provider &&
      current.chainId === context.chainId &&
      current.account.toLowerCase() === expected.account.toLowerCase() &&
      current.postId === expected.postId &&
      current.revision === context.commentRevision
        ? undefined
        : current,
    )
  }

  const runPostAction = (
    postId: bigint,
    action: 'comment' | 'like' | 'repost' | 'unlike',
    comment?: { body: string; mediaCid: Hex; revision: number },
  ) => {
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      postActionsLocked
    ) {
      return
    }
    let expected: ExpectedPostAction
    if (action === 'comment') {
      if (!comment) return
      expected = {
        account,
        body: comment.body,
        kind: 'comment',
        mediaCid: comment.mediaCid,
        postId,
      }
    } else {
      expected =
        action === 'repost'
          ? { account, kind: 'repost', postId }
          : { account, kind: 'like', liked: action === 'like', postId }
    }
    const context: PostActionContext = {
      chainId,
      commentRevision: comment?.revision,
      expected,
      provider,
      walletName: session.name ?? 'Injected wallet',
    }
    const attemptId = ++actionSequence.current
    let submittedHash: TransactionReceipt['hash'] | undefined
    setPostActionAttempts((current) => [
      ...current.filter(
        (attempt) =>
          attempt.status !== 'failed' || !sameActionContext(attempt, context),
      ),
      { ...context, id: attemptId, status: 'opening' },
    ])
    setCompletedPostActions((current) =>
      current.filter((completed) => !sameActionContext(completed, context)),
    )
    setPostActionProblems((current) =>
      current.filter((problem) => !sameActionContext(problem, context)),
    )
    const onSubmitted: TransactionSubmitted = (hash) => {
      submittedHash = hash
      setPostActionAttempts((current) =>
        current.map((attempt) =>
          attempt.id === attemptId
            ? { ...attempt, hash, status: 'pending' }
            : attempt,
        ),
      )
    }
    const operation = () =>
      expected.kind === 'comment'
        ? publishCommentAction(
            provider,
            account,
            chainId,
            postId,
            { body: expected.body, mediaCid: expected.mediaCid },
            onSubmitted,
          )
        : expected.kind === 'repost'
          ? publishRepostAction(provider, account, chainId, postId, onSubmitted)
          : setPostLikeAction(
              provider,
              account,
              chainId,
              postId,
              expected.liked,
              onSubmitted,
            )
    void Promise.resolve()
      .then(operation)
      .then((receipt) => {
        setCompletedPostActions((current) =>
          [
            ...current.filter(
              (completed) => !sameActionContext(completed, context),
            ),
            { ...context, receipt },
          ].slice(-12),
        )
        setPostActionAttempts((current) =>
          current.filter((attempt) => attempt.id !== attemptId),
        )
        clearPublishedCommentDraft(context)
      })
      .catch((actionError: unknown) => {
        const recoverableStatus = submittedHash
          ? isTransactionRevertedError(actionError)
            ? 'failed'
            : 'unknown'
          : isTransactionSubmissionUnknownError(actionError)
            ? 'ambiguous'
            : undefined
        setPostActionAttempts((current) =>
          recoverableStatus
            ? current.map((attempt) =>
                attempt.id === attemptId
                  ? {
                      ...attempt,
                      hash: submittedHash,
                      status: recoverableStatus,
                    }
                  : attempt,
              )
            : current.filter((attempt) => attempt.id !== attemptId),
        )
        setPostActionProblems((current) =>
          [
            ...current.filter(
              (problem) => !sameActionContext(problem, context),
            ),
            {
              ...context,
              message: describeRpcError(
                actionError,
                'The public post action failed.',
              ),
            },
          ].slice(-12),
        )
      })
  }

  const retryPostActionReceipt = (transaction: PostActionAttempt) => {
    const hash = transaction.hash
    if (
      transaction.status !== 'unknown' ||
      !hash ||
      !actionContextMatchesSession(transaction, session) ||
      postActionAttempts.some(
        (attempt) =>
          attempt.id !== transaction.id &&
          attempt.status !== 'failed' &&
          sameActionContext(attempt, transaction),
      )
    ) {
      return
    }
    void (async () => {
      setPostActionProblems((current) =>
        current.filter((problem) => !sameActionContext(problem, transaction)),
      )
      setPostActionAttempts((current) =>
        current.map((attempt) =>
          attempt.id === transaction.id
            ? { ...attempt, status: 'pending' }
            : attempt,
        ),
      )
      try {
        if (session.provider !== transaction.provider) {
          throw new Error(
            'Reconnect the wallet that submitted this action to check its receipt.',
          )
        }
        const guard = await createTransactionGuard(
          transaction.provider,
          transaction.expected.account,
          transaction.chainId,
        )
        const receipt = await waitForActionReceipt(transaction.provider, hash, {
          assertCurrentChain: guard.assertSubmission,
          assertUnchanged: guard.assertUnchanged,
          expectedPostAction: transaction.expected,
          selectedChainId: transaction.chainId,
        }).finally(guard.release)
        setCompletedPostActions((current) =>
          [
            ...current.filter(
              (completed) => !sameActionContext(completed, transaction),
            ),
            { ...transaction, receipt },
          ].slice(-12),
        )
        setPostActionAttempts((current) =>
          current.filter((attempt) => attempt.id !== transaction.id),
        )
        clearPublishedCommentDraft(transaction)
      } catch (receiptError) {
        setPostActionAttempts((current) =>
          current.map((attempt) =>
            attempt.id === transaction.id
              ? {
                  ...attempt,
                  status: isTransactionRevertedError(receiptError)
                    ? 'failed'
                    : 'unknown',
                }
              : attempt,
          ),
        )
        setPostActionProblems((current) =>
          [
            ...current.filter(
              (problem) => !sameActionContext(problem, transaction),
            ),
            {
              ...transaction,
              message: describeRpcError(
                receiptError,
                'The public action receipt could not be read.',
              ),
            },
          ].slice(-12),
        )
      }
    })()
  }

  const dismissPostAction = (transaction: PostActionAttempt) => {
    setPostActionAttempts((current) =>
      current.filter((attempt) => attempt.id !== transaction.id),
    )
    setPostActionProblems((current) =>
      current.filter((problem) => !sameActionContext(problem, transaction)),
    )
  }

  const toggleCommentComposer = (postId: bigint) => {
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    if (!account || chainId === undefined || !provider || postActionsLocked) {
      return
    }
    if (activeCommentDraft?.postId === postId) {
      setCommentDraft(undefined)
      return
    }
    if (activeCommentDraft) return
    setCommentDraft({
      account,
      body: '',
      chainId,
      mediaCidInput: '',
      postId,
      provider,
      revision: ++commentRevision.current,
    })
  }

  const updateCommentDraft = (
    postId: bigint,
    update: Partial<Pick<CommentDraft, 'body' | 'mediaCidInput'>>,
  ) => {
    const draft = activeCommentDraft
    if (!draft || draft.postId !== postId) return
    const revision = ++commentRevision.current
    setCommentDraft((current) => {
      if (
        !current ||
        current.provider !== draft.provider ||
        current.chainId !== draft.chainId ||
        current.account.toLowerCase() !== draft.account.toLowerCase() ||
        current.postId !== postId
      ) {
        return current
      }
      return { ...current, ...update, revision }
    })
  }

  const submitComment = (
    event: FormEvent<HTMLFormElement>,
    draft: CommentDraft,
  ) => {
    event.preventDefault()
    if (
      draft !== activeCommentDraft ||
      commentMediaCidError !== undefined ||
      commentBodyBytes > MAX_POST_BODY_BYTES ||
      (commentBodyBytes === 0 && parsedCommentMediaCid === undefined)
    ) {
      return
    }
    runPostAction(draft.postId, 'comment', {
      body: draft.body,
      mediaCid: parsedCommentMediaCid?.bytes ?? '0x',
      revision: draft.revision,
    })
  }

  return (
    <section className="post-feed" aria-labelledby="post-feed-title">
      <div className="post-feed-heading">
        <div>
          <p className="eyebrow">Confirmed public disclosures</p>
          <h2 id="post-feed-title">The feed remembers everything.</h2>
        </div>
        <div className="feed-controls">
          <p aria-live="polite">
            {!connected
              ? 'Connect a wallet to read through its selected chain RPC.'
              : snapshot
                ? syncStatus(snapshot)
                : loading
                  ? 'Reading one bounded range from the chain…'
                  : 'The feed is ready to retry.'}
          </p>
          {connected ? (
            <button
              type="button"
              disabled={loading}
              onClick={runSynchronization}
            >
              {loading
                ? 'Synchronizing…'
                : snapshot?.caughtUp
                  ? 'Check for newer posts'
                  : 'Load next block range'}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="error-message feed-feedback" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot?.cacheReset ? (
        <p className="feed-feedback" role="status">
          The disposable local cache was rebuilt before this range was read.
        </p>
      ) : null}
      {connected ? (
        <div
          className={`feed-feedback reaction-read-model${reactionModel.state.phase === 'failed' ? ' error-message' : ''}`}
        >
          <div>
            <strong>On-chain reaction ledger</strong>
            <p
              role={reactionModel.state.phase === 'failed' ? 'alert' : 'status'}
            >
              {reactionStatus(reactionModel.state)}
            </p>
          </div>
          <button
            disabled={
              reactionModel.state.phase === 'synchronizing' ||
              (reactionModel.state.phase === 'projecting' &&
                reactionModel.state.busy)
            }
            onClick={
              reactionModel.state.phase === 'projecting'
                ? reactionModel.advanceProjection
                : reactionModel.loadNextRange
            }
            type="button"
          >
            {reactionButtonLabel(reactionModel.state)}
          </button>
        </div>
      ) : null}
      {activeConfirmation ? (
        <p
          className={`feed-feedback${activeConfirmation.status === 'stopped' ? ' error-message' : ''}`}
          role={activeConfirmation.status === 'stopped' ? 'alert' : 'status'}
        >
          {activeConfirmation.status === 'waiting'
            ? `Post ${shortValue(includedPost!.hash)} was included in block ${includedPost!.blockNumber.toString()}. The feed will refresh once it is ${POST_FEED_CONFIRMATION_DEPTH.toString()} blocks deep.`
            : activeConfirmation.message}
        </p>
      ) : null}
      {activePostActionProblem ? (
        <p className="error-message feed-feedback" role="alert">
          {activePostActionProblem.message}
        </p>
      ) : null}
      {postActionAttempts.map((transaction) => {
        const currentContext = actionContextMatchesSession(transaction, session)
        return (
          <div
            className={`feed-feedback${currentContext ? '' : ' stale-action-feedback'}`}
            key={transaction.id}
            role="status"
          >
            <span>
              {actionLabel(transaction.expected)} for post #
              {transaction.expected.postId.toString()} on chain{' '}
              {transaction.chainId.toString()} from{' '}
              <code title={transaction.expected.account}>
                {shortValue(transaction.expected.account)}
              </code>{' '}
              via {transaction.walletName}
              {transaction.hash ? (
                <>
                  {' '}
                  ·{' '}
                  <code title={transaction.hash}>
                    {shortValue(transaction.hash)}
                  </code>
                </>
              ) : null}
              .{' '}
              {transaction.status === 'opening'
                ? 'Opening the wallet…'
                : transaction.status === 'pending'
                  ? 'Waiting for an on-chain receipt…'
                  : transaction.status === 'failed'
                    ? 'Reverted on-chain. This hash is final.'
                    : transaction.status === 'ambiguous'
                      ? 'The wallet returned no hash, but may have broadcast it. Check wallet activity before trying again.'
                      : 'Its final status is unknown. Check this hash before trying again.'}{' '}
              {!currentContext
                ? 'This belongs to another wallet context and does not lock the current feed.'
                : null}
            </span>
            {transaction.status === 'unknown' ||
            transaction.status === 'ambiguous' ||
            transaction.status === 'failed' ? (
              <div className="transaction-recovery-actions">
                {transaction.status === 'unknown' && currentContext ? (
                  <button
                    type="button"
                    onClick={() => retryPostActionReceipt(transaction)}
                  >
                    Check action receipt again
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => dismissPostAction(transaction)}
                >
                  {transaction.hash
                    ? 'I checked this hash'
                    : 'I checked my wallet'}
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
      {activeCompletedPostAction ? (
        <p className="feed-feedback post-action-complete" role="status">
          {actionLabel(activeCompletedPostAction.expected)} for post #
          {activeCompletedPostAction.expected.postId.toString()} was included in
          block {activeCompletedPostAction.receipt.blockNumber.toString()}.
        </p>
      ) : null}

      {snapshot?.posts.length ? (
        <ol className="post-list" aria-busy={loading}>
          {snapshot.posts.map((post) => {
            const reactionSummary = reactionModel.getSummary(
              post.postId,
              session.account,
            )
            return (
              <li key={`${post.blockHash}:${post.logIndex}`}>
                <article className="post-card">
                  <header>
                    <p>
                      <span title={post.author}>{shortValue(post.author)}</span>
                      <span>Post #{post.postId.toString()}</span>
                    </p>
                    <p>
                      Block {post.blockNumber.toString()} ·{' '}
                      <code title={post.transactionHash}>
                        {shortValue(post.transactionHash)}
                      </code>
                    </p>
                  </header>
                  {post.body ? <p className="post-body">{post.body}</p> : null}
                  {post.mediaCid !== '0x' ? (
                    <MediaCommitment value={post.mediaCid} />
                  ) : null}
                  <div
                    aria-label={`Public actions for post ${post.postId.toString()}`}
                    className="post-actions"
                  >
                    {reactionSummary ? (
                      <p className="post-reaction-summary">
                        {reactionSummary.likeCount.toString()}{' '}
                        {reactionSummary.likeCount === 1n ? 'like' : 'likes'} ·{' '}
                        {reactionSummary.repostCount.toString()}{' '}
                        {reactionSummary.repostCount === 1n
                          ? 'repost'
                          : 'reposts'}
                        {reactionSummary.likedByAccount
                          ? ' · You liked this.'
                          : ''}
                      </p>
                    ) : null}
                    <div>
                      <button
                        aria-label={`${activeCommentDraft?.postId === post.postId ? 'Cancel comment' : 'Write comment'} for post ${post.postId.toString()}`}
                        disabled={
                          postActionsLocked ||
                          (activeCommentDraft !== undefined &&
                            activeCommentDraft.postId !== post.postId)
                        }
                        onClick={() => toggleCommentComposer(post.postId)}
                        type="button"
                      >
                        {activeCommentDraft?.postId === post.postId
                          ? 'Cancel comment'
                          : 'Comment'}
                      </button>
                      <button
                        aria-label={`Record like for post ${post.postId.toString()}`}
                        disabled={postActionsLocked}
                        onClick={() => runPostAction(post.postId, 'like')}
                        type="button"
                      >
                        Like
                      </button>
                      <button
                        aria-label={`Record unlike for post ${post.postId.toString()}`}
                        disabled={postActionsLocked}
                        onClick={() => runPostAction(post.postId, 'unlike')}
                        type="button"
                      >
                        Unlike
                      </button>
                      <button
                        aria-label={`Repost post ${post.postId.toString()}`}
                        disabled={postActionsLocked}
                        onClick={() => runPostAction(post.postId, 'repost')}
                        type="button"
                      >
                        Repost
                      </button>
                    </div>
                    {activeCommentDraft?.postId === post.postId ? (
                      <form
                        className="comment-composer"
                        onSubmit={(event) =>
                          submitComment(event, activeCommentDraft)
                        }
                      >
                        <label
                          htmlFor={`comment-body-${post.postId.toString()}`}
                        >
                          Permanent public comment
                        </label>
                        <textarea
                          disabled={postActionsLocked}
                          id={`comment-body-${post.postId.toString()}`}
                          maxLength={MAX_POST_BODY_BYTES}
                          onChange={(event) =>
                            updateCommentDraft(post.postId, {
                              body: event.target.value,
                            })
                          }
                          placeholder="Say it where nobody can delete it."
                          rows={3}
                          value={activeCommentDraft.body}
                        />
                        <label
                          htmlFor={`comment-media-cid-${post.postId.toString()}`}
                        >
                          IPFS media CID (already uploaded, optional)
                        </label>
                        <input
                          aria-describedby={`comment-media-cid-help-${post.postId.toString()}`}
                          aria-invalid={commentMediaCidError ? true : undefined}
                          disabled={postActionsLocked}
                          id={`comment-media-cid-${post.postId.toString()}`}
                          maxLength={MAX_MEDIA_CID_TEXT_LENGTH}
                          onChange={(event) =>
                            updateCommentDraft(post.postId, {
                              mediaCidInput: event.target.value,
                            })
                          }
                          placeholder="bafy… or Qm…"
                          type="text"
                          value={activeCommentDraft.mediaCidInput}
                        />
                        <p
                          className={
                            commentMediaCidError ? 'error-message' : undefined
                          }
                          id={`comment-media-cid-help-${post.postId.toString()}`}
                        >
                          {commentMediaCidError ??
                            (parsedCommentMediaCid
                              ? `Will commit canonical CIDv1 bytes (${parsedCommentMediaCid.codec}).`
                              : 'Address only; this does not upload or guarantee storage.')}
                        </p>
                        <div className="comment-compose-actions">
                          <span
                            className={
                              commentBodyBytes > MAX_POST_BODY_BYTES
                                ? 'limit-exceeded'
                                : undefined
                            }
                          >
                            {commentBodyBytes} / {MAX_POST_BODY_BYTES} UTF-8
                            bytes
                          </span>
                          <button
                            className="button-accent"
                            disabled={
                              postActionsLocked ||
                              commentMediaCidError !== undefined ||
                              commentBodyBytes > MAX_POST_BODY_BYTES ||
                              (commentBodyBytes === 0 &&
                                parsedCommentMediaCid === undefined)
                            }
                            type="submit"
                          >
                            Publish comment on-chain
                          </button>
                        </div>
                      </form>
                    ) : null}
                    <p>Each click appends another public on-chain event.</p>
                  </div>
                </article>
              </li>
            )
          })}
        </ol>
      ) : snapshot ? (
        <p className="empty-feed">
          {snapshot.caughtUp
            ? 'No confirmed posts exist on this chain yet.'
            : 'No posts were found in this range. More confirmed history remains.'}
        </p>
      ) : (
        <div className="feed-placeholder" aria-busy={loading}>
          <p>
            {connected
              ? 'The first fifty cached posts will appear here.'
              : 'Your wallet supplies the chain and RPC. Lifeinvader supplies no hidden feed server.'}
          </p>
        </div>
      )}
    </section>
  )
}
