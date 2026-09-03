import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { describeRpcError, parseChainId } from './ethereum'
import {
  deployProtocol,
  getPostBodyByteLength,
  inspectProtocol,
  LOCAL_CHAIN_ID,
  MAX_POST_BODY_BYTES,
  PROTOCOL_ADDRESS,
  publishPost,
  switchToLocalChain,
  verifyLocalChain,
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
  hash: TransactionReceipt['hash']
  needsAttention: boolean
}

function TransactionPending({
  transaction,
}: {
  transaction: SubmittedTransaction
}) {
  const label = transaction.action === 'deploy' ? 'Deployment' : 'Post'

  return (
    <p className="transaction-pending action-feedback" role="status">
      {label} submitted ·{' '}
      <code title={transaction.hash}>{shortAddress(transaction.hash)}</code>.{' '}
      {transaction.needsAttention
        ? 'Its final status is unknown. Check this hash in your wallet before trying again.'
        : 'Waiting for an on-chain receipt…'}
    </p>
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
  const [busyAction, setBusyAction] = useState<'chain' | 'deploy' | 'post'>()
  const [actionError, setActionError] = useState<string>()
  const [receipt, setReceipt] = useState<TransactionReceipt>()
  const [submittedTransaction, setSubmittedTransaction] =
    useState<SubmittedTransaction>()
  const [body, setBody] = useState('')
  const inspectionSequence = useRef(0)

  const refreshInspection = useCallback(async () => {
    const requestId = ++inspectionSequence.current
    let selectedLocalChain = session.chainId === LOCAL_CHAIN_ID
    let verifiedLocalChain = false
    setInspection(undefined)
    setInspectionError(undefined)
    if (!session.provider || session.status !== 'connected') {
      setLocalChainState('not-selected')
      return
    }

    try {
      const selectedChainId = parseChainId(
        await session.provider.request({ method: 'eth_chainId' }),
      )
      selectedLocalChain = selectedChainId === LOCAL_CHAIN_ID
      if (selectedChainId === LOCAL_CHAIN_ID) {
        if (requestId === inspectionSequence.current)
          setLocalChainState('checking')
        await verifyLocalChain(session.provider)
        verifiedLocalChain = true
        if (requestId === inspectionSequence.current)
          setLocalChainState('verified')
      } else if (requestId === inspectionSequence.current) {
        setLocalChainState('not-selected')
      }

      const nextInspection = await inspectProtocol(session.provider)
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
    setBusyAction(action)
    setActionError(undefined)
    setReceipt(undefined)
    setSubmittedTransaction(undefined)

    try {
      const nextReceipt = await operation((hash) => {
        if (action === 'chain') return
        submittedHash = hash
        setSubmittedTransaction({
          action,
          hash,
          needsAttention: false,
        })
      })
      if (nextReceipt) {
        setReceipt(nextReceipt)
        setSubmittedTransaction(undefined)
      }
    } catch (error) {
      if (submittedHash && action !== 'chain') {
        setSubmittedTransaction({
          action,
          hash: submittedHash,
          needsAttention: true,
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
    if (!provider || !account) return
    void runAction('deploy', async (onSubmitted) => {
      const nextReceipt = await deployProtocol(provider, account, onSubmitted)
      await refreshInspection()
      return nextReceipt
    })
  }

  const handlePublish = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const provider = session.provider
    const account = session.account
    if (!provider || !account) return
    void runAction('post', async (onSubmitted) => {
      const nextReceipt = await publishPost(
        provider,
        account,
        body,
        onSubmitted,
      )
      setBody('')
      return nextReceipt
    })
  }

  const bodyBytes = getPostBodyByteLength(body)
  const connected =
    session.status === 'connected' &&
    Boolean(session.account && session.provider)

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
                    submittedTransaction !== undefined
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
                    submittedTransaction !== undefined ||
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
                      busyAction !== undefined ||
                      submittedTransaction !== undefined
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
                      busyAction !== undefined ||
                      submittedTransaction !== undefined
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
                rows={5}
                value={body}
                disabled={submittedTransaction !== undefined}
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
                    submittedTransaction !== undefined ||
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
        <TransactionPending transaction={submittedTransaction} />
      ) : null}
      {receipt ? <TransactionResult receipt={receipt} /> : null}
    </section>
  )
}
