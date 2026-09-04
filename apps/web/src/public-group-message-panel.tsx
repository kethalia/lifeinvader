import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Address, Hash, Hex } from 'viem'
import {
  synchronizeGroupMessageStream,
  type GroupMessageStreamSnapshot,
  type GroupMessageStreamSynchronizer,
} from './group-message-stream'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import {
  decodeMediaCid,
  MAX_MEDIA_CID_TEXT_LENGTH,
  parseMediaCid,
} from './media-cid'
import {
  createTransactionGuard,
  getPostBodyByteLength,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  MAX_POST_BODY_BYTES,
  sendGroupMessage,
  waitForTransactionReceipt,
  type TransactionReceipt,
} from './protocol'
import type { PublishedGroupMessage } from './protocol-events'
import type { WalletSession } from './wallet-session'
import { useWalletWriteBoundary } from './wallet-write-boundary'

const FAILED_ATTEMPT_HISTORY_LIMIT = 8
const MAX_UINT256 = (1n << 256n) - 1n

type GroupReadContext = {
  chainId: bigint
  groupId: bigint
  provider: Eip1193Provider
}

type GroupMessageContext = GroupReadContext & {
  account: Address
  body: string
  composeRevision: number
  mediaCid: Hex
  walletName: string
}

type GroupMessageAttempt = GroupMessageContext & {
  hash?: Hash
  id: number
  message?: string
  status: 'ambiguous' | 'failed' | 'opening' | 'pending' | 'unknown'
}

type ConfirmedGroupMessageReceipt = TransactionReceipt & {
  messageId: bigint
}

type CompletedGroupMessage = GroupMessageContext & {
  receipt: ConfirmedGroupMessageReceipt
}

type GroupMessageProblem = GroupMessageContext & {
  id: number
  message: string
}

type GroupMessageReadState =
  | { phase: 'idle' }
  | { context: GroupReadContext; phase: 'loading' }
  | {
      context: GroupReadContext
      phase: 'partial'
      snapshot: GroupMessageStreamSnapshot
    }
  | {
      context: GroupReadContext
      phase: 'complete'
      snapshot: GroupMessageStreamSnapshot
    }
  | { context: GroupReadContext; message: string; phase: 'failed' }

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function validGroupId(groupId: bigint | undefined): groupId is bigint {
  return groupId !== undefined && groupId > 0n && groupId <= MAX_UINT256
}

function accountChainMatchesSession(
  context: GroupMessageContext,
  session: WalletSession,
) {
  return (
    session.status === 'connected' &&
    context.chainId === session.chainId &&
    context.account.toLowerCase() === session.account?.toLowerCase()
  )
}

function contextMatchesSession(
  context: GroupMessageContext,
  session: WalletSession,
) {
  return (
    accountChainMatchesSession(context, session) &&
    context.provider === session.provider
  )
}

function contextMatchesSelection(
  context: GroupMessageContext,
  session: WalletSession,
  selectedGroupId: bigint | undefined,
) {
  return (
    contextMatchesSession(context, session) &&
    context.groupId === selectedGroupId
  )
}

function readContextMatchesSelection(
  context: GroupReadContext,
  session: WalletSession,
  selectedGroupId: bigint | undefined,
) {
  return (
    session.status === 'connected' &&
    context.provider === session.provider &&
    context.chainId === session.chainId &&
    context.groupId === selectedGroupId
  )
}

function sameWalletContext(
  first: GroupMessageContext,
  second: GroupMessageContext,
) {
  return (
    first.provider === second.provider &&
    first.chainId === second.chainId &&
    first.account.toLowerCase() === second.account.toLowerCase()
  )
}

function sameAccountChain(
  first: GroupMessageContext,
  second: GroupMessageContext,
) {
  return (
    first.chainId === second.chainId &&
    first.account.toLowerCase() === second.account.toLowerCase()
  )
}

function retainAttempts(attempts: GroupMessageAttempt[]) {
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

function readStatus(state: GroupMessageReadState) {
  if (state.phase === 'idle') {
    return 'Not loaded. Each click reads at most one bounded RPC log range for exactly this group.'
  }
  if (state.phase === 'loading') {
    return 'Reading one bounded range of confirmed public group messages…'
  }
  if (state.phase === 'partial') {
    if (state.snapshot.safeHead === undefined) {
      return `Lifeinvader group-message history can begin at block ${state.snapshot.startBlock.toString()}, but this chain does not have a confirmed head yet. No group-message log range was requested. Wait for deployment confirmations, then check again.`
    }
    if (state.snapshot.historyBoundaryKind === 'pending-confirmation') {
      return `The earliest possible Lifeinvader deployment block is ${state.snapshot.startBlock.toString()}, but the deployment itself has not reached the confirmed head ${state.snapshot.safeHead.toString()} yet. No group-message log range was requested. Wait for deployment confirmations, then check again.`
    }
    const reset = state.snapshot.cacheReset
      ? 'The disposable local message cache was reset. '
      : ''
    return `${reset}More confirmed group-message history remains from block ${state.snapshot.startBlock.toString()}. Indexed through block ${state.snapshot.indexedThrough?.toString() ?? 'none'} of confirmed head ${state.snapshot.safeHead.toString()}.`
  }
  if (state.phase === 'complete') {
    return `Caught up from block ${state.snapshot.startBlock.toString()} through confirmed block ${state.snapshot.safeHead?.toString() ?? 'none yet'}. Showing the newest retained page, oldest first.`
  }
  return state.message
}

function readButtonLabel(state: GroupMessageReadState) {
  if (state.phase === 'loading') return 'Reading group messages…'
  if (state.phase === 'partial') {
    return state.snapshot.historyBoundaryKind === 'pending-confirmation' ||
      state.snapshot.safeHead === undefined
      ? 'Check group-message confirmations'
      : 'Load next group message range'
  }
  if (state.phase === 'complete') return 'Check for newer group messages'
  if (state.phase === 'failed') return 'Retry public group messages'
  return 'Load confirmed group messages'
}

function GroupMediaCommitment({ value }: { value: Hex }) {
  try {
    const cid = decodeMediaCid(value)
    return (
      <div className="message-media-commitment">
        <span>IPFS media commitment · {cid.codec}</span>
        <code>{cid.text}</code>
        <span>Address only; availability is not guaranteed.</span>
      </div>
    )
  } catch {
    return (
      <div className="message-media-commitment invalid-media-commitment">
        <span>Invalid media CID bytes committed on-chain.</span>
        <code>{value}</code>
      </div>
    )
  }
}

function GroupMessageList({
  messages,
}: {
  messages: readonly PublishedGroupMessage[]
}) {
  if (messages.length === 0) {
    return (
      <p className="message-empty-result">
        No confirmed messages were found in the newest retained page for this
        public group.
      </p>
    )
  }
  return (
    <ol className="public-message-list group-message-list">
      {[...messages].reverse().map((message) => (
        <li key={`${message.blockHash}:${message.logIndex}`}>
          <div className="public-message-heading">
            <strong title={message.sender}>{shortValue(message.sender)}</strong>
            <span>Message #{message.messageId.toString()}</span>
          </div>
          {message.body ? (
            <p className="public-message-body">{message.body}</p>
          ) : null}
          {message.mediaCid !== '0x' ? (
            <GroupMediaCommitment value={message.mediaCid} />
          ) : null}
          <p className="public-message-meta">
            Group #{message.groupId.toString()} · block{' '}
            {message.blockNumber.toString()} ·{' '}
            <code title={message.transactionHash}>
              {shortValue(message.transactionHash)}
            </code>
          </p>
        </li>
      ))}
    </ol>
  )
}

export function PublicGroupMessagePanel({
  readProvider,
  selectedGroupId,
  sendMessage = sendGroupMessage,
  session,
  synchronize = synchronizeGroupMessageStream,
  waitForReceipt = waitForTransactionReceipt,
}: {
  readProvider?: Eip1193Provider
  selectedGroupId?: bigint
  sendMessage?: typeof sendGroupMessage
  session: WalletSession
  synchronize?: GroupMessageStreamSynchronizer
  waitForReceipt?: typeof waitForTransactionReceipt
}) {
  const [body, setBody] = useState('')
  const [mediaCidInput, setMediaCidInput] = useState('')
  const [publicAcknowledged, setPublicAcknowledged] = useState(false)
  const [attempts, setAttempts] = useState<GroupMessageAttempt[]>([])
  const [completed, setCompleted] = useState<CompletedGroupMessage[]>([])
  const [problems, setProblems] = useState<GroupMessageProblem[]>([])
  const [readState, setReadState] = useState<GroupMessageReadState>({
    phase: 'idle',
  })
  const activeRead = useRef<AbortController | undefined>(undefined)
  const composeRevision = useRef(0)
  const operationSequence = useRef(0)
  const readSequence = useRef(0)
  const selectedGroupIdRef = useRef(selectedGroupId)
  const historySession = useMemo<WalletSession>(
    () =>
      readProvider !== undefined && readProvider !== session.provider
        ? { ...session, provider: readProvider }
        : session,
    [readProvider, session],
  )
  const historySessionRef = useRef(historySession)
  const walletSessionRef = useRef(session)
  selectedGroupIdRef.current = selectedGroupId
  historySessionRef.current = historySession
  walletSessionRef.current = session

  const connected =
    session.status === 'connected' &&
    session.account !== undefined &&
    session.chainId !== undefined &&
    session.provider !== undefined
  const readsSelectedRpc =
    connected && readProvider !== undefined && readProvider !== session.provider
  const selected = validGroupId(selectedGroupId)

  useEffect(() => {
    readSequence.current += 1
    activeRead.current?.abort()
    activeRead.current = undefined
    setReadState({ phase: 'idle' })
    return () => {
      readSequence.current += 1
      activeRead.current?.abort()
      activeRead.current = undefined
    }
  }, [
    historySession.chainId,
    historySession.provider,
    historySession.status,
    selectedGroupId,
  ])

  let parsedMediaCid: ReturnType<typeof parseMediaCid>
  let mediaCidError: string | undefined
  try {
    parsedMediaCid = parseMediaCid(mediaCidInput)
  } catch (error) {
    mediaCidError =
      error instanceof Error ? error.message : 'The media CID is invalid.'
  }
  const bodyBytes = getPostBodyByteLength(body)
  const emptyPayload = bodyBytes === 0 && parsedMediaCid === undefined
  const currentAttempts = attempts.filter((attempt) =>
    accountChainMatchesSession(attempt, session),
  )
  const localWriteLocked = currentAttempts.some(
    (attempt) => attempt.status !== 'failed',
  )
  const lockedByAnotherConsole = useWalletWriteBoundary(
    'group-messages',
    localWriteLocked,
  )
  const writeLocked = localWriteLocked || lockedByAnotherConsole
  const activeProblem = problems.findLast((problem) =>
    contextMatchesSelection(problem, session, selectedGroupId),
  )
  const activeCompletion = completed.findLast((message) =>
    contextMatchesSelection(message, session, selectedGroupId),
  )
  const displayedReadState =
    readState.phase === 'idle' ||
    readContextMatchesSelection(
      readState.context,
      historySession,
      selectedGroupId,
    )
      ? readState
      : ({ phase: 'idle' } as const)

  const clearExactDraft = (context: GroupMessageContext) => {
    if (
      context.composeRevision !== composeRevision.current ||
      !contextMatchesSession(context, walletSessionRef.current) ||
      selectedGroupIdRef.current !== context.groupId
    ) {
      return
    }
    composeRevision.current += 1
    setBody('')
    setMediaCidInput('')
    setPublicAcknowledged(false)
  }

  const finishMessage = (
    context: GroupMessageContext,
    id: number,
    receipt: TransactionReceipt,
  ) => {
    if (receipt.messageId === undefined) {
      throw new Error(
        'The confirmed group message transaction did not return its ID.',
      )
    }
    const confirmedReceipt = {
      ...receipt,
      messageId: receipt.messageId,
    } satisfies ConfirmedGroupMessageReceipt
    setAttempts((current) => current.filter((attempt) => attempt.id !== id))
    setProblems((current) =>
      current.filter((problem) => !sameWalletContext(problem, context)),
    )
    setCompleted((current) =>
      [
        ...current.filter((message) => !sameWalletContext(message, context)),
        { ...context, receipt: confirmedReceipt },
      ].slice(-8),
    )
    clearExactDraft(context)
  }

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      !selected ||
      mediaCidError ||
      bodyBytes > MAX_POST_BODY_BYTES ||
      emptyPayload ||
      !publicAcknowledged ||
      writeLocked
    ) {
      return
    }
    const id = ++operationSequence.current
    const context: GroupMessageContext = {
      account,
      body,
      chainId,
      composeRevision: composeRevision.current,
      groupId: selectedGroupId,
      mediaCid: parsedMediaCid?.bytes ?? '0x',
      provider,
      walletName: session.name ?? 'Injected wallet',
    }
    let submittedHash: Hash | undefined
    setProblems((current) =>
      current.filter((problem) => !sameWalletContext(problem, context)),
    )
    setCompleted((current) =>
      current.filter((message) => !sameWalletContext(message, context)),
    )
    setAttempts((current) =>
      retainAttempts([
        ...current.filter(
          (attempt) =>
            attempt.status !== 'failed' || !sameWalletContext(attempt, context),
        ),
        { ...context, id, status: 'opening' as const },
      ]),
    )
    void (async () => {
      try {
        const receipt = await sendMessage(
          provider,
          account,
          chainId,
          context.groupId,
          { body: context.body, mediaCid: context.mediaCid },
          (hash) => {
            submittedHash = hash
            setAttempts((current) =>
              current.map((attempt) =>
                attempt.id === id
                  ? { ...attempt, hash, status: 'pending' }
                  : attempt,
              ),
            )
          },
        )
        finishMessage(context, id, receipt)
      } catch (error) {
        const message = describeRpcError(
          error,
          'The public group message transaction failed.',
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
          setProblems((current) =>
            [...current, { ...context, id, message }].slice(-8),
          )
        }
      }
    })()
  }

  const retryReceipt = (attempt: GroupMessageAttempt) => {
    const hash = attempt.hash
    if (
      attempt.status !== 'unknown' ||
      !hash ||
      !contextMatchesSession(attempt, session) ||
      attempts.some(
        (candidate) =>
          candidate.id !== attempt.id &&
          candidate.status !== 'failed' &&
          sameAccountChain(candidate, attempt),
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
            'Reconnect the wallet that submitted this group message to check its receipt.',
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
          expectedGroupMessage: {
            body: attempt.body,
            groupId: attempt.groupId,
            mediaCid: attempt.mediaCid,
            sender: attempt.account,
          },
          selectedChainId: attempt.chainId,
        }).finally(guard.release)
        finishMessage(attempt, attempt.id, receipt)
      } catch (error) {
        setAttempts((current) =>
          retainAttempts(
            current.map((candidate) =>
              candidate.id === attempt.id
                ? {
                    ...candidate,
                    message: describeRpcError(
                      error,
                      'The public group message receipt could not be read.',
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
    const chainId = historySession.chainId
    const provider = historySession.provider
    if (
      session.status !== 'connected' ||
      chainId === undefined ||
      !provider ||
      !selected ||
      displayedReadState.phase === 'loading'
    ) {
      return
    }
    const context: GroupReadContext = {
      chainId,
      groupId: selectedGroupId,
      provider,
    }
    activeRead.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    const requestId = ++readSequence.current
    setReadState({ context, phase: 'loading' })
    void synchronize(provider, chainId, context.groupId, {
      signal: controller.signal,
    })
      .then((snapshot) => {
        if (
          controller.signal.aborted ||
          requestId !== readSequence.current ||
          !readContextMatchesSelection(
            context,
            historySessionRef.current,
            selectedGroupIdRef.current,
          )
        ) {
          return
        }
        if (snapshot.groupId !== context.groupId) {
          throw new Error(
            'The message reader returned a different public group.',
          )
        }
        setReadState({
          context,
          phase: snapshot.caughtUp ? 'complete' : 'partial',
          snapshot,
        })
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          requestId !== readSequence.current ||
          !readContextMatchesSelection(
            context,
            historySessionRef.current,
            selectedGroupIdRef.current,
          )
        ) {
          return
        }
        setReadState({
          context,
          message: describeRpcError(
            error,
            'The confirmed public group messages could not be read.',
          ),
          phase: 'failed',
        })
      })
      .finally(() => {
        if (activeRead.current === controller) activeRead.current = undefined
      })
  }

  return (
    <div className="group-message-console">
      <div className="group-message-intro">
        <div>
          <p className="eyebrow">The shareholder town hall</p>
          <h3>Broadcast to the whole group.</h3>
        </div>
        <p>
          Membership is not a gate. Anyone can read or send these plaintext
          events, and every sender, payload, CID, and timestamp stays public.
        </p>
      </div>

      <p className="selected-group-summary group-message-selection">
        {selected
          ? `Selected public group #${selectedGroupId.toString()}.`
          : 'Select a public group above before reading or sending messages.'}
      </p>

      <div className="message-console">
        <div className="message-composer">
          <h4>Send a public group event</h4>
          <form onSubmit={handleSend}>
            <label htmlFor="group-message-body">Public group message</label>
            <textarea
              aria-describedby="group-message-body-help"
              aria-invalid={bodyBytes > MAX_POST_BODY_BYTES ? true : undefined}
              disabled={!connected || !selected || writeLocked}
              id="group-message-body"
              maxLength={MAX_POST_BODY_BYTES}
              onChange={(event) => {
                composeRevision.current += 1
                setBody(event.currentTarget.value)
              }}
              placeholder="Address the shareholders. Every node is listening."
              rows={6}
              value={body}
            />
            <p
              className={
                bodyBytes > MAX_POST_BODY_BYTES
                  ? 'input-help limit-exceeded'
                  : 'input-help'
              }
              id="group-message-body-help"
            >
              {bodyBytes} / {MAX_POST_BODY_BYTES} UTF-8 bytes
            </p>

            <label htmlFor="group-message-media-cid">
              Group attachment commitment (optional IPFS CID)
            </label>
            <input
              aria-describedby="group-message-media-cid-help"
              aria-invalid={mediaCidError ? true : undefined}
              disabled={!connected || !selected || writeLocked}
              id="group-message-media-cid"
              maxLength={MAX_MEDIA_CID_TEXT_LENGTH}
              onChange={(event) => {
                composeRevision.current += 1
                setMediaCidInput(event.currentTarget.value)
              }}
              placeholder="bafy… or Qm…"
              spellCheck={false}
              value={mediaCidInput}
            />
            <p
              className={
                mediaCidError ? 'input-help error-message' : 'input-help'
              }
              id="group-message-media-cid-help"
            >
              {mediaCidError ??
                (parsedMediaCid
                  ? `Canonical ${parsedMediaCid.codec} commitment: ${parsedMediaCid.text}`
                  : 'The contract records CID bytes only. It does not upload, pin, encrypt, or guarantee the media.')}
            </p>

            <label className="message-public-confirmation">
              <input
                checked={publicAcknowledged}
                disabled={!connected || !selected || writeLocked}
                onChange={(event) => {
                  composeRevision.current += 1
                  setPublicAcknowledged(event.currentTarget.checked)
                }}
                type="checkbox"
              />
              <span>
                I understand group membership does not make this private and
                anyone can read this message and its metadata.
              </span>
            </label>

            <button
              disabled={
                !connected ||
                !selected ||
                mediaCidError !== undefined ||
                bodyBytes > MAX_POST_BODY_BYTES ||
                emptyPayload ||
                !publicAcknowledged ||
                writeLocked
              }
              type="submit"
            >
              {localWriteLocked
                ? 'Group message action pending…'
                : lockedByAnotherConsole
                  ? 'Another wallet action is pending…'
                  : 'Send group message on-chain'}
            </button>
          </form>

          {!connected ? (
            <p className="message-feedback">
              Connect a wallet before composing a public group message.
            </p>
          ) : !selected ? (
            <p className="message-feedback">
              Select a valid public group before composing a message.
            </p>
          ) : null}
          {activeProblem ? (
            <p className="message-feedback error-message" role="alert">
              {activeProblem.message}
            </p>
          ) : null}
          {attempts.map((attempt) => {
            const currentAccountChain = accountChainMatchesSession(
              attempt,
              session,
            )
            const currentProvider = contextMatchesSession(attempt, session)
            const currentSelection =
              currentProvider && attempt.groupId === selectedGroupId
            const unresolved = attempt.status !== 'failed'
            const statusCopy =
              attempt.status === 'opening'
                ? 'Approve or reject this public transaction in the wallet.'
                : attempt.status === 'pending'
                  ? 'Waiting for an authenticated on-chain receipt…'
                  : attempt.status === 'failed'
                    ? 'Reverted on-chain. This hash is final; a new action is safe.'
                    : attempt.status === 'ambiguous'
                      ? 'The wallet returned no hash but may have broadcast it. Check wallet activity before trying again.'
                      : 'Its final status is unknown. Authenticate this hash before trying again.'
            return (
              <div
                className={`message-feedback transaction-pending${currentSelection ? '' : ' stale-message-feedback'}`}
                key={attempt.id}
                role="status"
              >
                <p>
                  Public message for group #{attempt.groupId.toString()} on
                  chain {attempt.chainId.toString()} from{' '}
                  <code title={attempt.account}>
                    {shortValue(attempt.account)}
                  </code>{' '}
                  via {attempt.walletName}
                  {attempt.hash ? (
                    <>
                      {' '}
                      ·{' '}
                      <code title={attempt.hash}>
                        {shortValue(attempt.hash)}
                      </code>
                    </>
                  ) : null}
                  . {statusCopy}{' '}
                  {!currentAccountChain
                    ? 'This belongs to another account or chain and does not lock the current composer.'
                    : !currentProvider && unresolved
                      ? `Reconnect ${attempt.walletName} for provider-specific recovery. This unresolved action still locks this account and chain.`
                      : currentProvider && !currentSelection
                        ? 'This belongs to another selected group but still locks this account and chain until resolved.'
                        : null}
                </p>
                {attempt.message ? (
                  <p className="error-message">{attempt.message}</p>
                ) : null}
                {attempt.status === 'unknown' ||
                attempt.status === 'ambiguous' ||
                attempt.status === 'failed' ? (
                  <div className="transaction-recovery-actions">
                    {attempt.status === 'unknown' && currentProvider ? (
                      <button
                        onClick={() => retryReceipt(attempt)}
                        type="button"
                      >
                        Check group message receipt again
                      </button>
                    ) : null}
                    <button
                      onClick={() =>
                        setAttempts((current) =>
                          current.filter(
                            (candidate) => candidate.id !== attempt.id,
                          ),
                        )
                      }
                      type="button"
                    >
                      {attempt.hash
                        ? 'I checked this group message hash'
                        : 'I checked my wallet activity'}
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
          {activeCompletion ? (
            <p className="message-feedback message-complete" role="status">
              Public group message #
              {activeCompletion.receipt.messageId.toString()} for group #
              {activeCompletion.groupId.toString()} was included in block{' '}
              {activeCompletion.receipt.blockNumber.toString()} ·{' '}
              <code title={activeCompletion.receipt.hash}>
                {shortValue(activeCompletion.receipt.hash)}
              </code>
              . It appears in the confirmed view only after the confirmation
              depth and an explicit refresh.
            </p>
          ) : null}
        </div>

        <div
          aria-busy={displayedReadState.phase === 'loading'}
          className="message-history"
        >
          <h4>Reconstruct this public group channel</h4>
          <p className="message-history-scope">
            The browser asks{' '}
            {readsSelectedRpc ? 'the selected read RPC' : 'the wallet RPC'} only
            for the selected group, one bounded confirmed range per click from
            the verified protocol history boundary. No chat server, membership
            gate, or global message scan is used.
          </p>
          <p
            aria-live="polite"
            className={
              displayedReadState.phase === 'failed'
                ? 'message-read-status error-message'
                : 'message-read-status'
            }
            id="group-message-read-status"
          >
            {!connected
              ? 'Connect a wallet to reconstruct public group messages.'
              : !selected
                ? 'Select a public group to reconstruct its messages.'
                : readStatus(displayedReadState)}
          </p>
          <button
            aria-describedby="group-message-read-status"
            disabled={
              !connected || !selected || displayedReadState.phase === 'loading'
            }
            onClick={runReadStep}
            type="button"
          >
            {readButtonLabel(displayedReadState)}
          </button>
          {displayedReadState.phase === 'complete' ? (
            <>
              <p className="message-page-note">
                This is the newest retained page for group #
                {displayedReadState.context.groupId.toString()}. Older confirmed
                messages remain public even when they are not rendered here.
              </p>
              <GroupMessageList
                messages={displayedReadState.snapshot.recentMessages}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
