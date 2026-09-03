import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Address, Hex } from 'viem'
import {
  beforeDeadline,
  describeRpcError,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
} from './ethereum'
import {
  createTransactionGuard,
  deployProtocol,
  getPostBodyByteLength,
  inspectProtocol,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  LOCAL_CHAIN_ID,
  MAX_POST_BODY_BYTES,
  PROTOCOL_ADDRESS,
  publishPost,
  switchToLocalChain,
  verifyLocalChain,
  waitForTransactionReceipt,
  type ProtocolInspection,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
import { useWalletProviders } from './wallet-providers'
import type { WalletSession, WalletSessionController } from './wallet-session'
import type { IncludedPost } from './post-feed-confirmation'
import { MAX_MEDIA_CID_TEXT_LENGTH, parseMediaCid } from './media-cid'
const inspectionCopy: Record<ProtocolInspection['kind'], string> = {
  ready: 'Verified Lifeinvader v1 code is ready.',
  deployable: 'The canonical factory is verified. You can deploy v1 here.',
  'missing-factory':
    'The canonical deployment factory is missing on this chain.',
  'unsafe-factory':
    'Code at the factory address does not match the canonical factory.',
  'address-conflict': 'Unexpected code occupies the Lifeinvader v1 address.',
}
function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
function TransactionResult({ receipt }: { receipt: TransactionReceipt }) {
  return (
    <p className="transaction-result">
      Included in block {receipt.blockNumber.toString()} ·{' '}
      <code title={receipt.hash}>{shortAddress(receipt.hash)}</code>
    </p>
  )
}
type WalletContext = {
  account: Address
  chainId: bigint
  provider: Eip1193Provider
  walletName: string
}
type TransactionContext = WalletContext & {
  action: 'deploy' | 'post'
  postBody: string
  postMediaCid: Hex
}
type BusyOperation = {
  action: 'chain' | 'deploy' | 'post' | 'receipt'
  context?: WalletContext
  id: number
  scope: 'context' | 'provider'
}
type SubmittedTransaction = TransactionContext & {
  hash?: TransactionReceipt['hash']
  id: number
  status: 'ambiguous' | 'failed' | 'pending' | 'unknown'
}
type TransactionProblem = {
  context?: TransactionContext
  message: string
}
type TransactionResultState = TransactionContext & {
  receipt: TransactionReceipt
}
function transactionContextMatchesSession(
  transaction: WalletContext,
  session: WalletSession,
) {
  return (
    session.status === 'connected' &&
    transaction.provider === session.provider &&
    transaction.chainId === session.chainId &&
    transaction.account.toLowerCase() === session.account?.toLowerCase()
  )
}
function busyOperationMatchesSession(
  operation: BusyOperation,
  session: WalletSession,
) {
  if (!operation.context) return true
  if (operation.scope === 'provider') {
    return operation.context.provider === session.provider
  }
  return transactionContextMatchesSession(operation.context, session)
}
function sameTransactionContext(
  first: TransactionContext,
  second: TransactionContext,
) {
  return (
    first.provider === second.provider &&
    first.chainId === second.chainId &&
    first.account.toLowerCase() === second.account.toLowerCase()
  )
}
function TransactionStatus({
  currentContext,
  onDismiss,
  onRetry,
  transaction,
}: {
  currentContext: boolean
  onDismiss(): void
  onRetry(): void
  transaction: SubmittedTransaction
}) {
  const label = transaction.action === 'deploy' ? 'Deployment' : 'Post'
  const statusCopy =
    transaction.status === 'pending'
      ? 'Waiting for an on-chain receipt…'
      : transaction.status === 'failed'
        ? 'Reverted on-chain. This hash is final; you can safely try again.'
        : transaction.status === 'ambiguous'
          ? 'The wallet returned no hash, but may have broadcast it. Check wallet activity before trying again.'
          : 'Its final status is unknown. Check this hash before trying again.'
  return (
    <div className="transaction-pending action-feedback" role="status">
      <span>
        {transaction.hash ? (
          <>
            {label} submitted on chain {transaction.chainId.toString()} from{' '}
            <code title={transaction.account}>
              {shortAddress(transaction.account)}
            </code>{' '}
            via {transaction.walletName} ·{' '}
            <code title={transaction.hash}>
              {shortAddress(transaction.hash)}
            </code>
            .{' '}
          </>
        ) : (
          <>
            {label} submission is ambiguous on chain{' '}
            {transaction.chainId.toString()} from{' '}
            <code title={transaction.account}>
              {shortAddress(transaction.account)}
            </code>{' '}
            via {transaction.walletName}.{' '}
          </>
        )}
        {statusCopy}{' '}
        {!currentContext
          ? 'This belongs to another wallet context and does not lock the current console.'
          : null}
      </span>
      {transaction.status === 'unknown' ||
      transaction.status === 'ambiguous' ||
      transaction.status === 'failed' ? (
        <div className="transaction-recovery-actions">
          {transaction.status === 'unknown' && currentContext ? (
            <button type="button" onClick={onRetry}>
              Check receipt again
            </button>
          ) : null}
          <button type="button" onClick={onDismiss}>
            {transaction.hash ? 'I checked this hash' : 'I checked my wallet'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
export function WalletPanel({
  onPostConfirmed,
  walletSession,
}: {
  onPostConfirmed(post: IncludedPost): void
  walletSession: WalletSessionController
}) {
  const wallets = useWalletProviders()
  const { connect, refresh, session } = walletSession
  const [inspection, setInspection] = useState<ProtocolInspection>()
  const [inspectionError, setInspectionError] = useState<string>()
  const [localChainState, setLocalChainState] = useState<
    'not-selected' | 'checking' | 'verified' | 'mismatch'
  >('not-selected')
  const [busyOperations, setBusyOperations] = useState<BusyOperation[]>([])
  const [actionProblem, setActionProblem] = useState<TransactionProblem>()
  const [result, setResult] = useState<TransactionResultState>()
  const [submittedTransactions, setSubmittedTransactions] = useState<
    SubmittedTransaction[]
  >([])
  const [body, setBody] = useState('')
  const [mediaCidInput, setMediaCidInput] = useState('')
  let parsedMediaCid: ReturnType<typeof parseMediaCid>
  let mediaCidError: string | undefined
  try {
    parsedMediaCid = parseMediaCid(mediaCidInput)
  } catch (error) {
    mediaCidError =
      error instanceof Error ? error.message : 'The media CID is invalid.'
  }
  const inspectionSequence = useRef(0)
  const operationSequence = useRef(0)
  const transactionSequence = useRef(0)
  const refreshInspection = useCallback(async () => {
    const requestId = ++inspectionSequence.current
    const provider = session.provider
    let selectedLocalChain = session.chainId === LOCAL_CHAIN_ID
    let verifiedLocalChain = false
    setInspection(undefined)
    setInspectionError(undefined)
    if (!provider || session.status !== 'connected') {
      setLocalChainState('not-selected')
      return
    }
    try {
      const selectedChainId = parseChainId(
        await beforeDeadline(
          () => provider.request({ method: 'eth_chainId' }),
          Date.now() + WALLET_READ_TIMEOUT_MS,
          () => new Error('Wallet chain inspection timed out.'),
        ),
      )
      selectedLocalChain = selectedChainId === LOCAL_CHAIN_ID
      if (selectedChainId === LOCAL_CHAIN_ID) {
        if (requestId === inspectionSequence.current)
          setLocalChainState('checking')
        await verifyLocalChain(provider)
        verifiedLocalChain = true
        if (requestId === inspectionSequence.current)
          setLocalChainState('verified')
      } else if (requestId === inspectionSequence.current) {
        setLocalChainState('not-selected')
      }
      const nextInspection = await inspectProtocol(provider)
      if (requestId === inspectionSequence.current)
        setInspection(nextInspection)
    } catch (error) {
      if (requestId === inspectionSequence.current) {
        setLocalChainState(
          verifiedLocalChain
            ? 'verified'
            : selectedLocalChain
              ? 'mismatch'
              : 'not-selected',
        )
        setInspectionError(
          describeRpcError(
            error,
            'Contract code could not be inspected through the wallet.',
          ),
        )
      }
    }
  }, [session.chainId, session.provider, session.status])
  useEffect(() => {
    void refreshInspection()
  }, [refreshInspection, session.chainId])
  useEffect(() => {
    setActionProblem(undefined)
    setResult(undefined)
  }, [session.account, session.chainId])
  const runAction = async (
    action: 'chain' | 'deploy' | 'post',
    operation: (
      onSubmitted: TransactionSubmitted,
    ) => Promise<TransactionReceipt | void>,
  ) => {
    let submittedHash: TransactionReceipt['hash'] | undefined
    const walletContext =
      session.account && session.chainId !== undefined && session.provider
        ? {
            account: session.account,
            chainId: session.chainId,
            provider: session.provider,
            walletName: session.name ?? 'Injected wallet',
          }
        : undefined
    const submittedContext =
      action !== 'chain' && walletContext
        ? {
            ...walletContext,
            action,
            id: ++transactionSequence.current,
            postBody: action === 'post' ? body : '',
            postMediaCid:
              action === 'post' ? (parsedMediaCid?.bytes ?? '0x') : '0x',
          }
        : undefined
    const operationId = ++operationSequence.current
    setBusyOperations((current) => [
      ...current,
      {
        action,
        context: walletContext,
        id: operationId,
        scope: action === 'chain' ? 'provider' : 'context',
      },
    ])
    setActionProblem(undefined)
    setResult(undefined)
    if (submittedContext) {
      setSubmittedTransactions((current) =>
        current.filter(
          (transaction) =>
            transaction.status !== 'failed' ||
            !sameTransactionContext(transaction, submittedContext),
        ),
      )
    }
    try {
      const nextReceipt = await operation((hash) => {
        if (!submittedContext) return
        submittedHash = hash
        setSubmittedTransactions((current) => [
          ...current.filter(
            (transaction) => transaction.id !== submittedContext.id,
          ),
          { ...submittedContext, hash, status: 'pending' },
        ])
      })
      if (nextReceipt && submittedContext) {
        setResult({ ...submittedContext, receipt: nextReceipt })
        setSubmittedTransactions((current) =>
          current.filter(
            (transaction) => transaction.id !== submittedContext.id,
          ),
        )
        if (action === 'post') {
          onPostConfirmed({
            blockHash: nextReceipt.blockHash,
            blockNumber: nextReceipt.blockNumber,
            chainId: submittedContext.chainId,
            expectedPost: {
              author: submittedContext.account,
              body: submittedContext.postBody,
              mediaCid: submittedContext.postMediaCid,
            },
            hash: nextReceipt.hash,
            provider: submittedContext.provider,
          })
        }
      }
      if (action === 'deploy') await refreshInspection()
    } catch (error) {
      if (submittedHash && submittedContext) {
        setSubmittedTransactions((current) => [
          ...current.filter(
            (transaction) => transaction.id !== submittedContext.id,
          ),
          {
            ...submittedContext,
            hash: submittedHash,
            status: isTransactionRevertedError(error) ? 'failed' : 'unknown',
          },
        ])
      } else if (
        submittedContext &&
        isTransactionSubmissionUnknownError(error)
      ) {
        setSubmittedTransactions((current) => [
          ...current.filter(
            (transaction) => transaction.id !== submittedContext.id,
          ),
          { ...submittedContext, status: 'ambiguous' },
        ])
      } else if (submittedContext) {
        setSubmittedTransactions((current) =>
          current.filter(
            (transaction) => transaction.id !== submittedContext.id,
          ),
        )
      }
      if (action !== 'chain') await refreshInspection()
      setActionProblem({
        context: submittedContext,
        message: describeRpcError(error, 'The wallet action failed.'),
      })
    } finally {
      setBusyOperations((current) =>
        current.filter((operation) => operation.id !== operationId),
      )
    }
  }
  const handleLocalChain = () => {
    const provider = session.provider
    if (!provider) return
    void runAction('chain', async () => {
      await switchToLocalChain(provider)
      await refresh()
      await refreshInspection()
    })
  }
  const handleDeploy = () => {
    const provider = session.provider
    const account = session.account
    const chainId = session.chainId
    if (!provider || !account || chainId === undefined) return
    void runAction('deploy', async (onSubmitted) => {
      return deployProtocol(provider, account, chainId, onSubmitted)
    })
  }
  const handlePublish = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const provider = session.provider
    const account = session.account
    const chainId = session.chainId
    if (
      !provider ||
      !account ||
      chainId === undefined ||
      mediaCidError !== undefined
    )
      return
    void runAction('post', async (onSubmitted) => {
      const nextReceipt = await publishPost(
        provider,
        account,
        chainId,
        { body, mediaCid: parsedMediaCid?.bytes ?? '0x' },
        onSubmitted,
      )
      setBody('')
      setMediaCidInput('')
      return nextReceipt
    })
  }
  const handleRetryReceipt = (transaction: SubmittedTransaction) => {
    const hash = transaction.hash
    if (
      transaction.status !== 'unknown' ||
      !hash ||
      !transactionContextMatchesSession(transaction, session)
    ) {
      return
    }
    const provider = transaction.provider
    const operationId = ++operationSequence.current
    void (async () => {
      setBusyOperations((current) => [
        ...current,
        {
          action: 'receipt',
          context: transaction,
          id: operationId,
          scope: 'context',
        },
      ])
      setActionProblem(undefined)
      setResult(undefined)
      setSubmittedTransactions((current) =>
        current.map((candidate) =>
          candidate.id === transaction.id
            ? { ...candidate, status: 'pending' }
            : candidate,
        ),
      )
      try {
        if (session.provider !== provider) {
          throw new Error(
            'Reconnect the wallet that submitted this transaction to check its receipt.',
          )
        }
        const guard = await createTransactionGuard(
          provider,
          transaction.account,
          transaction.chainId,
        )
        const nextReceipt = await waitForTransactionReceipt(provider, hash, {
          assertCurrentChain: guard.assertSubmission,
          assertUnchanged: guard.assertUnchanged,
          expectedPost:
            transaction.action === 'post'
              ? {
                  author: transaction.account,
                  body: transaction.postBody,
                  mediaCid: transaction.postMediaCid,
                }
              : undefined,
          expectProtocol: transaction.action === 'deploy',
          selectedChainId: transaction.chainId,
        }).finally(guard.release)
        setResult({ ...transaction, receipt: nextReceipt })
        setSubmittedTransactions((current) =>
          current.filter((candidate) => candidate.id !== transaction.id),
        )
        if (transaction.action === 'post') {
          setBody('')
          setMediaCidInput('')
          onPostConfirmed({
            blockHash: nextReceipt.blockHash,
            blockNumber: nextReceipt.blockNumber,
            chainId: transaction.chainId,
            expectedPost: {
              author: transaction.account,
              body: transaction.postBody,
              mediaCid: transaction.postMediaCid,
            },
            hash: nextReceipt.hash,
            provider: transaction.provider,
          })
        } else await refreshInspection()
      } catch (error) {
        setSubmittedTransactions((current) =>
          current.map((candidate) =>
            candidate.id === transaction.id
              ? {
                  ...candidate,
                  status: isTransactionRevertedError(error)
                    ? 'failed'
                    : 'unknown',
                }
              : candidate,
          ),
        )
        setActionProblem({
          context: transaction,
          message: describeRpcError(
            error,
            'The transaction receipt could not be read.',
          ),
        })
      } finally {
        setBusyOperations((current) =>
          current.filter((operation) => operation.id !== operationId),
        )
      }
    })()
  }
  const bodyBytes = getPostBodyByteLength(body)
  const connected =
    session.status === 'connected' &&
    Boolean(session.account && session.provider)
  const activeActionProblem =
    actionProblem?.context === undefined ||
    transactionContextMatchesSession(actionProblem.context, session)
      ? actionProblem
      : undefined
  const activeResult =
    result && transactionContextMatchesSession(result, session)
      ? result
      : undefined
  const activeSubmittedTransactions = submittedTransactions.filter(
    (transaction) => transactionContextMatchesSession(transaction, session),
  )
  const busyAction = busyOperations.findLast((operation) =>
    busyOperationMatchesSession(operation, session),
  )?.action
  const transactionWriteLocked = activeSubmittedTransactions.some(
    (transaction) => transaction.status !== 'failed',
  )
  return (
    <section className="wallet-panel" aria-labelledby="wallet-panel-title">
      <div className="wallet-panel-heading">
        <div>
          <p className="eyebrow">Public transaction console</p>
          <h2 id="wallet-panel-title">
            Put your reputation where the chain is.
          </h2>
        </div>
        <p className="privacy-warning">
          There are no private actions. Your account, content, and transaction
          history are public forever.
        </p>
      </div>
      <div className="wallet-console">
        <div className="wallet-connect">
          <h3>1. Connect a wallet</h3>
          {wallets.length === 0 ? (
            <p>
              No injected wallet found. Install or unlock MetaMask, then reload.
            </p>
          ) : (
            <div className="wallet-buttons" aria-label="Available wallets">
              {wallets.map((wallet) => (
                <button
                  type="button"
                  key={wallet.id}
                  disabled={
                    session.status === 'connecting' ||
                    busyAction !== undefined ||
                    transactionWriteLocked
                  }
                  onClick={() => void connect(wallet)}
                >
                  {session.status === 'connecting' &&
                  session.name === wallet.name
                    ? 'Waiting for wallet…'
                    : `Connect ${wallet.name}`}
                </button>
              ))}
            </div>
          )}
          {session.error ? (
            <p className="error-message" role="alert">
              {session.error}
            </p>
          ) : null}
          {connected && session.account ? (
            <dl className="connection-facts">
              <div>
                <dt>Account</dt>
                <dd title={session.account}>{shortAddress(session.account)}</dd>
              </div>
              <div>
                <dt>Chain ID</dt>
                <dd>{session.chainId?.toString() ?? 'Unknown'}</dd>
              </div>
            </dl>
          ) : null}
        </div>
        <div className="wallet-network">
          <h3>2. Verify the protocol</h3>
          {!connected ? (
            <p>
              Connect first. Contract checks use the wallet’s current chain.
            </p>
          ) : (
            <>
              <p>
                {inspection
                  ? inspectionCopy[inspection.kind]
                  : (inspectionError ??
                    'Inspecting the predetermined address…')}
              </p>
              <code className="protocol-address">{PROTOCOL_ADDRESS}</code>
              <div className="network-actions">
                <button
                  type="button"
                  disabled={
                    busyAction !== undefined ||
                    transactionWriteLocked ||
                    localChainState === 'checking' ||
                    localChainState === 'verified'
                  }
                  onClick={handleLocalChain}
                >
                  {busyAction === 'chain'
                    ? 'Opening wallet…'
                    : localChainState === 'checking'
                      ? 'Verifying local Anvil…'
                      : localChainState === 'verified'
                        ? 'Local Anvil verified'
                        : session.chainId === LOCAL_CHAIN_ID
                          ? 'Verify local Anvil'
                          : 'Switch to local Anvil'}
                </button>
                {inspectionError && localChainState !== 'mismatch' ? (
                  <button
                    type="button"
                    disabled={
                      busyAction !== undefined || transactionWriteLocked
                    }
                    onClick={() => void refreshInspection()}
                  >
                    Retry verification
                  </button>
                ) : null}
                {inspection?.kind === 'deployable' ? (
                  <button
                    className="button-accent"
                    type="button"
                    disabled={
                      busyAction !== undefined || transactionWriteLocked
                    }
                    onClick={handleDeploy}
                  >
                    {busyAction === 'deploy'
                      ? 'Deploying…'
                      : 'Deploy protocol here'}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
        <div className="wallet-publish">
          <h3>3. Publish a post</h3>
          {!connected || inspection?.kind !== 'ready' ? (
            <p>A verified v1 deployment is required before posting.</p>
          ) : (
            <form onSubmit={handlePublish}>
              <label htmlFor="post-body">Permanent public statement</label>
              <textarea
                id="post-body"
                maxLength={MAX_POST_BODY_BYTES}
                rows={5}
                value={body}
                disabled={busyAction === 'post' || transactionWriteLocked}
                onChange={(event) => setBody(event.target.value)}
                placeholder="What should survive every rebrand?"
              />
              <label htmlFor="post-media-cid">
                IPFS media CID (already uploaded, optional)
              </label>
              <input
                id="post-media-cid"
                aria-describedby="post-media-cid-help"
                aria-invalid={mediaCidError ? true : undefined}
                disabled={busyAction === 'post' || transactionWriteLocked}
                maxLength={MAX_MEDIA_CID_TEXT_LENGTH}
                onChange={(event) => setMediaCidInput(event.target.value)}
                placeholder="bafy… or Qm…"
                type="text"
                value={mediaCidInput}
              />
              <p
                className={
                  mediaCidError ? 'input-help error-message' : 'input-help'
                }
                id="post-media-cid-help"
              >
                {mediaCidError ??
                  (parsedMediaCid
                    ? `Will commit canonical CIDv1 bytes (${parsedMediaCid.codec}).`
                    : 'This records an address only. It does not upload or guarantee storage.')}
              </p>
              <div className="compose-actions">
                <span
                  className={
                    bodyBytes > MAX_POST_BODY_BYTES
                      ? 'limit-exceeded'
                      : undefined
                  }
                >
                  {bodyBytes} / {MAX_POST_BODY_BYTES} UTF-8 bytes
                </span>
                <button
                  className="button-accent"
                  type="submit"
                  disabled={
                    busyAction !== undefined ||
                    transactionWriteLocked ||
                    (bodyBytes === 0 && parsedMediaCid === undefined) ||
                    mediaCidError !== undefined ||
                    bodyBytes > MAX_POST_BODY_BYTES
                  }
                >
                  {busyAction === 'post' ? 'Publishing…' : 'Publish on-chain'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
      {activeActionProblem ? (
        <p className="error-message action-feedback" role="alert">
          {activeActionProblem.message}
        </p>
      ) : null}
      {submittedTransactions.map((transaction) => {
        const currentContext = transactionContextMatchesSession(
          transaction,
          session,
        )
        return (
          <TransactionStatus
            currentContext={currentContext}
            key={transaction.id}
            transaction={transaction}
            onRetry={() => handleRetryReceipt(transaction)}
            onDismiss={() => {
              setSubmittedTransactions((current) =>
                current.filter((candidate) => candidate.id !== transaction.id),
              )
              if (currentContext) setActionProblem(undefined)
            }}
          />
        )
      })}
      {activeResult ? (
        <TransactionResult receipt={activeResult.receipt} />
      ) : null}
    </section>
  )
}
