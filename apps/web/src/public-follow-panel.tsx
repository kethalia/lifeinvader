import { useEffect, useRef, useState } from 'react'
import { getAddress, isAddress, type Address, type Hash } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import type {
  FollowDirection,
  FollowProjectionReadPage,
} from './follow-projection'
import {
  useFollowReadModel,
  type FollowReadModelState,
  type UseFollowReadModelOptions,
} from './follow-read-model'
import {
  createTransactionGuard,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  setFollow,
  waitForTransactionReceipt,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
import type { FollowSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const RELATIONSHIP_PAGE_SIZE = 25
const FAILED_ATTEMPT_HISTORY_LIMIT = 8

type WalletContext = {
  account: Address
  chainId: bigint
  provider: Eip1193Provider
  walletName: string
}

type FollowWriteContext = WalletContext & {
  followed: Address
  following: boolean
}

type FollowAttempt = FollowWriteContext & {
  hash?: Hash
  id: number
  message?: string
  status: 'ambiguous' | 'failed' | 'opening' | 'pending' | 'unknown'
}

type FollowCompletion = {
  context: FollowWriteContext
  receipt: TransactionReceipt
}

type FollowProblem = {
  context: FollowWriteContext
  message: string
}

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function parseAccountInput(value: string, label: string) {
  const candidate = value.trim()
  if (!candidate) return {} as { account?: Address; error?: string }
  if (!isAddress(candidate)) {
    return { error: `Enter a valid EVM ${label} address.` }
  }
  const account = getAddress(candidate)
  if (account.toLowerCase() === ZERO_ADDRESS) {
    return { error: `The ${label} address must be nonzero.` }
  }
  return { account }
}

function sameWalletContext(first: WalletContext, second: WalletContext) {
  return (
    first.provider === second.provider &&
    first.chainId === second.chainId &&
    first.account.toLowerCase() === second.account.toLowerCase()
  )
}

function contextMatchesSession(context: WalletContext, session: WalletSession) {
  return (
    session.status === 'connected' &&
    context.provider === session.provider &&
    context.chainId === session.chainId &&
    context.account.toLowerCase() === session.account?.toLowerCase()
  )
}

function retainAttempts(attempts: FollowAttempt[]) {
  let failedToDrop = Math.max(
    0,
    attempts.filter((attempt) => attempt.status === 'failed').length -
      FAILED_ATTEMPT_HISTORY_LIMIT,
  )
  return attempts.filter((attempt) => {
    if (attempt.status !== 'failed' || failedToDrop === 0) return true
    failedToDrop -= 1
    return false
  })
}

function relationshipAccount(
  relationship: FollowSet,
  direction: FollowDirection,
) {
  return direction === 'following'
    ? relationship.followed
    : relationship.follower
}

function readStatusCopy(
  state: FollowReadModelState,
  direction: FollowDirection,
) {
  if (state.phase === 'idle') {
    return `Not loaded. Each click reads at most one bounded RPC range for this account's ${direction}.`
  }
  if (state.phase === 'synchronizing') {
    return `Reading one bounded range of confirmed ${direction} events…`
  }
  if (state.phase === 'catchup') {
    const reset = state.stream.cacheReset
      ? 'The disposable local event cache was reset. '
      : ''
    return `${reset}More confirmed history remains. Indexed through block ${state.stream.indexedThrough?.toString() ?? 'none'} of confirmed head ${state.stream.safeHead?.toString() ?? 'unknown'}.`
  }
  if (state.phase === 'projecting') {
    const phase =
      state.projection.phase === 'authenticate'
        ? 'Authenticating the complete local result'
        : 'Reducing one bounded local event page'
    return `${phase}. ${state.projection.pagesScanned.toString()} pages and ${state.projection.logsProcessed.toString()} signals processed; results stay hidden until complete.`
  }
  if (state.phase === 'complete') {
    return `Authenticated through confirmed block ${state.projection.safeHead?.toString() ?? 'none'}. ${state.projection.relationshipsRetained.toString()} active relationships are available.`
  }
  return state.message
}

function readButtonLabel(state: FollowReadModelState) {
  if (state.phase === 'synchronizing') return 'Reading confirmed follows…'
  if (state.phase === 'catchup') return 'Load next bounded follow range'
  if (state.phase === 'projecting') {
    return state.busy
      ? 'Advancing local projection…'
      : state.projection.phase === 'authenticate'
        ? 'Authenticate projected relationships'
        : 'Process next local relationship page'
  }
  if (state.phase === 'complete') return 'Check for newer confirmed follows'
  if (state.phase === 'failed') return 'Retry public follow read'
  return 'Load confirmed follow history'
}

function FollowAttemptStatus({
  attempt,
  currentContext,
  onDismiss,
  onRetry,
}: {
  attempt: FollowAttempt
  currentContext: boolean
  onDismiss(): void
  onRetry(): void
}) {
  const action = attempt.following ? 'Follow' : 'Unfollow'
  const statusCopy =
    attempt.status === 'opening'
      ? 'Waiting for wallet approval…'
      : attempt.status === 'pending'
        ? 'Waiting for an authenticated on-chain receipt…'
        : attempt.status === 'failed'
          ? 'Reverted on-chain. This hash is final, so a new action is safe.'
          : attempt.status === 'ambiguous'
            ? 'The wallet returned no hash but may have broadcast the action. Check wallet activity before trying again.'
            : 'Its final status is unknown. Authenticate this hash before trying again.'
  return (
    <div className="follow-attempt" role="status">
      <p>
        <strong>{action}</strong>{' '}
        <code title={attempt.followed}>{shortValue(attempt.followed)}</code> on
        chain {attempt.chainId.toString()} from{' '}
        <code title={attempt.account}>{shortValue(attempt.account)}</code> via{' '}
        {attempt.walletName}
        {attempt.hash ? (
          <>
            {' '}
            · <code title={attempt.hash}>{shortValue(attempt.hash)}</code>
          </>
        ) : null}
        . {statusCopy}{' '}
        {!currentContext
          ? 'This belongs to another wallet context and does not lock the current controls.'
          : null}
      </p>
      {attempt.message ? (
        <p className="follow-attempt-error">{attempt.message}</p>
      ) : null}
      {attempt.status === 'unknown' ||
      attempt.status === 'ambiguous' ||
      attempt.status === 'failed' ? (
        <div className="follow-recovery-actions">
          {attempt.status === 'unknown' && currentContext ? (
            <button onClick={onRetry} type="button">
              Check follow receipt again
            </button>
          ) : null}
          <button onClick={onDismiss} type="button">
            {attempt.hash ? 'I checked this hash' : 'I checked my wallet'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function RelationshipList({
  direction,
  onBrowse,
  page,
}: {
  direction: FollowDirection
  onBrowse(account: Address): void
  page: FollowProjectionReadPage
}) {
  if (page.relationships.length === 0) {
    return (
      <p className="follow-empty-result">
        This authenticated account view contains no active {direction}.
      </p>
    )
  }
  return (
    <ol className="follow-relationship-list">
      {page.relationships.map((relationship) => {
        const account = relationshipAccount(relationship, direction)
        return (
          <li key={account.toLowerCase()}>
            <div>
              <code title={account}>{account}</code>
              <span>
                Latest active signal · block{' '}
                {relationship.blockNumber.toString()}
              </span>
            </div>
            <button onClick={() => onBrowse(account)} type="button">
              Browse account
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export function PublicFollowPanel({
  readModelOptions,
  session,
  setFollowAction = setFollow,
  waitForReceipt = waitForTransactionReceipt,
}: {
  readModelOptions?: UseFollowReadModelOptions
  session: WalletSession
  setFollowAction?: typeof setFollow
  waitForReceipt?: typeof waitForTransactionReceipt
}) {
  const [accountInput, setAccountInput] = useState(session.account ?? '')
  const [direction, setDirection] = useState<FollowDirection>('following')
  const [pageCursors, setPageCursors] = useState<
    readonly (Address | undefined)[]
  >([undefined])
  const [targetInput, setTargetInput] = useState('')
  const [attempts, setAttempts] = useState<FollowAttempt[]>([])
  const [completions, setCompletions] = useState<FollowCompletion[]>([])
  const [problems, setProblems] = useState<FollowProblem[]>([])
  const operationSequence = useRef(0)

  useEffect(() => {
    if (!session.account) return
    setAccountInput((current) => (current.trim() ? current : session.account!))
  }, [session.account])

  const connected =
    session.status === 'connected' &&
    session.account !== undefined &&
    session.chainId !== undefined &&
    session.provider !== undefined
  const accountSelection = parseAccountInput(accountInput, 'account')
  const targetSelection = parseAccountInput(targetInput, 'follow target')
  const selfTarget =
    targetSelection.account !== undefined &&
    session.account !== undefined &&
    targetSelection.account.toLowerCase() === session.account.toLowerCase()
  const targetError = selfTarget
    ? 'An account cannot follow itself.'
    : targetSelection.error
  const readModel = useFollowReadModel(
    session,
    accountSelection.account,
    direction,
    readModelOptions,
  )

  useEffect(() => {
    setPageCursors([undefined])
  }, [accountSelection.account, direction, readModel.state.phase])

  const currentAttempts = attempts.filter((attempt) =>
    contextMatchesSession(attempt, session),
  )
  const writeLocked = currentAttempts.some(
    (attempt) => attempt.status !== 'failed',
  )
  const activeAttempt = currentAttempts.findLast(
    (attempt) => attempt.status === 'opening' || attempt.status === 'pending',
  )
  const activeProblem = problems.findLast(({ context }) =>
    contextMatchesSession(context, session),
  )
  const activeCompletion = completions.findLast(({ context }) =>
    contextMatchesSession(context, session),
  )
  const pageCursor = pageCursors.at(-1)
  let relationshipPage: FollowProjectionReadPage | undefined
  let pageError: string | undefined
  if (readModel.state.phase === 'complete') {
    try {
      relationshipPage = readModel.readRelationships({
        after: pageCursor,
        limit: RELATIONSHIP_PAGE_SIZE,
      })
    } catch (error) {
      pageError = describeRpcError(
        error,
        'The authenticated relationship page could not be read.',
      )
    }
  }

  const finishAction = (
    context: FollowWriteContext,
    id: number,
    receipt: TransactionReceipt,
  ) => {
    setAttempts((current) => current.filter((attempt) => attempt.id !== id))
    setProblems((current) =>
      current.filter((problem) => !sameWalletContext(problem.context, context)),
    )
    setCompletions((current) =>
      [
        ...current.filter(
          (completion) => !sameWalletContext(completion.context, context),
        ),
        { context, receipt },
      ].slice(-8),
    )
  }

  const runAction = (
    context: FollowWriteContext,
    operation: (
      onSubmitted: TransactionSubmitted,
    ) => Promise<TransactionReceipt>,
  ) => {
    const id = ++operationSequence.current
    let submittedHash: Hash | undefined
    setProblems((current) =>
      current.filter((problem) => !sameWalletContext(problem.context, context)),
    )
    setCompletions((current) =>
      current.filter(
        (completion) => !sameWalletContext(completion.context, context),
      ),
    )
    setAttempts((current) =>
      retainAttempts([
        ...current.filter(
          (attempt) =>
            attempt.status !== 'failed' || !sameWalletContext(attempt, context),
        ),
        { ...context, id, status: 'opening' },
      ]),
    )
    void Promise.resolve()
      .then(() =>
        operation((hash) => {
          submittedHash = hash
          setAttempts((current) =>
            current.map((attempt) =>
              attempt.id === id
                ? { ...attempt, hash, status: 'pending' }
                : attempt,
            ),
          )
        }),
      )
      .then((receipt) => finishAction(context, id, receipt))
      .catch((error: unknown) => {
        const message = describeRpcError(
          error,
          'The public follow transaction failed.',
        )
        if (submittedHash) {
          setAttempts((current) =>
            retainAttempts(
              current.map((attempt) =>
                attempt.id === id
                  ? {
                      ...attempt,
                      hash: submittedHash,
                      message,
                      status: isTransactionRevertedError(error)
                        ? ('failed' as const)
                        : ('unknown' as const),
                    }
                  : attempt,
              ),
            ),
          )
        } else if (isTransactionSubmissionUnknownError(error)) {
          setAttempts((current) =>
            current.map((attempt) =>
              attempt.id === id
                ? { ...attempt, message, status: 'ambiguous' }
                : attempt,
            ),
          )
        } else {
          setAttempts((current) =>
            current.filter((attempt) => attempt.id !== id),
          )
          setProblems((current) => [...current, { context, message }].slice(-8))
        }
      })
  }

  const publishFollow = (following: boolean) => {
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    const followed = targetSelection.account
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      !followed ||
      selfTarget ||
      writeLocked
    ) {
      return
    }
    const context: FollowWriteContext = {
      account,
      chainId,
      followed,
      following,
      provider,
      walletName: session.name ?? 'Injected wallet',
    }
    runAction(context, (onSubmitted) =>
      setFollowAction(
        provider,
        account,
        chainId,
        followed,
        following,
        onSubmitted,
      ),
    )
  }

  const retryReceipt = (attempt: FollowAttempt) => {
    const hash = attempt.hash
    if (
      attempt.status !== 'unknown' ||
      !hash ||
      !contextMatchesSession(attempt, session) ||
      attempts.some(
        (candidate) =>
          candidate.id !== attempt.id &&
          candidate.status !== 'failed' &&
          sameWalletContext(candidate, attempt),
      )
    ) {
      return
    }
    setAttempts((current) =>
      current.map((candidate) =>
        candidate.id === attempt.id
          ? { ...candidate, message: undefined, status: 'pending' }
          : candidate,
      ),
    )
    void (async () => {
      try {
        if (session.provider !== attempt.provider) {
          throw new Error(
            'Reconnect the wallet that submitted this follow action to check its receipt.',
          )
        }
        const guard = await createTransactionGuard(
          attempt.provider,
          attempt.account,
          attempt.chainId,
        )
        const receipt = await waitForReceipt(attempt.provider, hash, {
          assertCurrentChain: guard.assertSubmission,
          assertUnchanged: guard.assertUnchanged,
          expectedFollow: {
            followed: attempt.followed,
            follower: attempt.account,
            following: attempt.following,
          },
          selectedChainId: attempt.chainId,
        }).finally(guard.release)
        finishAction(attempt, attempt.id, receipt)
      } catch (error) {
        setAttempts((current) =>
          retainAttempts(
            current.map((candidate) =>
              candidate.id === attempt.id
                ? {
                    ...candidate,
                    message: describeRpcError(
                      error,
                      'The public follow receipt could not be read.',
                    ),
                    status: isTransactionRevertedError(error)
                      ? ('failed' as const)
                      : ('unknown' as const),
                  }
                : candidate,
            ),
          ),
        )
      }
    })()
  }

  const runReadStep = () => {
    if (readModel.state.phase === 'projecting') {
      readModel.advanceProjection()
    } else {
      readModel.loadNextRange()
    }
  }
  const readDisabled =
    !connected ||
    accountSelection.account === undefined ||
    readModel.state.phase === 'synchronizing' ||
    (readModel.state.phase === 'projecting' && readModel.state.busy) ||
    (readModel.state.phase === 'failed' && !readModel.state.retryable)
  const writeDisabled =
    !connected ||
    targetSelection.account === undefined ||
    selfTarget ||
    writeLocked

  return (
    <section aria-labelledby="public-follows-title" className="public-follows">
      <div className="public-follows-heading">
        <div>
          <p className="eyebrow">The public popularity ledger</p>
          <h2 id="public-follows-title">
            Follow the money. And everyone else.
          </h2>
        </div>
        <p className="follow-public-warning">
          Every follow and unfollow is a permanent public event. The current
          relationship is derived; the embarrassing history remains.
        </p>
      </div>

      <div className="follow-console">
        <div className="follow-reader">
          <h3>Audit an account’s social graph</h3>
          <label htmlFor="follow-account">Public account address</label>
          <input
            aria-describedby="follow-account-help"
            aria-invalid={accountSelection.error ? true : undefined}
            id="follow-account"
            onChange={(event) => setAccountInput(event.currentTarget.value)}
            placeholder="0x…"
            spellCheck={false}
            value={accountInput}
          />
          <p
            className={
              accountSelection.error
                ? 'follow-help error-message'
                : 'follow-help'
            }
            id="follow-account-help"
          >
            {accountSelection.error ??
              (accountSelection.account
                ? `Selected ${accountSelection.account}.`
                : 'Enter any nonzero EVM account, or use the connected account.')}
          </p>
          <button
            disabled={!session.account}
            onClick={() => setAccountInput(session.account ?? '')}
            type="button"
          >
            Use connected account
          </button>

          <fieldset className="follow-direction">
            <legend>Relationship direction</legend>
            <button
              aria-pressed={direction === 'following'}
              onClick={() => setDirection('following')}
              type="button"
            >
              Following
            </button>
            <button
              aria-pressed={direction === 'followers'}
              onClick={() => setDirection('followers')}
              type="button"
            >
              Followers
            </button>
          </fieldset>

          <p className="follow-read-status" role="status">
            {!connected
              ? 'Connect a wallet to read through its bounded EIP-1193 RPC connection.'
              : readStatusCopy(readModel.state, direction)}
          </p>
          <button
            className="button-accent"
            disabled={readDisabled}
            onClick={runReadStep}
            type="button"
          >
            {readButtonLabel(readModel.state)}
          </button>

          {pageError ? (
            <p className="follow-page-error" role="alert">
              {pageError}
            </p>
          ) : null}
          {relationshipPage ? (
            <>
              <div className="follow-list-heading">
                <strong>
                  {direction === 'following' ? 'Following' : 'Followers'} ·{' '}
                  {relationshipPage.totalRelationships.toString()}
                </strong>
                <span>
                  Page {pageCursors.length} · up to {RELATIONSHIP_PAGE_SIZE}
                </span>
              </div>
              <RelationshipList
                direction={direction}
                onBrowse={setAccountInput}
                page={relationshipPage}
              />
              <div className="follow-pagination">
                <button
                  disabled={pageCursors.length === 1}
                  onClick={() =>
                    setPageCursors((current) => current.slice(0, -1))
                  }
                  type="button"
                >
                  Previous relationships
                </button>
                <button
                  disabled={relationshipPage.complete}
                  onClick={() => {
                    if (!relationshipPage?.nextAfter) return
                    setPageCursors((current) => [
                      ...current,
                      relationshipPage!.nextAfter,
                    ])
                  }}
                  type="button"
                >
                  Next relationships
                </button>
              </div>
            </>
          ) : null}
        </div>

        <div className="follow-writer">
          <h3>Publish a relationship signal</h3>
          <label htmlFor="follow-target">Follow target address</label>
          <input
            aria-describedby="follow-target-help"
            aria-invalid={targetError ? true : undefined}
            disabled={writeLocked}
            id="follow-target"
            onChange={(event) => setTargetInput(event.currentTarget.value)}
            placeholder="0x…"
            spellCheck={false}
            value={targetInput}
          />
          <p
            className={
              targetError ? 'follow-help error-message' : 'follow-help'
            }
            id="follow-target-help"
          >
            {targetError ??
              (targetSelection.account
                ? `The next event targets ${targetSelection.account}.`
                : 'A follow and an unfollow each require a separate wallet transaction.')}
          </p>
          <p className="follow-write-disclosure">
            Repeating or reversing the action appends another event. Nothing is
            deleted, and no notification is private.
          </p>
          <div className="follow-write-actions">
            <button
              className="button-accent"
              disabled={writeDisabled}
              onClick={() => publishFollow(true)}
              type="button"
            >
              {activeAttempt?.following
                ? activeAttempt.status === 'opening'
                  ? 'Opening wallet…'
                  : 'Following…'
                : 'Follow on-chain'}
            </button>
            <button
              disabled={writeDisabled}
              onClick={() => publishFollow(false)}
              type="button"
            >
              {activeAttempt && !activeAttempt.following
                ? activeAttempt.status === 'opening'
                  ? 'Opening wallet…'
                  : 'Unfollowing…'
                : 'Unfollow on-chain'}
            </button>
          </div>

          {!connected ? (
            <p className="follow-connection-note">
              Connect a wallet before publishing follows. The client verifies
              Lifeinvader v1 at the predetermined address before every write.
            </p>
          ) : null}
          {activeProblem ? (
            <p className="follow-problem" role="alert">
              {activeProblem.message}
            </p>
          ) : null}
          {attempts.map((attempt) => (
            <FollowAttemptStatus
              attempt={attempt}
              currentContext={contextMatchesSession(attempt, session)}
              key={attempt.id}
              onDismiss={() =>
                setAttempts((current) =>
                  current.filter((candidate) => candidate.id !== attempt.id),
                )
              }
              onRetry={() => retryReceipt(attempt)}
            />
          ))}
          {activeCompletion ? (
            <p className="follow-completion" role="status">
              {activeCompletion.context.following ? 'Follow' : 'Unfollow'} for{' '}
              <code title={activeCompletion.context.followed}>
                {shortValue(activeCompletion.context.followed)}
              </code>{' '}
              was confirmed in block{' '}
              {activeCompletion.receipt.blockNumber.toString()} ·{' '}
              <code title={activeCompletion.receipt.hash}>
                {shortValue(activeCompletion.receipt.hash)}
              </code>
              . Confirmed readers update only after the configured confirmation
              depth and an explicit refresh.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
