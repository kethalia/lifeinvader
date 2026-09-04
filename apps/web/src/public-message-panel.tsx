import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getAddress, isAddress, type Address, type Hash, type Hex } from 'viem'
import {
  synchronizeDirectMessageStream,
  type DirectMessageStreamSnapshot,
  type DirectMessageStreamSynchronizer,
} from './direct-message-stream'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import {
  decodeMediaCid,
  MAX_MEDIA_CID_TEXT_LENGTH,
  parseMediaCid,
} from './media-cid'
import {
  createTransactionGuard,
  getDirectConversationId,
  getPostBodyByteLength,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  MAX_POST_BODY_BYTES,
  sendDirectMessage,
  waitForTransactionReceipt,
  type TransactionReceipt,
} from './protocol'
import type { PublishedDirectMessage } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const FAILED_ATTEMPT_HISTORY_LIMIT = 8

type ConversationContext = {
  account: Address
  chainId: bigint
  conversationId: Hash
  provider: Eip1193Provider
  recipient: Address
}

type MessageContext = ConversationContext & {
  body: string
  composeRevision: number
  mediaCid: Hex
  walletName: string
}

type MessageAttempt = MessageContext & {
  hash?: Hash
  id: number
  message?: string
  status: 'ambiguous' | 'failed' | 'opening' | 'pending' | 'unknown'
}

type CompletedMessage = MessageContext & {
  receipt: TransactionReceipt
}

type MessageProblem = MessageContext & {
  id: number
  message: string
}

type ConversationReadState =
  | { phase: 'idle' }
  | { context: ConversationContext; phase: 'loading' }
  | {
      context: ConversationContext
      phase: 'partial'
      snapshot: DirectMessageStreamSnapshot
    }
  | {
      context: ConversationContext
      phase: 'complete'
      snapshot: DirectMessageStreamSnapshot
    }
  | { context: ConversationContext; message: string; phase: 'failed' }

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function parseRecipient(value: string): {
  error?: string
  recipient?: Address
} {
  const candidate = value.trim()
  if (!candidate) return {}
  if (!isAddress(candidate)) {
    return { error: 'Enter a valid EVM recipient address.' }
  }
  const recipient = getAddress(candidate)
  if (recipient.toLowerCase() === ZERO_ADDRESS) {
    return { error: 'A public message requires a nonzero recipient.' }
  }
  return { recipient }
}

function contextMatchesSession(
  context: ConversationContext,
  session: WalletSession,
) {
  return (
    accountChainMatchesSession(context, session) &&
    context.provider === session.provider
  )
}

function accountChainMatchesSession(
  context: ConversationContext,
  session: WalletSession,
) {
  return (
    session.status === 'connected' &&
    context.chainId === session.chainId &&
    context.account.toLowerCase() === session.account?.toLowerCase()
  )
}

function contextMatchesSelection(
  context: ConversationContext,
  session: WalletSession,
  recipientInput: string,
) {
  const selection = parseRecipient(recipientInput)
  return (
    contextMatchesSession(context, session) &&
    selection.recipient?.toLowerCase() === context.recipient.toLowerCase()
  )
}

function sameWalletContext(
  first: ConversationContext,
  second: ConversationContext,
) {
  return first.provider === second.provider && sameAccountChain(first, second)
}

function sameAccountChain(
  first: ConversationContext,
  second: ConversationContext,
) {
  return (
    first.chainId === second.chainId &&
    first.account.toLowerCase() === second.account.toLowerCase()
  )
}

function retainMessageAttempts(attempts: MessageAttempt[]) {
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

function readStatus(state: ConversationReadState) {
  if (state.phase === 'idle') {
    return 'Not loaded. Each click reads at most one bounded RPC log range for exactly these two accounts.'
  }
  if (state.phase === 'loading') {
    return 'Reading one bounded range of confirmed public messages…'
  }
  if (state.phase === 'partial') {
    if (
      state.snapshot.safeHead !== undefined &&
      state.snapshot.startBlock > state.snapshot.safeHead
    ) {
      return `Deployment block ${state.snapshot.startBlock.toString()} has not reached the selected confirmation depth. No message log range was requested.`
    }
    const reset = state.snapshot.cacheReset
      ? 'The disposable local event cache was reset. '
      : ''
    return `${reset}More confirmed history remains from block ${state.snapshot.startBlock.toString()}. Indexed through block ${state.snapshot.indexedThrough?.toString() ?? 'none'} of confirmed head ${state.snapshot.safeHead?.toString() ?? 'unknown'}.`
  }
  if (state.phase === 'complete') {
    return state.snapshot.safeHead === undefined
      ? `Caught up from block ${state.snapshot.startBlock.toString()}. No block has reached the selected confirmation depth yet.`
      : `Caught up from block ${state.snapshot.startBlock.toString()} through confirmed block ${state.snapshot.safeHead.toString()}. Showing the newest retained page, oldest first.`
  }
  return state.message
}

function readButtonLabel(state: ConversationReadState) {
  if (state.phase === 'loading') return 'Reading public messages…'
  if (state.phase === 'partial') {
    return state.snapshot.safeHead !== undefined &&
      state.snapshot.startBlock > state.snapshot.safeHead
      ? 'Check message confirmations'
      : 'Load next bounded message range'
  }
  if (state.phase === 'complete') return 'Check for newer public messages'
  if (state.phase === 'failed') return 'Retry public conversation'
  return 'Load confirmed public conversation'
}

function MediaCommitment({ value }: { value: Hex }) {
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

function MessageList({
  messages,
}: {
  messages: readonly PublishedDirectMessage[]
}) {
  if (messages.length === 0) {
    return (
      <p className="message-empty-result">
        No confirmed messages were found in the newest retained page for this
        public conversation.
      </p>
    )
  }
  return (
    <ol className="public-message-list">
      {[...messages].reverse().map((message) => (
        <li key={`${message.blockHash}:${message.logIndex}`}>
          <div className="public-message-heading">
            <strong title={message.sender}>
              {shortValue(message.sender)} → {shortValue(message.recipient)}
            </strong>
            <span>Message #{message.messageId.toString()}</span>
          </div>
          {message.body ? (
            <p className="public-message-body">{message.body}</p>
          ) : null}
          {message.mediaCid !== '0x' ? (
            <MediaCommitment value={message.mediaCid} />
          ) : null}
          <p className="public-message-meta">
            Block {message.blockNumber.toString()} ·{' '}
            <code title={message.transactionHash}>
              {shortValue(message.transactionHash)}
            </code>
          </p>
        </li>
      ))}
    </ol>
  )
}

export function PublicMessagePanel({
  sendMessage = sendDirectMessage,
  session,
  synchronize = synchronizeDirectMessageStream,
  waitForReceipt = waitForTransactionReceipt,
}: {
  sendMessage?: typeof sendDirectMessage
  session: WalletSession
  synchronize?: DirectMessageStreamSynchronizer
  waitForReceipt?: typeof waitForTransactionReceipt
}) {
  const [recipientInput, setRecipientInput] = useState('')
  const [body, setBody] = useState('')
  const [mediaCidInput, setMediaCidInput] = useState('')
  const [publicAcknowledged, setPublicAcknowledged] = useState(false)
  const [attempts, setAttempts] = useState<MessageAttempt[]>([])
  const [completed, setCompleted] = useState<CompletedMessage[]>([])
  const [problems, setProblems] = useState<MessageProblem[]>([])
  const [readState, setReadState] = useState<ConversationReadState>({
    phase: 'idle',
  })
  const activeRead = useRef<AbortController | undefined>(undefined)
  const composeRevision = useRef(0)
  const operationSequence = useRef(0)
  const readSequence = useRef(0)
  const recipientInputRef = useRef(recipientInput)
  const sessionRef = useRef(session)
  recipientInputRef.current = recipientInput
  sessionRef.current = session

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
  }, [session.account, session.chainId, session.provider, session.status])

  const connected =
    session.status === 'connected' &&
    session.account !== undefined &&
    session.chainId !== undefined &&
    session.provider !== undefined
  const recipientSelection = parseRecipient(recipientInput)
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
  const writeLocked = currentAttempts.some(
    (attempt) => attempt.status !== 'failed',
  )
  const activeProblem = problems.findLast((problem) =>
    contextMatchesSession(problem, session),
  )
  const activeCompletion = completed.findLast((message) =>
    contextMatchesSession(message, session),
  )
  const displayedReadState =
    readState.phase === 'idle' ||
    contextMatchesSelection(readState.context, session, recipientInput)
      ? readState
      : ({ phase: 'idle' } as const)

  const invalidateConversation = () => {
    readSequence.current += 1
    activeRead.current?.abort()
    activeRead.current = undefined
    setReadState({ phase: 'idle' })
  }

  const updateRecipient = (value: string) => {
    composeRevision.current += 1
    invalidateConversation()
    setRecipientInput(value)
  }

  const clearExactDraft = (context: MessageContext) => {
    if (
      context.composeRevision !== composeRevision.current ||
      parseRecipient(recipientInputRef.current).recipient?.toLowerCase() !==
        context.recipient.toLowerCase()
    ) {
      return
    }
    composeRevision.current += 1
    setBody('')
    setMediaCidInput('')
    setPublicAcknowledged(false)
  }

  const finishMessage = (
    context: MessageContext,
    id: number,
    receipt: TransactionReceipt,
  ) => {
    setAttempts((current) => current.filter((attempt) => attempt.id !== id))
    setProblems((current) =>
      current.filter((problem) => !sameWalletContext(problem, context)),
    )
    setCompleted((current) =>
      [
        ...current.filter((message) => !sameWalletContext(message, context)),
        { ...context, receipt },
      ].slice(-8),
    )
    clearExactDraft(context)
  }

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    const recipient = recipientSelection.recipient
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      !recipient ||
      mediaCidError ||
      bodyBytes > MAX_POST_BODY_BYTES ||
      emptyPayload ||
      !publicAcknowledged ||
      writeLocked
    ) {
      return
    }
    const id = ++operationSequence.current
    const context: MessageContext = {
      account,
      body,
      chainId,
      composeRevision: composeRevision.current,
      conversationId: getDirectConversationId(account, recipient),
      mediaCid: parsedMediaCid?.bytes ?? '0x',
      provider,
      recipient,
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
      retainMessageAttempts([
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
          recipient,
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
          'The public message transaction failed.',
        )
        if (submittedHash) {
          setAttempts((current) =>
            retainMessageAttempts(
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

  const retryReceipt = (attempt: MessageAttempt) => {
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
            'Reconnect the wallet that submitted this message to check its receipt.',
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
          expectedDirectMessage: {
            body: attempt.body,
            conversationId: attempt.conversationId,
            mediaCid: attempt.mediaCid,
            recipient: attempt.recipient,
            sender: attempt.account,
          },
          selectedChainId: attempt.chainId,
        }).finally(guard.release)
        finishMessage(attempt, attempt.id, receipt)
      } catch (error) {
        setAttempts((current) =>
          retainMessageAttempts(
            current.map((candidate) =>
              candidate.id === attempt.id
                ? {
                    ...candidate,
                    message: describeRpcError(
                      error,
                      'The public message receipt could not be read.',
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

  const dismissAttempt = (attempt: MessageAttempt) => {
    setAttempts((current) =>
      current.filter((candidate) => candidate.id !== attempt.id),
    )
  }

  const runConversationStep = () => {
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    const recipient = recipientSelection.recipient
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      !recipient ||
      displayedReadState.phase === 'loading'
    ) {
      return
    }
    const context: ConversationContext = {
      account,
      chainId,
      conversationId: getDirectConversationId(account, recipient),
      provider,
      recipient,
    }
    activeRead.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    const requestId = ++readSequence.current
    setReadState({ context, phase: 'loading' })
    void synchronize(provider, chainId, account, recipient, {
      signal: controller.signal,
    })
      .then((snapshot) => {
        if (
          controller.signal.aborted ||
          requestId !== readSequence.current ||
          !contextMatchesSelection(
            context,
            sessionRef.current,
            recipientInputRef.current,
          )
        ) {
          return
        }
        if (
          snapshot.conversationId.toLowerCase() !==
          context.conversationId.toLowerCase()
        ) {
          throw new Error(
            'The message reader returned a different public conversation.',
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
          !contextMatchesSelection(
            context,
            sessionRef.current,
            recipientInputRef.current,
          )
        ) {
          return
        }
        setReadState({
          context,
          message: describeRpcError(
            error,
            'The confirmed public conversation could not be read.',
          ),
          phase: 'failed',
        })
      })
      .finally(() => {
        if (activeRead.current === controller) activeRead.current = undefined
      })
  }

  return (
    <section
      aria-labelledby="public-messages-title"
      className="public-messages"
    >
      <div className="public-messages-heading">
        <div>
          <p className="eyebrow">Addressed, never private</p>
          <h2 id="public-messages-title">Public messages.</h2>
        </div>
        <p className="message-privacy-warning">
          “Direct” only names the recipient. Sender, recipient, body, media CID,
          and timing are public on-chain forever.
        </p>
      </div>

      <div className="message-console">
        <div className="message-composer">
          <h3>Send an addressed public event</h3>
          <form onSubmit={handleSend}>
            <label htmlFor="message-recipient">Recipient address</label>
            <input
              aria-describedby="message-recipient-help"
              autoComplete="off"
              disabled={writeLocked}
              id="message-recipient"
              onChange={(event) => updateRecipient(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              value={recipientInput}
            />
            <p
              className={
                recipientSelection.error
                  ? 'input-help error-message'
                  : 'input-help'
              }
              id="message-recipient-help"
            >
              {recipientSelection.error ??
                'This selects one exact two-account conversation. Self-addressed messages are allowed.'}
            </p>

            <label htmlFor="message-body">Public message</label>
            <textarea
              disabled={writeLocked}
              id="message-body"
              maxLength={MAX_POST_BODY_BYTES}
              onChange={(event) => {
                composeRevision.current += 1
                setBody(event.target.value)
              }}
              placeholder="Say it like everyone is watching. They are."
              rows={6}
              value={body}
            />
            <p
              className={
                bodyBytes > MAX_POST_BODY_BYTES
                  ? 'input-help limit-exceeded'
                  : 'input-help'
              }
            >
              {bodyBytes} / {MAX_POST_BODY_BYTES} UTF-8 bytes
            </p>

            <label htmlFor="message-media-cid">
              Message attachment commitment (optional IPFS CID)
            </label>
            <input
              aria-describedby="message-media-cid-help"
              disabled={writeLocked}
              id="message-media-cid"
              maxLength={MAX_MEDIA_CID_TEXT_LENGTH}
              onChange={(event) => {
                composeRevision.current += 1
                setMediaCidInput(event.target.value)
              }}
              placeholder="bafy… or Qm…"
              spellCheck={false}
              value={mediaCidInput}
            />
            <p
              className={
                mediaCidError ? 'input-help error-message' : 'input-help'
              }
              id="message-media-cid-help"
            >
              {mediaCidError ??
                (parsedMediaCid
                  ? `Canonical ${parsedMediaCid.codec} commitment: ${parsedMediaCid.text}`
                  : 'The contract records CID bytes only. It does not upload, pin, encrypt, or guarantee the media.')}
            </p>

            <label className="message-public-confirmation">
              <input
                checked={publicAcknowledged}
                disabled={writeLocked}
                onChange={(event) => {
                  composeRevision.current += 1
                  setPublicAcknowledged(event.target.checked)
                }}
                type="checkbox"
              />
              <span>
                I understand this is not a private message and anyone can read
                its participants and contents.
              </span>
            </label>

            <button
              disabled={
                !connected ||
                !recipientSelection.recipient ||
                mediaCidError !== undefined ||
                bodyBytes > MAX_POST_BODY_BYTES ||
                emptyPayload ||
                !publicAcknowledged ||
                writeLocked
              }
              type="submit"
            >
              {writeLocked
                ? 'Public message action pending…'
                : 'Send public message on-chain'}
            </button>
          </form>

          {!connected ? (
            <p className="message-feedback">
              Connect a wallet before composing a public message.
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
            const unresolved = attempt.status !== 'failed'
            const statusCopy =
              attempt.status === 'opening'
                ? 'Approve or reject this public transaction in the wallet.'
                : attempt.status === 'pending'
                  ? 'Waiting for an on-chain receipt…'
                  : attempt.status === 'failed'
                    ? 'Reverted on-chain. This hash is final; you can safely try again.'
                    : attempt.status === 'ambiguous'
                      ? 'The wallet returned no hash but may have broadcast it. Check wallet activity before trying again.'
                      : 'Its final status is unknown. Check this hash before trying again.'
            return (
              <div
                className={`message-feedback transaction-pending${currentAccountChain ? '' : ' stale-message-feedback'}`}
                key={attempt.id}
                role="status"
              >
                <p>
                  Public message to{' '}
                  <code title={attempt.recipient}>
                    {shortValue(attempt.recipient)}
                  </code>{' '}
                  on chain {attempt.chainId.toString()} via {attempt.walletName}
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
                      : !currentProvider
                        ? 'This failed action used another wallet provider and does not lock the current composer.'
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
                        Check message receipt again
                      </button>
                    ) : null}
                    <button
                      onClick={() => dismissAttempt(attempt)}
                      type="button"
                    >
                      {attempt.hash
                        ? 'I checked this message hash'
                        : 'I checked my wallet activity'}
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
          {activeCompletion ? (
            <p className="message-feedback message-complete" role="status">
              Public message to{' '}
              <code title={activeCompletion.recipient}>
                {shortValue(activeCompletion.recipient)}
              </code>{' '}
              was included in block{' '}
              {activeCompletion.receipt.blockNumber.toString()} ·{' '}
              <code title={activeCompletion.receipt.hash}>
                {shortValue(activeCompletion.receipt.hash)}
              </code>
              . It appears in the confirmed view only after the confirmation
              depth and a manual refresh.
            </p>
          ) : null}
        </div>

        <div
          aria-busy={displayedReadState.phase === 'loading'}
          className="message-history"
        >
          <h3>Reconstruct this public conversation</h3>
          <p className="message-history-scope">
            The browser asks the wallet RPC only for the selected conversation,
            starting at the verified protocol history boundary and reading one
            bounded confirmed range per click. No inbox server or global message
            scan is used.
          </p>
          <p
            aria-live="polite"
            className={
              displayedReadState.phase === 'failed'
                ? 'message-read-status error-message'
                : 'message-read-status'
            }
            id="message-read-status"
          >
            {!connected
              ? 'Connect a wallet to reconstruct public messages.'
              : !recipientSelection.recipient
                ? (recipientSelection.error ??
                  'Enter a recipient address to select a public conversation.')
                : readStatus(displayedReadState)}
          </p>
          <button
            aria-describedby="message-read-status"
            disabled={
              !connected ||
              !recipientSelection.recipient ||
              displayedReadState.phase === 'loading'
            }
            onClick={runConversationStep}
            type="button"
          >
            {readButtonLabel(displayedReadState)}
          </button>
          {displayedReadState.phase === 'complete' ? (
            <>
              <p className="message-page-note">
                This is the newest retained page. Older confirmed messages may
                exist and remain public even when they are not rendered here.
              </p>
              <MessageList
                messages={displayedReadState.snapshot.recentMessages}
              />
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}
