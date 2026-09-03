import { useCallback, useEffect, useRef, useState } from 'react'
import { describeRpcError } from './ethereum'
import {
  synchronizePostFeed,
  type PostFeedSnapshot,
  type PostFeedSynchronizer,
} from './post-feed'
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
  refreshRevision = 0,
  session,
  synchronize = synchronizePostFeed,
}: {
  refreshRevision?: number
  session: WalletSession
  synchronize?: PostFeedSynchronizer
}) {
  const [snapshot, setSnapshot] = useState<PostFeedSnapshot>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const activeRequest = useRef<AbortController | undefined>(undefined)
  const requestSequence = useRef(0)
  const handledRefreshRevision = useRef(refreshRevision)
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined

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
    setLoading(true)
    setError(undefined)
    void synchronize(provider, chainId, { signal: controller.signal })
      .then((nextSnapshot) => {
        if (requestId === requestSequence.current) setSnapshot(nextSnapshot)
      })
      .catch((syncError: unknown) => {
        if (controller.signal.aborted || requestId !== requestSequence.current)
          return
        setError(
          describeRpcError(
            syncError,
            'The public post feed could not be synchronized.',
          ),
        )
      })
      .finally(() => {
        if (requestId === requestSequence.current) setLoading(false)
      })
  }, [session.chainId, session.provider, session.status, synchronize])

  useEffect(() => {
    requestSequence.current += 1
    activeRequest.current?.abort()
    setSnapshot(undefined)
    setError(undefined)
    setLoading(false)
    if (connected) runSynchronization()
    return () => {
      requestSequence.current += 1
      activeRequest.current?.abort()
    }
  }, [connected, runSynchronization])

  useEffect(() => {
    if (handledRefreshRevision.current === refreshRevision) return
    handledRefreshRevision.current = refreshRevision
    if (connected) runSynchronization()
  }, [connected, refreshRevision, runSynchronization])

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
