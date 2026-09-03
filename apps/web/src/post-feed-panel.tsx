import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { decodeMediaCid } from './media-cid'
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
  isTransactionRevertedError,
  publishRepost,
  setPostLike,
  waitForTransactionReceipt,
  type ExpectedPostAction,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
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

type SubmittedPostAction = {
  chainId: bigint
  expected: ExpectedPostAction
  hash: TransactionReceipt['hash']
  provider: Eip1193Provider
  status: 'failed' | 'pending' | 'unknown'
}

type CompletedPostAction = {
  chainId: bigint
  expected: ExpectedPostAction
  provider: Eip1193Provider
  receipt: TransactionReceipt
}

function actionLabel(expected: ExpectedPostAction) {
  if (expected.kind === 'repost') return 'Repost'
  return expected.liked ? 'Like' : 'Unlike'
}

export function PostFeedPanel({
  includedPost,
  publishRepostAction = publishRepost,
  session,
  setPostLikeAction = setPostLike,
  synchronize = synchronizePostFeed,
  waitForActionReceipt = waitForTransactionReceipt,
  waitForConfirmation = waitForPostFeedConfirmation,
}: {
  includedPost?: IncludedPost
  publishRepostAction?: typeof publishRepost
  session: WalletSession
  setPostLikeAction?: typeof setPostLike
  synchronize?: PostFeedSynchronizer
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
  const [busyPostAction, setBusyPostAction] = useState<ExpectedPostAction>()
  const [completedPostAction, setCompletedPostAction] =
    useState<CompletedPostAction>()
  const [postActionError, setPostActionError] = useState<string>()
  const [submittedPostAction, setSubmittedPostAction] =
    useState<SubmittedPostAction>()
  const activeRequest = useRef<AbortController | undefined>(undefined)
  const requestSequence = useRef(0)
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
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
  const activeCompletedPostAction =
    connected &&
    completedPostAction !== undefined &&
    completedPostAction.provider === session.provider &&
    completedPostAction.chainId === session.chainId &&
    completedPostAction.expected.account.toLowerCase() ===
      session.account?.toLowerCase()
      ? completedPostAction
      : undefined
  const postActionsLocked =
    session.account === undefined ||
    busyPostAction !== undefined ||
    (submittedPostAction !== undefined &&
      submittedPostAction.status !== 'failed')

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
    setCompletedPostAction(undefined)
    setPostActionError(undefined)
  }, [session.account, session.chainId, session.provider])

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

  const runPostAction = (
    postId: bigint,
    action: 'like' | 'repost' | 'unlike',
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
    const expected: ExpectedPostAction =
      action === 'repost'
        ? { account, kind: 'repost', postId }
        : { account, kind: 'like', liked: action === 'like', postId }
    let submittedHash: TransactionReceipt['hash'] | undefined
    setBusyPostAction(expected)
    setCompletedPostAction(undefined)
    setPostActionError(undefined)
    if (submittedPostAction?.status === 'failed') {
      setSubmittedPostAction(undefined)
    }
    const onSubmitted: TransactionSubmitted = (hash) => {
      submittedHash = hash
      setSubmittedPostAction({
        chainId,
        expected,
        hash,
        provider,
        status: 'pending',
      })
    }
    const operation =
      action === 'repost'
        ? publishRepostAction(provider, account, chainId, postId, onSubmitted)
        : setPostLikeAction(
            provider,
            account,
            chainId,
            postId,
            action === 'like',
            onSubmitted,
          )
    void operation
      .then((receipt) => {
        setCompletedPostAction({ chainId, expected, provider, receipt })
        setSubmittedPostAction(undefined)
      })
      .catch((actionError: unknown) => {
        if (submittedHash) {
          setSubmittedPostAction({
            chainId,
            expected,
            hash: submittedHash,
            provider,
            status: isTransactionRevertedError(actionError)
              ? 'failed'
              : 'unknown',
          })
        }
        setPostActionError(
          describeRpcError(actionError, 'The public post action failed.'),
        )
      })
      .finally(() => setBusyPostAction(undefined))
  }

  const retryPostActionReceipt = () => {
    const transaction = submittedPostAction
    if (transaction?.status !== 'unknown' || busyPostAction) return
    void (async () => {
      setBusyPostAction(transaction.expected)
      setPostActionError(undefined)
      setSubmittedPostAction({ ...transaction, status: 'pending' })
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
        const receipt = await waitForActionReceipt(
          transaction.provider,
          transaction.hash,
          {
            assertCurrentChain: guard.assertSubmission,
            assertUnchanged: guard.assertUnchanged,
            expectedPostAction: transaction.expected,
            selectedChainId: transaction.chainId,
          },
        ).finally(guard.release)
        setCompletedPostAction({
          chainId: transaction.chainId,
          expected: transaction.expected,
          provider: transaction.provider,
          receipt,
        })
        setSubmittedPostAction(undefined)
      } catch (receiptError) {
        setSubmittedPostAction({
          ...transaction,
          status: isTransactionRevertedError(receiptError)
            ? 'failed'
            : 'unknown',
        })
        setPostActionError(
          describeRpcError(
            receiptError,
            'The public action receipt could not be read.',
          ),
        )
      } finally {
        setBusyPostAction(undefined)
      }
    })()
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
      {postActionError ? (
        <p className="error-message feed-feedback" role="alert">
          {postActionError}
        </p>
      ) : null}
      {submittedPostAction ? (
        <div className="feed-feedback" role="status">
          <span>
            {actionLabel(submittedPostAction.expected)} for post #
            {submittedPostAction.expected.postId.toString()} submitted ·{' '}
            <code title={submittedPostAction.hash}>
              {shortValue(submittedPostAction.hash)}
            </code>
            .{' '}
            {submittedPostAction.status === 'pending'
              ? 'Waiting for an on-chain receipt…'
              : submittedPostAction.status === 'failed'
                ? 'Reverted on-chain. This hash is final.'
                : 'Its final status is unknown. Check this hash before trying again.'}
          </span>
          {submittedPostAction.status === 'unknown' ? (
            <div className="transaction-recovery-actions">
              <button type="button" onClick={retryPostActionReceipt}>
                Check action receipt again
              </button>
              <button
                type="button"
                onClick={() => {
                  setSubmittedPostAction(undefined)
                  setPostActionError(undefined)
                }}
              >
                I checked this hash
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {activeCompletedPostAction ? (
        <p className="feed-feedback post-action-complete" role="status">
          {actionLabel(activeCompletedPostAction.expected)} for post #
          {activeCompletedPostAction.expected.postId.toString()} was included in
          block {activeCompletedPostAction.receipt.blockNumber.toString()}.
        </p>
      ) : null}

      {snapshot?.posts.length ? (
        <ol className="post-list" aria-busy={loading}>
          {snapshot.posts.map((post) => (
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
                  <div>
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
                  <p>Each click appends another public on-chain event.</p>
                </div>
              </article>
            </li>
          ))}
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
