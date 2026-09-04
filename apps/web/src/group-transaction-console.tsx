import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Address, Hash, Hex } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { parseGroupIdInput } from './group-id'
import { MAX_MEDIA_CID_TEXT_LENGTH, parseMediaCid } from './media-cid'
import {
  createGroup,
  createTransactionGuard,
  getUtf8ByteLength,
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  MAX_GROUP_NAME_BYTES,
  setGroupMembership,
  waitForTransactionReceipt,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
import type { WalletSession } from './wallet-session'

const FAILED_ATTEMPT_HISTORY_LIMIT = 8

type WalletContext = {
  account: Address
  chainId: bigint
  provider: Eip1193Provider
  walletName: string
}

type CreateGroupContext = WalletContext & {
  action: 'create'
  composeRevision: number
  metadataCid: Hex
  name: string
}

type MembershipContext = WalletContext & {
  action: 'membership'
  groupId: bigint
  joined: boolean
  selectedGroupIdAtSubmission: bigint | undefined
}

type GroupActionContext = CreateGroupContext | MembershipContext

type GroupActionAttempt = GroupActionContext & {
  hash?: Hash
  id: number
  message?: string
  status: 'ambiguous' | 'failed' | 'opening' | 'pending' | 'unknown'
}

type GroupActionCompletion = {
  context: GroupActionContext
  receipt: TransactionReceipt
}

type GroupActionProblem = {
  context: GroupActionContext
  message: string
}

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
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

function retainAttempts(attempts: GroupActionAttempt[]) {
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

function actionLabel(context: GroupActionContext) {
  if (context.action === 'create') return 'Group creation'
  return context.joined ? 'Membership join' : 'Membership leave'
}

function ActionAttemptStatus({
  attempt,
  currentContext,
  onDismiss,
  onRetry,
}: {
  attempt: GroupActionAttempt
  currentContext: boolean
  onDismiss(): void
  onRetry(): void
}) {
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
    <div className="group-action-attempt" role="status">
      <p>
        <strong>{actionLabel(attempt)}</strong> on chain{' '}
        {attempt.chainId.toString()} from{' '}
        <code title={attempt.account}>{shortValue(attempt.account)}</code> via{' '}
        {attempt.walletName}
        {attempt.action === 'membership'
          ? ` for group #${attempt.groupId.toString()}`
          : ''}
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
        <p className="group-action-attempt-error">{attempt.message}</p>
      ) : null}
      {attempt.status === 'unknown' ||
      attempt.status === 'ambiguous' ||
      attempt.status === 'failed' ? (
        <div className="group-action-recovery">
          {attempt.status === 'unknown' && currentContext ? (
            <button onClick={onRetry} type="button">
              Check group action receipt again
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

function ActionCompletion({
  completion,
}: {
  completion: GroupActionCompletion
}) {
  const { context, receipt } = completion
  return (
    <p className="group-action-completion" role="status">
      {context.action === 'create' ? (
        <>Group #{receipt.groupId?.toString()} was created</>
      ) : (
        <>
          Public {context.joined ? 'join' : 'leave'} event for group #
          {context.groupId.toString()} was confirmed
        </>
      )}{' '}
      in block {receipt.blockNumber.toString()} ·{' '}
      <code title={receipt.hash}>{shortValue(receipt.hash)}</code>. Confirmed
      readers update only after their configured confirmation depth and an
      explicit refresh.
    </p>
  )
}

export function GroupTransactionConsole({
  createGroupAction = createGroup,
  onSelectGroup,
  selectedGroupId,
  session,
  setMembershipAction = setGroupMembership,
  waitForReceipt = waitForTransactionReceipt,
}: {
  createGroupAction?: typeof createGroup
  onSelectGroup?(groupId: bigint): void
  selectedGroupId?: bigint
  session: WalletSession
  setMembershipAction?: typeof setGroupMembership
  waitForReceipt?: typeof waitForTransactionReceipt
}) {
  const [name, setName] = useState('')
  const [metadataCidInput, setMetadataCidInput] = useState('')
  const [membershipGroupIdInput, setMembershipGroupIdInput] = useState(
    selectedGroupId?.toString() ?? '',
  )
  const [attempts, setAttempts] = useState<GroupActionAttempt[]>([])
  const [completions, setCompletions] = useState<GroupActionCompletion[]>([])
  const [problems, setProblems] = useState<GroupActionProblem[]>([])
  const composeRevision = useRef(0)
  const operationSequence = useRef(0)
  const selectedGroupIdRef = useRef(selectedGroupId)
  const sessionRef = useRef(session)
  selectedGroupIdRef.current = selectedGroupId
  sessionRef.current = session

  useEffect(() => {
    setMembershipGroupIdInput(selectedGroupId?.toString() ?? '')
  }, [selectedGroupId, session.chainId, session.provider])

  const connected =
    session.status === 'connected' &&
    session.account !== undefined &&
    session.chainId !== undefined &&
    session.provider !== undefined
  const nameBytes = getUtf8ByteLength(name)
  let parsedMetadataCid: ReturnType<typeof parseMediaCid>
  let metadataCidError: string | undefined
  try {
    parsedMetadataCid = parseMediaCid(metadataCidInput)
  } catch (error) {
    metadataCidError =
      error instanceof Error ? error.message : 'The metadata CID is invalid.'
  }
  let membershipGroupId: bigint | undefined
  let membershipGroupIdError: string | undefined
  if (membershipGroupIdInput.trim()) {
    try {
      membershipGroupId = parseGroupIdInput(membershipGroupIdInput)
    } catch (error) {
      membershipGroupIdError =
        error instanceof Error ? error.message : 'The group ID is invalid.'
    }
  }
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

  const clearExactCreateDraft = (context: CreateGroupContext) => {
    if (
      !contextMatchesSession(context, sessionRef.current) ||
      context.composeRevision !== composeRevision.current
    ) {
      return
    }
    composeRevision.current += 1
    setName('')
    setMetadataCidInput('')
  }

  const finishAction = (
    context: GroupActionContext,
    id: number,
    receipt: TransactionReceipt,
  ) => {
    const createdGroupId =
      context.action === 'create' ? receipt.groupId : undefined
    if (context.action === 'create' && createdGroupId === undefined) {
      throw new Error('The confirmed group transaction did not return its ID.')
    }
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
    if (contextMatchesSession(context, sessionRef.current)) {
      if (context.action === 'create') {
        clearExactCreateDraft(context)
        onSelectGroup?.(createdGroupId!)
      } else if (
        selectedGroupIdRef.current === context.selectedGroupIdAtSubmission
      ) {
        onSelectGroup?.(context.groupId)
      }
    }
  }

  const runAction = (
    context: GroupActionContext,
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
          'The public group transaction failed.',
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

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      writeLocked ||
      nameBytes === 0 ||
      nameBytes > MAX_GROUP_NAME_BYTES ||
      metadataCidError
    ) {
      return
    }
    const context: CreateGroupContext = {
      account,
      action: 'create',
      chainId,
      composeRevision: composeRevision.current,
      metadataCid: parsedMetadataCid?.bytes ?? '0x',
      name,
      provider,
      walletName: session.name ?? 'Injected wallet',
    }
    runAction(context, (onSubmitted) =>
      createGroupAction(
        provider,
        account,
        chainId,
        { metadataCid: context.metadataCid, name: context.name },
        onSubmitted,
      ),
    )
  }

  const handleMembership = (joined: boolean) => {
    const account = session.account
    const chainId = session.chainId
    const provider = session.provider
    if (
      session.status !== 'connected' ||
      !account ||
      chainId === undefined ||
      !provider ||
      !membershipGroupId ||
      writeLocked
    ) {
      return
    }
    const context: MembershipContext = {
      account,
      action: 'membership',
      chainId,
      groupId: membershipGroupId,
      joined,
      provider,
      selectedGroupIdAtSubmission: selectedGroupId,
      walletName: session.name ?? 'Injected wallet',
    }
    runAction(context, (onSubmitted) =>
      setMembershipAction(
        provider,
        account,
        chainId,
        context.groupId,
        context.joined,
        onSubmitted,
      ),
    )
  }

  const retryReceipt = (attempt: GroupActionAttempt) => {
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
            'Reconnect the wallet that submitted this group action to check its receipt.',
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
          ...(attempt.action === 'create'
            ? {
                expectedGroupCreated: {
                  creator: attempt.account,
                  metadataCid: attempt.metadataCid,
                  name: attempt.name,
                },
              }
            : {
                expectedGroupMembership: {
                  account: attempt.account,
                  groupId: attempt.groupId,
                  joined: attempt.joined,
                },
              }),
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
                      'The public group receipt could not be read.',
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

  const createDisabled =
    !connected ||
    writeLocked ||
    nameBytes === 0 ||
    nameBytes > MAX_GROUP_NAME_BYTES ||
    metadataCidError !== undefined
  const membershipDisabled =
    !connected || writeLocked || membershipGroupId === undefined

  return (
    <div className="group-transaction-console">
      <div className="group-transaction-intro">
        <div>
          <p className="eyebrow">Write public group events</p>
          <h3>Form a circle. Expose the membership list.</h3>
        </div>
        <p>
          Creation, joining, and leaving each require a wallet transaction.
          Repeating an action appends another event; it never erases history.
        </p>
      </div>

      <div className="group-transaction-forms">
        <form onSubmit={handleCreate}>
          <h4>Create a public group</h4>
          <label htmlFor="new-group-name">Group name</label>
          <input
            aria-describedby="new-group-name-help"
            aria-invalid={nameBytes > MAX_GROUP_NAME_BYTES ? true : undefined}
            disabled={!connected || writeLocked}
            id="new-group-name"
            maxLength={MAX_GROUP_NAME_BYTES}
            onChange={(event) => {
              composeRevision.current += 1
              setName(event.currentTarget.value)
            }}
            placeholder="Bagholders Anonymous"
            value={name}
          />
          <p
            className={
              nameBytes > MAX_GROUP_NAME_BYTES
                ? 'group-action-help limit-exceeded'
                : 'group-action-help'
            }
            id="new-group-name-help"
          >
            {nameBytes} / {MAX_GROUP_NAME_BYTES} UTF-8 bytes
          </p>
          <label htmlFor="new-group-metadata-cid">
            IPFS metadata CID (already uploaded, optional)
          </label>
          <input
            aria-describedby="new-group-metadata-help"
            aria-invalid={metadataCidError ? true : undefined}
            disabled={!connected || writeLocked}
            id="new-group-metadata-cid"
            maxLength={MAX_MEDIA_CID_TEXT_LENGTH}
            onChange={(event) => {
              composeRevision.current += 1
              setMetadataCidInput(event.currentTarget.value)
            }}
            placeholder="bafy… or Qm…"
            value={metadataCidInput}
          />
          <p
            className={
              metadataCidError
                ? 'group-action-help error-message'
                : 'group-action-help'
            }
            id="new-group-metadata-help"
          >
            {metadataCidError ??
              (parsedMetadataCid
                ? `Will commit canonical CIDv1 bytes (${parsedMetadataCid.codec}).`
                : 'The contract records CID bytes only; it does not upload or pin metadata.')}
          </p>
          <button
            className="button-accent"
            disabled={createDisabled}
            type="submit"
          >
            {activeAttempt?.action === 'create'
              ? activeAttempt.status === 'opening'
                ? 'Opening wallet…'
                : 'Creating group…'
              : 'Create group on-chain'}
          </button>
        </form>

        <div className="group-membership-actions">
          <h4>Publish membership</h4>
          <label htmlFor="membership-group-id">Membership group ID</label>
          <input
            aria-describedby="membership-group-id-help"
            aria-invalid={membershipGroupIdError ? true : undefined}
            disabled={!connected || writeLocked}
            id="membership-group-id"
            inputMode="numeric"
            onChange={(event) =>
              setMembershipGroupIdInput(event.currentTarget.value)
            }
            placeholder="1"
            value={membershipGroupIdInput}
          />
          <p
            className={
              membershipGroupIdError
                ? 'group-action-help error-message'
                : 'group-action-help'
            }
            id="membership-group-id-help"
          >
            {membershipGroupIdError ??
              (membershipGroupId
                ? `The next event will target public group #${membershipGroupId.toString()}.`
                : 'Choose a directory group above or enter its positive decimal ID.')}
          </p>
          <p className="group-membership-disclosure">
            Membership is public social metadata. It grants no access and hides
            no messages.
          </p>
          <div className="group-membership-buttons">
            <button
              className="button-accent"
              disabled={membershipDisabled}
              onClick={() => handleMembership(true)}
              type="button"
            >
              {activeAttempt?.action === 'membership' && activeAttempt.joined
                ? activeAttempt.status === 'opening'
                  ? 'Opening wallet…'
                  : 'Joining group…'
                : 'Join group on-chain'}
            </button>
            <button
              disabled={membershipDisabled}
              onClick={() => handleMembership(false)}
              type="button"
            >
              {activeAttempt?.action === 'membership' && !activeAttempt.joined
                ? activeAttempt.status === 'opening'
                  ? 'Opening wallet…'
                  : 'Leaving group…'
                : 'Leave group on-chain'}
            </button>
          </div>
        </div>
      </div>

      {!connected ? (
        <p className="group-action-connection-note">
          Connect a wallet before publishing group events. The transaction
          helper verifies Lifeinvader v1 at the predetermined address before
          every write.
        </p>
      ) : null}
      {activeProblem ? (
        <p className="group-action-problem" role="alert">
          {activeProblem.message}
        </p>
      ) : null}
      {attempts.map((attempt) => (
        <ActionAttemptStatus
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
        <ActionCompletion completion={activeCompletion} />
      ) : null}
    </div>
  )
}
