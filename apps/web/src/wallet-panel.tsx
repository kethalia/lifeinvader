import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import {
  beforeDeadline,
  describeRpcError,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
} from './ethereum'
import {
  deployProtocol,
  getPostBodyByteLength,
  inspectProtocol,
  isTransactionRevertedError,
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
import { useWalletSession } from './wallet-session'

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
      Confirmed in block {receipt.blockNumber.toString()} ·{' '}
      <code title={receipt.hash}>{shortAddress(receipt.hash)}</code>
    </p>
  )
}

type SubmittedTransaction = {
  action: 'deploy' | 'post'
  chainId?: bigint
  hash: TransactionReceipt['hash']
  status: 'pending' | 'unknown' | 'failed'
}

function TransactionStatus({
  onDismiss,
  onRetry,
  transaction,
}: {
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
        : 'Its final status is unknown. Check this hash before trying again.'

  return (
    <div className="transaction-pending action-feedback" role="status">
      <span>
        {label} submitted ·{' '}
        <code title={transaction.hash}>{shortAddress(transaction.hash)}</code>.{' '}
        {statusCopy}
      </span>
      {transaction.status === 'unknown' ? (
        <div className="transaction-recovery-actions">
          <button type="button" onClick={onRetry}>
            Check receipt again
          </button>
          <button type="button" onClick={onDismiss}>
            I checked this hash
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function WalletPanel() {
  const wallets = useWalletProviders()
  const { connect, refresh, session } = useWalletSession()
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
    const submittedChainId = session.chainId
    setBusyAction(action)
    setActionError(undefined)
    setReceipt(undefined)
    if (action !== 'chain') setSubmittedTransaction(undefined)

    try {
      const nextReceipt = await operation((hash) => {
        if (action === 'chain') return
        submittedHash = hash
        setSubmittedTransaction({
          action,
          chainId: submittedChainId,
          hash,
          status: 'pending',
        })
      })
      if (nextReceipt) {
        setReceipt(nextReceipt)
        setSubmittedTransaction(undefined)
      }
      if (action === 'deploy') await refreshInspection()
    } catch (error) {
      if (submittedHash && action !== 'chain') {
        setSubmittedTransaction({
          action,
          chainId: submittedChainId,
          hash: submittedHash,
          status: isTransactionRevertedError(error) ? 'failed' : 'unknown',
        })
      }
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
    if (!provider || !account || chainId === undefined) return
    void runAction('post', async (onSubmitted) => {
      const nextReceipt = await publishPost(
        provider,
        account,
        chainId,
        body,
        onSubmitted,
      )
      setBody('')
      return nextReceipt
    })
  }

  const handleRetryReceipt = () => {
    const provider = session.provider
    const transaction = submittedTransaction
    if (!provider || transaction?.status !== 'unknown') return

    void (async () => {
      setBusyAction('receipt')
      setActionError(undefined)
      setReceipt(undefined)
      setSubmittedTransaction({ ...transaction, status: 'pending' })

      try {
        const assertCurrentChain = async () => {
          if (transaction.chainId === undefined) {
            throw new Error(
              'The original chain is unknown. Check the transaction in your wallet.',
            )
          }
          const selectedChainId = parseChainId(
            await provider.request({ method: 'eth_chainId' }),
          )
          if (selectedChainId !== transaction.chainId) {
            throw new Error(
              `Switch the wallet back to chain ${transaction.chainId.toString()} to check this receipt.`,
            )
          }
        }
        const nextReceipt = await waitForTransactionReceipt(
          provider,
          transaction.hash,
          { assertCurrentChain },
        )
        setReceipt(nextReceipt)
        setSubmittedTransaction(undefined)
        if (transaction.action === 'post') setBody('')
        else await refreshInspection()
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
  const transactionPending = submittedTransaction?.status === 'pending'
  const transactionWriteLocked =
    submittedTransaction !== undefined &&
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
                    transactionPending
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
                    transactionPending ||
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
                    disabled={busyAction !== undefined || transactionPending}
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
                    bodyBytes === 0 ||
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
