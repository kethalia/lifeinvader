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
import type { WalletSessionController } from './wallet-session'
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
type SubmittedTransaction = {
  account: Address
  action: 'deploy' | 'post'
  chainId: bigint
  hash?: TransactionReceipt['hash']
  postBody: string
  postMediaCid: Hex
  provider: Eip1193Provider
  status: 'ambiguous' | 'failed' | 'pending' | 'unknown'
  walletName: string
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
      transaction.status === 'ambiguous' ? (
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
  const [busyAction, setBusyAction] = useState<
    'chain' | 'deploy' | 'post' | 'receipt'
  >()
  const [actionError, setActionError] = useState<string>()
  const [receipt, setReceipt] = useState<TransactionReceipt>()
  const [submittedTransaction, setSubmittedTransaction] =
    useState<SubmittedTransaction>()
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
    setActionError(undefined)
    setReceipt(undefined)
  }, [session.account, session.chainId])
  const runAction = async (
    action: 'chain' | 'deploy' | 'post',
    operation: (
      onSubmitted: TransactionSubmitted,
    ) => Promise<TransactionReceipt | void>,
  ) => {
    let submittedHash: TransactionReceipt['hash'] | undefined
    const submittedContext =
      action !== 'chain' &&
      session.account &&
      session.chainId !== undefined &&
      session.provider
        ? {
            account: session.account,
            action,
            chainId: session.chainId,
            postBody: action === 'post' ? body : '',
            postMediaCid:
              action === 'post' ? (parsedMediaCid?.bytes ?? '0x') : '0x',
            provider: session.provider,
            walletName: session.name ?? 'Injected wallet',
          }
        : undefined
    setBusyAction(action)
    setActionError(undefined)
    setReceipt(undefined)
    if (action !== 'chain') setSubmittedTransaction(undefined)
    try {
      const nextReceipt = await operation((hash) => {
        if (!submittedContext) return
        submittedHash = hash
        setSubmittedTransaction({
          ...submittedContext,
          hash,
          status: 'pending',
        })
      })
      if (nextReceipt) {
        setReceipt(nextReceipt)
        setSubmittedTransaction(undefined)
        if (action === 'post' && submittedContext) {
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
        setSubmittedTransaction({
          ...submittedContext,
          hash: submittedHash,
          status: isTransactionRevertedError(error) ? 'failed' : 'unknown',
        })
      } else if (
        submittedContext &&
        isTransactionSubmissionUnknownError(error)
      ) {
        setSubmittedTransaction({
          ...submittedContext,
          status: 'ambiguous',
        })
      }
      if (action !== 'chain') await refreshInspection()
      setActionError(describeRpcError(error, 'The wallet action failed.'))
    } finally {
      setBusyAction(undefined)
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
  const handleRetryReceipt = () => {
    const transaction = submittedTransaction
    const hash = transaction?.hash
    if (transaction?.status !== 'unknown' || !hash) return
    const provider = transaction.provider
    void (async () => {
      setBusyAction('receipt')
      setActionError(undefined)
      setReceipt(undefined)
      setSubmittedTransaction({ ...transaction, status: 'pending' })
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
        setReceipt(nextReceipt)
        setSubmittedTransaction(undefined)
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
        setSubmittedTransaction({
          ...transaction,
          status: isTransactionRevertedError(error) ? 'failed' : 'unknown',
        })
        setActionError(
          describeRpcError(error, 'The transaction receipt could not be read.'),
        )
      } finally {
        setBusyAction(undefined)
      }
    })()
  }
  const bodyBytes = getPostBodyByteLength(body)
  const connected =
    session.status === 'connected' &&
    Boolean(session.account && session.provider)
  const submittedTransactionMatchesSession =
    submittedTransaction !== undefined &&
    session.status === 'connected' &&
    submittedTransaction.provider === session.provider &&
    submittedTransaction.chainId === session.chainId &&
    submittedTransaction.account.toLowerCase() ===
      session.account?.toLowerCase()
  const transactionWriteLocked =
    submittedTransactionMatchesSession &&
    submittedTransaction.status !== 'failed'
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
      {actionError ? (
        <p className="error-message action-feedback" role="alert">
          {actionError}
        </p>
      ) : null}
      {submittedTransaction ? (
        <TransactionStatus
          currentContext={submittedTransactionMatchesSession}
          transaction={submittedTransaction}
          onRetry={handleRetryReceipt}
          onDismiss={() => {
            setSubmittedTransaction(undefined)
            setActionError(undefined)
          }}
        />
      ) : null}
      {receipt ? <TransactionResult receipt={receipt} /> : null}
    </section>
  )
}
