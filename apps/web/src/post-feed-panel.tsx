import { useCallback, useEffect, useRef, useState } from 'react'
import { describeRpcError } from './ethereum'
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
import type { WalletSession } from './wallet-session'

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
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

export function PostFeedPanel({
  includedPost,
  session,
  synchronize = synchronizePostFeed,
  waitForConfirmation = waitForPostFeedConfirmation,
}: {
  includedPost?: IncludedPost
  session: WalletSession
  synchronize?: PostFeedSynchronizer
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
                  <p className="post-media-commitment">
                    Media CID bytes committed on-chain:{' '}
                    <code>{post.mediaCid}</code>
                  </p>
                ) : null}
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
