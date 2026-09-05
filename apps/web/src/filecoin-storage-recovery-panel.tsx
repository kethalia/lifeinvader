import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Hash, Hex } from 'viem'
import { describeRpcError } from './ethereum'
import type {
  FilecoinStorageRecoveryJournal,
  FilecoinStorageRecoveryRecord,
} from './filecoin-storage-recovery-journal'
import type {
  FilecoinStorageUploadCheckpoint,
  FilecoinStorageUploadReceipt,
} from './filecoin-storage-upload'
import type { FilecoinStorageUploadReceiptChecker } from './filecoin-storage-upload-panel'
import type { TransactionReceipt } from './protocol'
import type { WalletSession } from './wallet-session'

export type FilecoinStorageRecoveryJournalReader = Pick<
  FilecoinStorageRecoveryJournal,
  'list' | 'removeIfUnchanged' | 'subscribe'
>

const RECOVERY_RECEIPT_POLL_INTERVAL_MS = 3_000
const RECOVERY_RECEIPT_TIMEOUT_MS = 15_000

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; records: readonly FilecoinStorageRecoveryRecord[] }
  | { kind: 'error'; message: string }

type ActionState = {
  kind: 'checking' | 'removing'
  uploadId: Hex
}

type RecoveryOutcomeBase = {
  checkpoint: FilecoinStorageUploadCheckpoint
  dataSetId: bigint
  hash: Hash
  receipt: TransactionReceipt
}

type RecoveryOutcome = RecoveryOutcomeBase &
  ({ kind: 'data-set-created' } | { kind: 'piece-added'; pieceId: bigint })

type RecoveryProblem = {
  message: string
  uploadId: Hex
}

function shortValue(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

function formatSavedTime(value: number) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? `${String(value)} ms since Unix epoch`
    : date.toISOString()
}

function sessionMatchesCheckpoint(
  session: WalletSession,
  checkpoint: FilecoinStorageUploadCheckpoint,
) {
  return (
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId === checkpoint.chainId &&
    session.account?.toLowerCase() === checkpoint.account.toLowerCase()
  )
}

function recoveredOutcome(
  checkpoint: FilecoinStorageUploadCheckpoint,
  hash: Hash,
  recovered: FilecoinStorageUploadReceipt,
): RecoveryOutcome {
  const shared: RecoveryOutcomeBase = {
    checkpoint,
    dataSetId: recovered.dataSetId,
    hash,
    receipt: recovered.receipt,
  }
  return recovered.kind === 'piece-added'
    ? { ...shared, kind: 'piece-added', pieceId: recovered.pieceId }
    : { ...shared, kind: 'data-set-created' }
}

function RecoveryOutcomeStatus({
  onDismiss,
  outcome,
}: {
  onDismiss?: () => void
  outcome: RecoveryOutcome
}) {
  return (
    <div
      className={
        outcome.kind === 'piece-added'
          ? 'filecoin-storage-upload-status'
          : 'filecoin-storage-upload-problem'
      }
      role={outcome.kind === 'piece-added' ? 'status' : 'alert'}
    >
      <p>
        {outcome.kind === 'piece-added' ? (
          <>
            Recovered storage confirmation in block{' '}
            {outcome.receipt.blockNumber.toString()} · data set{' '}
            {outcome.dataSetId.toString()} · piece {outcome.pieceId.toString()}.
          </>
        ) : (
          <>
            Recovered transaction in block{' '}
            {outcome.receipt.blockNumber.toString()} created charged data set{' '}
            {outcome.dataSetId.toString()}, but did not add the CAR piece. This
            is not storage completion.
          </>
        )}
      </p>
      <p>
        Chain {outcome.checkpoint.chainId.toString()} · transaction{' '}
        <code title={outcome.hash}>{shortValue(outcome.hash)}</code> · media CID{' '}
        <code title={outcome.checkpoint.mediaCid}>
          {shortValue(outcome.checkpoint.mediaCid)}
        </code>
        .
      </p>
      {onDismiss ? (
        <button onClick={onDismiss} type="button">
          Dismiss recovered result
        </button>
      ) : null}
    </div>
  )
}

export function FilecoinStorageRecoveryPanel({
  checkReceipt,
  disabled = false,
  onWriteLockChange,
  recoveryJournal,
  session,
}: {
  checkReceipt?: FilecoinStorageUploadReceiptChecker
  disabled?: boolean
  onWriteLockChange?(locked: boolean): void
  recoveryJournal?: FilecoinStorageRecoveryJournalReader
  session: WalletSession
}) {
  const titleId = useId()
  const loadSequence = useRef(0)
  const actionSequence = useRef(0)
  const actionActive = useRef(false)
  const journalChangePending = useRef(false)
  const loadRecoveriesRef = useRef<() => void>(() => undefined)
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeJournal = useRef<
    FilecoinStorageRecoveryJournalReader | undefined
  >(recoveryJournal)
  const latestSession = useRef(session)
  const journalSubscription = useRef<
    | {
        journal: FilecoinStorageRecoveryJournalReader
        unsubscribe: () => void
      }
    | undefined
  >(undefined)
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' })
  const [action, setAction] = useState<ActionState>()
  const [outcome, setOutcome] = useState<RecoveryOutcome>()
  const [problem, setProblem] = useState<RecoveryProblem>()
  const [notice, setNotice] = useState<string>()
  const records = loadState.kind === 'ready' ? loadState.records : []
  const writeLocked = loadState.kind !== 'ready' || records.length > 0
  const outcomeAwaitingCleanup =
    outcome !== undefined &&
    records.some(
      (record) =>
        record.checkpoint.uploadId === outcome.checkpoint.uploadId &&
        record.transactionHashes.at(-1) === outcome.hash,
    )

  useLayoutEffect(() => {
    latestSession.current = session
  }, [session])

  const loadRecoveries = useCallback(() => {
    if (actionActive.current) {
      journalChangePending.current = true
      return
    }
    const operationId = ++loadSequence.current
    setLoadState({ kind: 'loading' })
    setProblem(undefined)
    setNotice(undefined)
    void (async () => {
      try {
        const journal =
          recoveryJournal ??
          activeJournal.current ??
          (
            await import('./filecoin-storage-recovery-journal')
          ).createFilecoinStorageRecoveryJournal()
        if (journalSubscription.current?.journal !== journal) {
          const unsubscribe = journal.subscribe(() => {
            if (actionActive.current) {
              journalChangePending.current = true
              return
            }
            loadRecoveriesRef.current()
          })
          if (operationId !== loadSequence.current) {
            unsubscribe()
            return
          }
          journalSubscription.current?.unsubscribe()
          journalSubscription.current = { journal, unsubscribe }
        }
        const nextRecords = await journal.list()
        if (operationId !== loadSequence.current) return
        activeJournal.current = journal
        setLoadState({ kind: 'ready', records: nextRecords })
      } catch (error) {
        if (operationId !== loadSequence.current) return
        setLoadState({
          kind: 'error',
          message: describeRpcError(
            error,
            'Browser recovery storage could not be read.',
          ),
        })
      }
    })()
  }, [recoveryJournal])

  useLayoutEffect(() => {
    loadRecoveriesRef.current = loadRecoveries
  }, [loadRecoveries])

  useEffect(() => {
    activeJournal.current = recoveryJournal
    loadRecoveries()
    return () => {
      loadSequence.current += 1
    }
  }, [loadRecoveries, recoveryJournal])

  useEffect(() => {
    activeController.current?.abort(
      new DOMException('The wallet context changed.', 'AbortError'),
    )
  }, [session.account, session.chainId, session.provider, session.status])

  useEffect(() => {
    onWriteLockChange?.(writeLocked)
  }, [onWriteLockChange, writeLocked])

  useEffect(
    () => () => {
      actionSequence.current += 1
      activeController.current?.abort(
        new DOMException('The recovery panel closed.', 'AbortError'),
      )
      activeController.current = undefined
      actionActive.current = false
      journalChangePending.current = false
      journalSubscription.current?.unsubscribe()
      journalSubscription.current = undefined
      onWriteLockChange?.(false)
    },
    [onWriteLockChange],
  )

  const finishAction = (operationId: number) => {
    if (operationId !== actionSequence.current) return
    actionActive.current = false
    setAction(undefined)
    if (journalChangePending.current) {
      journalChangePending.current = false
      loadRecoveriesRef.current()
    }
  }

  const removeRecord = (
    record: FilecoinStorageRecoveryRecord,
    intent: 'cleanup' | 'discard',
  ) => {
    if (
      disabled ||
      actionActive.current ||
      (outcomeAwaitingCleanup &&
        (intent !== 'cleanup' ||
          outcome?.checkpoint.uploadId !== record.checkpoint.uploadId))
    )
      return
    const journal = activeJournal.current
    if (!journal) {
      setProblem({
        message:
          'The local recovery journal is unavailable. The entry was not cleared.',
        uploadId: record.checkpoint.uploadId,
      })
      return
    }
    const operationId = ++actionSequence.current
    actionActive.current = true
    setAction({ kind: 'removing', uploadId: record.checkpoint.uploadId })
    setProblem(undefined)
    setNotice(undefined)
    void (async () => {
      try {
        const removed = await journal.removeIfUnchanged(record)
        if (operationId !== actionSequence.current) return
        if (!removed) {
          const nextRecords = await journal.list()
          if (operationId !== actionSequence.current) return
          setLoadState({ kind: 'ready', records: nextRecords })
          if (intent === 'cleanup') setOutcome(undefined)
          setProblem({
            message:
              'The saved recovery changed in another tab and was not cleared. Review its newest provider hash before trying again.',
            uploadId: record.checkpoint.uploadId,
          })
          return
        }
        setLoadState((current) =>
          current.kind === 'ready'
            ? {
                kind: 'ready',
                records: current.records.filter(
                  (candidate) =>
                    candidate.checkpoint.uploadId !==
                    record.checkpoint.uploadId,
                ),
              }
            : current,
        )
        if (intent === 'discard') {
          setOutcome((current) =>
            current?.checkpoint.uploadId === record.checkpoint.uploadId
              ? undefined
              : current,
          )
          setNotice(
            'The browser-only recovery entry was discarded. No blockchain transaction was sent or changed.',
          )
        }
      } catch (error) {
        if (operationId !== actionSequence.current) return
        setProblem({
          message: describeRpcError(
            error,
            'The local recovery entry could not be cleared.',
          ),
          uploadId: record.checkpoint.uploadId,
        })
      } finally {
        finishAction(operationId)
      }
    })()
  }

  const checkRecovery = (record: FilecoinStorageRecoveryRecord) => {
    const hash = record.transactionHashes.at(-1)
    const currentSession = latestSession.current
    const provider = currentSession.provider
    if (
      disabled ||
      actionActive.current ||
      outcomeAwaitingCleanup ||
      !hash ||
      !provider ||
      !sessionMatchesCheckpoint(currentSession, record.checkpoint)
    )
      return
    const journal = activeJournal.current
    if (!journal) {
      setProblem({
        message:
          'The local recovery journal is unavailable. The receipt was not checked.',
        uploadId: record.checkpoint.uploadId,
      })
      return
    }
    const operationId = ++actionSequence.current
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    actionActive.current = true
    setAction({ kind: 'checking', uploadId: record.checkpoint.uploadId })
    setProblem(undefined)
    setNotice(undefined)
    let authenticated = false
    void (async () => {
      try {
        const checker =
          checkReceipt ??
          (await import('./filecoin-storage-upload'))
            .checkFilecoinStorageUploadReceipt
        if (
          !sessionMatchesCheckpoint(latestSession.current, record.checkpoint) ||
          latestSession.current.provider !== provider
        ) {
          throw new Error('Reconnect the original wallet context first.')
        }
        const recovered = await checker(provider, hash, record.checkpoint, {
          expectedAccount: record.checkpoint.account,
          expectedChainId: record.checkpoint.chainId,
          pollIntervalMs: RECOVERY_RECEIPT_POLL_INTERVAL_MS,
          receiptTimeoutMs: RECOVERY_RECEIPT_TIMEOUT_MS,
          signal: controller.signal,
        })
        if (controller.signal.aborted) throw controller.signal.reason
        if (
          !sessionMatchesCheckpoint(latestSession.current, record.checkpoint) ||
          latestSession.current.provider !== provider
        ) {
          throw new Error('Reconnect the original wallet context first.')
        }
        if (operationId !== actionSequence.current) return
        const nextOutcome = recoveredOutcome(record.checkpoint, hash, recovered)
        authenticated = true
        setOutcome(nextOutcome)
        setAction({ kind: 'removing', uploadId: record.checkpoint.uploadId })
        const removed = await journal.removeIfUnchanged(record)
        if (operationId !== actionSequence.current) return
        if (!removed) {
          const nextRecords = await journal.list()
          if (operationId !== actionSequence.current) return
          setLoadState({ kind: 'ready', records: nextRecords })
          setOutcome(undefined)
          authenticated = false
          throw new Error(
            'The saved recovery changed in another tab. Authenticate its newest provider hash before clearing it.',
          )
        }
        setLoadState((current) =>
          current.kind === 'ready'
            ? {
                kind: 'ready',
                records: current.records.filter(
                  (candidate) =>
                    candidate.checkpoint.uploadId !==
                    record.checkpoint.uploadId,
                ),
              }
            : current,
        )
      } catch (error) {
        if (operationId !== actionSequence.current) return
        setProblem({
          message: describeRpcError(
            error,
            authenticated
              ? 'The receipt was authenticated, but its local recovery entry could not be cleared.'
              : 'The provider transaction could not be authenticated.',
          ),
          uploadId: record.checkpoint.uploadId,
        })
      } finally {
        finishAction(operationId)
        if (activeController.current === controller) {
          activeController.current = undefined
        }
      }
    })()
  }

  if (loadState.kind === 'loading') {
    return (
      <section className="filecoin-storage-recovery" aria-labelledby={titleId}>
        <h4 id={titleId}>Saved Filecoin storage recoveries</h4>
        <p role="status">Checking this browser for unresolved uploads…</p>
      </section>
    )
  }

  if (loadState.kind === 'error') {
    return (
      <section className="filecoin-storage-recovery" aria-labelledby={titleId}>
        <h4 id={titleId}>Saved Filecoin storage recoveries</h4>
        <div className="filecoin-storage-upload-problem" role="alert">
          <p>{loadState.message}</p>
          <p>
            Wallet writes remain locked because this browser cannot prove that
            no paid storage attempt is unresolved.
          </p>
          <button disabled={disabled} onClick={loadRecoveries} type="button">
            Retry reading recoveries
          </button>
        </div>
      </section>
    )
  }

  if (records.length === 0 && !outcome && !notice) return null

  return (
    <section className="filecoin-storage-recovery" aria-labelledby={titleId}>
      <div>
        <p className="eyebrow">Browser-local safety journal</p>
        <h4 id={titleId}>Saved Filecoin storage recoveries</h4>
      </div>
      <p>
        These public checkpoints survived a reload. Every wallet write stays
        locked until each attempt is authenticated on its original chain or
        explicitly discarded after you check wallet and provider activity.
      </p>
      {outcome ? (
        <RecoveryOutcomeStatus
          onDismiss={
            outcomeAwaitingCleanup ? undefined : () => setOutcome(undefined)
          }
          outcome={outcome}
        />
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {records.map((record) => {
        const checkpoint = record.checkpoint
        const latestHash = record.transactionHashes.at(-1)
        const contextCurrent = sessionMatchesCheckpoint(session, checkpoint)
        const recordAction =
          action?.uploadId === checkpoint.uploadId ? action : undefined
        const recordOutcome =
          outcome?.checkpoint.uploadId === checkpoint.uploadId &&
          outcome.hash === latestHash
            ? outcome
            : undefined
        const recordProblem =
          problem?.uploadId === checkpoint.uploadId ? problem : undefined
        return (
          <article
            className="filecoin-storage-recovery-record"
            key={checkpoint.uploadId}
          >
            <h5>
              Upload{' '}
              <code title={checkpoint.uploadId}>
                {shortValue(checkpoint.uploadId)}
              </code>
            </h5>
            <dl>
              <div>
                <dt>Original account</dt>
                <dd>
                  <code title={checkpoint.account}>
                    {shortValue(checkpoint.account)}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Chain</dt>
                <dd>{checkpoint.chainId.toString()}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{checkpoint.provider.id.toString()}</dd>
              </div>
              <div>
                <dt>CAR bytes</dt>
                <dd>{checkpoint.carByteLength.toLocaleString('en-US')}</dd>
              </div>
              <div>
                <dt>Saved</dt>
                <dd>{formatSavedTime(record.updatedAtMs)}</dd>
              </div>
            </dl>
            <p>
              Media CID{' '}
              <code title={checkpoint.mediaCid}>
                {shortValue(checkpoint.mediaCid)}
              </code>{' '}
              · PieceCID{' '}
              <code title={checkpoint.piece.text}>
                {shortValue(checkpoint.piece.text)}
              </code>
              .
            </p>
            {record.transactionHashes.length > 0 ? (
              <p>
                Provider hash{record.transactionHashes.length === 1 ? '' : 'es'}
                :{' '}
                {record.transactionHashes.map((hash, index) => (
                  <span key={hash}>
                    {index > 0 ? ' → ' : null}
                    <code title={hash}>{shortValue(hash)}</code>
                  </span>
                ))}
                {record.transactionHashes.length > 1
                  ? '. Receipt recovery checks the newest replacement.'
                  : '.'}
              </p>
            ) : (
              <p>
                No transaction hash was returned. Check wallet and provider
                activity manually before discarding this recovery.
              </p>
            )}
            {recordProblem ? <p role="alert">{recordProblem.message}</p> : null}
            <div className="transaction-recovery-actions">
              {recordOutcome ? (
                <button
                  disabled={disabled || action !== undefined}
                  onClick={() => removeRecord(record, 'cleanup')}
                  type="button"
                >
                  {recordAction?.kind === 'removing'
                    ? 'Clearing local recovery…'
                    : 'Retry clearing authenticated recovery'}
                </button>
              ) : latestHash ? (
                <button
                  disabled={
                    disabled ||
                    action !== undefined ||
                    outcomeAwaitingCleanup ||
                    !contextCurrent
                  }
                  onClick={() => checkRecovery(record)}
                  type="button"
                >
                  {recordAction?.kind === 'checking'
                    ? 'Checking newest receipt…'
                    : contextCurrent
                      ? 'Check newest storage receipt'
                      : 'Reconnect original account and chain'}
                </button>
              ) : null}
              {!recordOutcome ? (
                <button
                  disabled={
                    disabled || action !== undefined || outcomeAwaitingCleanup
                  }
                  onClick={() => removeRecord(record, 'discard')}
                  type="button"
                >
                  {recordAction?.kind === 'removing'
                    ? 'Discarding browser entry…'
                    : latestHash
                      ? 'I checked the newest hash; discard recovery'
                      : 'I checked wallet and provider activity; discard recovery'}
                </button>
              ) : null}
            </div>
          </article>
        )
      })}
      {records.length > 0 ? (
        <button
          disabled={disabled || action !== undefined}
          onClick={loadRecoveries}
          type="button"
        >
          Refresh saved recoveries
        </button>
      ) : null}
    </section>
  )
}
