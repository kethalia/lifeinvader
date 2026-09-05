import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { maxUint256, type Address, type Hash } from 'viem'
import {
  describeRpcError,
  getRpcErrorCode,
  type Eip1193Provider,
} from './ethereum'
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import type {
  FilecoinStorageUploadCheckpoint,
  FilecoinStorageUploadReceipt,
  FilecoinStorageUploadResult,
} from './filecoin-storage-upload'
import type { PreparedMediaCar } from './paid-media-car'
import type { TransactionReceipt } from './protocol'
import type { WalletSession } from './wallet-session'

type UploadModule = typeof import('./filecoin-storage-upload')

export type FilecoinStorageUploader = UploadModule['uploadFilecoinStorage']
export type FilecoinStorageUploadReceiptChecker =
  UploadModule['checkFilecoinStorageUploadReceipt']
export type FilecoinStorageUploadRecoveryJournal = {
  markSubmitted(
    checkpoint: FilecoinStorageUploadCheckpoint,
    transactionHash: Hash,
  ): Promise<unknown>
  remove(uploadId: FilecoinStorageUploadCheckpoint['uploadId']): Promise<void>
  stage(checkpoint: FilecoinStorageUploadCheckpoint): Promise<unknown>
}

type UploadContext = {
  account: Address
  carBytes: Uint8Array
  carByteLength: number
  chainId: bigint
  mediaCid: string
  provider: Eip1193Provider
  providerId: bigint
  walletName: string
}

type UploadConfirmation = {
  checkpoint: FilecoinStorageUploadCheckpoint
  dataSetId: bigint
  pieceId: bigint
  providerPieceUrl: string
  receipt: TransactionReceipt
  transactionHash: Hash
}

type UploadState =
  | { kind: 'idle' }
  | { context: UploadContext; kind: 'preparing' }
  | { bytesUploaded: number; context: UploadContext; kind: 'uploading' }
  | {
      checkpoint: FilecoinStorageUploadCheckpoint
      context: UploadContext
      kind: 'signing'
    }
  | {
      checkpoint: FilecoinStorageUploadCheckpoint
      context: UploadContext
      hash: Hash
      kind: 'checking' | 'pending'
    }
  | {
      checkpoint: FilecoinStorageUploadCheckpoint
      context: UploadContext
      kind: 'ambiguous'
      message: string
      recoveryError?: string
    }
  | {
      checkpoint: FilecoinStorageUploadCheckpoint
      context: UploadContext
      hash: Hash
      kind: 'unknown'
      message: string
      recoveryError?: string
    }
  | {
      confirmation: UploadConfirmation
      context: UploadContext
      kind: 'confirmed'
      recoveryWarning?: string
    }
  | {
      checkpoint: FilecoinStorageUploadCheckpoint
      context: UploadContext
      dataSetId: bigint
      hash: Hash
      kind: 'data-set-only'
      receipt: TransactionReceipt
      recoveryWarning?: string
    }
  | {
      checkpoint: FilecoinStorageUploadCheckpoint
      kind: 'cleanup'
      message: string
    }
  | {
      context: UploadContext
      kind: 'error' | 'rejected'
      message: string
    }

function shortValue(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

function formatByteLength(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function parseProviderId(value: string) {
  if (!/^[1-9][0-9]{0,77}$/.test(value)) return undefined
  const providerId = BigInt(value)
  return providerId <= maxUint256 ? providerId : undefined
}

function walletContextMatches(context: UploadContext, session: WalletSession) {
  return (
    session.status === 'connected' &&
    session.provider === context.provider &&
    session.chainId === context.chainId &&
    session.account?.toLowerCase() === context.account.toLowerCase()
  )
}

function mediaContextMatches(
  context: UploadContext,
  prepared: PreparedMediaCar,
) {
  return (
    context.carBytes === prepared.carBytes &&
    context.carByteLength === prepared.carBytes.byteLength &&
    context.mediaCid === prepared.mediaCid.text
  )
}

function quoteMatches(
  quote: FilecoinStorageQuote | undefined,
  prepared: PreparedMediaCar,
  session: WalletSession,
) {
  return Boolean(
    quote?.ready &&
    session.status === 'connected' &&
    session.account &&
    session.provider &&
    session.chainId === quote.chainId &&
    session.account.toLowerCase() === quote.account.toLowerCase() &&
    quote.dataSize === BigInt(prepared.carBytes.byteLength) &&
    quote.copies === 1 &&
    quote.withCDN === false,
  )
}

function stateLocksWrites(state: UploadState) {
  return (
    state.kind === 'preparing' ||
    state.kind === 'uploading' ||
    state.kind === 'signing' ||
    state.kind === 'pending' ||
    state.kind === 'checking' ||
    state.kind === 'ambiguous' ||
    state.kind === 'unknown'
  )
}

function isSubmissionUnknown(error: unknown): error is Error & {
  checkpoint: FilecoinStorageUploadCheckpoint
  transactionHash?: Hash
} {
  return (
    error instanceof Error &&
    error.name === 'FilecoinStorageSubmissionUnknownError' &&
    'checkpoint' in error &&
    typeof error.checkpoint === 'object' &&
    error.checkpoint !== null
  )
}

function recoveredConfirmation(
  checkpoint: FilecoinStorageUploadCheckpoint,
  hash: Hash,
  recovered: FilecoinStorageUploadReceipt & { kind: 'piece-added' },
): UploadConfirmation {
  return {
    checkpoint,
    dataSetId: recovered.dataSetId,
    pieceId: recovered.pieceId,
    providerPieceUrl: new URL(
      `piece/${checkpoint.piece.text}`,
      checkpoint.provider.serviceUrl,
    ).toString(),
    receipt: recovered.receipt,
    transactionHash: hash,
  }
}

function completedConfirmation(
  result: FilecoinStorageUploadResult,
): UploadConfirmation {
  return {
    checkpoint: result,
    dataSetId: result.dataSetId,
    pieceId: result.pieceId,
    providerPieceUrl: result.providerPieceUrl,
    receipt: result.receipt,
    transactionHash: result.transactionHash,
  }
}

async function clearRecovery(
  journal: FilecoinStorageUploadRecoveryJournal,
  uploadId: FilecoinStorageUploadCheckpoint['uploadId'],
) {
  try {
    await journal.remove(uploadId)
    return undefined
  } catch (error) {
    return `The browser could not clear the local recovery entry: ${describeRpcError(
      error,
      'browser storage is unavailable.',
    )}`
  }
}

function FilecoinUploadStatus({
  contextCurrent,
  disabled,
  onClearAmbiguous,
  onClearUnknown,
  onReset,
  onRetryRecoveryCleanup,
  onRetryReceipt,
  state,
}: {
  contextCurrent: boolean
  disabled: boolean
  onClearAmbiguous(): void
  onClearUnknown(): void
  onReset(): void
  onRetryRecoveryCleanup(): void
  onRetryReceipt(): void
  state: UploadState
}) {
  if (state.kind === 'idle') return null
  if (state.kind === 'preparing') {
    return <p role="status">Revalidating the CAR and its Filecoin PieceCID…</p>
  }
  if (state.kind === 'uploading') {
    return (
      <p role="status">
        Sending the public CAR to provider {state.context.providerId.toString()}{' '}
        · {formatByteLength(state.bytesUploaded)} of{' '}
        {formatByteLength(state.context.carByteLength)}.
      </p>
    )
  }
  if (state.kind === 'signing') {
    return (
      <div className="filecoin-storage-upload-status" role="status">
        <p>
          The provider has the CAR and its exact PieceCID. A recovery checkpoint
          is saved in this browser.
        </p>
        <p>
          Review up to two typed-data prompts in {state.context.walletName}. The
          first signature can create and charge for a data set by itself.
        </p>
      </div>
    )
  }
  if (state.kind === 'pending' || state.kind === 'checking') {
    return (
      <p className="filecoin-storage-upload-status" role="status">
        Provider transaction{' '}
        <code title={state.hash}>{shortValue(state.hash)}</code> on chain{' '}
        {state.context.chainId.toString()} ·{' '}
        {state.kind === 'checking'
          ? 'checking its canonical storage events…'
          : 'waiting for its canonical storage events…'}
      </p>
    )
  }
  if (state.kind === 'confirmed') {
    const { confirmation } = state
    return (
      <div className="filecoin-storage-upload-status" role="status">
        <p>
          Storage confirmed in block{' '}
          {confirmation.receipt.blockNumber.toString()} · data set{' '}
          {confirmation.dataSetId.toString()} · piece{' '}
          {confirmation.pieceId.toString()}.
        </p>
        <p>
          Transaction{' '}
          <code title={confirmation.transactionHash}>
            {shortValue(confirmation.transactionHash)}
          </code>
          . Provider piece endpoint:{' '}
          <a
            href={confirmation.providerPieceUrl}
            rel="noreferrer"
            target="_blank"
          >
            {shortValue(confirmation.checkpoint.piece.text)}
          </a>
          .
        </p>
        <p>
          IPFS indexing was requested. It is not yet proven indexed, pinned, or
          available through a gateway. Publishing the CID is still separate.
        </p>
        {state.recoveryWarning ? <p>{state.recoveryWarning}</p> : null}
        <button
          disabled={disabled}
          onClick={state.recoveryWarning ? onRetryRecoveryCleanup : onReset}
          type="button"
        >
          {state.recoveryWarning
            ? 'Retry cleanup, then prepare another attempt'
            : 'Prepare another storage attempt'}
        </button>
      </div>
    )
  }
  if (state.kind === 'data-set-only') {
    return (
      <div className="filecoin-storage-upload-problem" role="alert">
        <p>
          Transaction <code title={state.hash}>{shortValue(state.hash)}</code>{' '}
          created data set {state.dataSetId.toString()} in block{' '}
          {state.receipt.blockNumber.toString()}, but did not add the CAR piece.
        </p>
        <p>
          The first authorization may have incurred a fee. This is not storage
          completion, pinning, indexing, or publication.
        </p>
        {state.recoveryWarning ? <p>{state.recoveryWarning}</p> : null}
        <button
          disabled={disabled}
          onClick={state.recoveryWarning ? onRetryRecoveryCleanup : onReset}
          type="button"
        >
          {state.recoveryWarning
            ? 'Retry cleanup, then clear incomplete attempt'
            : 'Clear incomplete attempt'}
        </button>
      </div>
    )
  }
  if (state.kind === 'cleanup') {
    return (
      <div className="filecoin-storage-upload-problem" role="alert">
        <p>{state.message}</p>
        <p>
          Retry clearing this browser-only entry before preparing another
          storage attempt. No blockchain transaction is sent by this cleanup.
        </p>
        <button
          disabled={disabled}
          onClick={onRetryRecoveryCleanup}
          type="button"
        >
          Retry clearing local recovery entry
        </button>
      </div>
    )
  }
  if (state.kind === 'unknown') {
    return (
      <div className="filecoin-storage-upload-problem" role="alert">
        <p>{state.message}</p>
        {state.recoveryError ? <p>{state.recoveryError}</p> : null}
        <p>
          Do not authorize another provider attempt until transaction{' '}
          <code title={state.hash}>{shortValue(state.hash)}</code> is checked.
        </p>
        <div className="transaction-recovery-actions">
          <button
            disabled={disabled || !contextCurrent}
            onClick={onRetryReceipt}
            type="button"
          >
            {contextCurrent
              ? 'Check storage receipt again'
              : 'Reconnect original wallet to check receipt'}
          </button>
          <button disabled={disabled} onClick={onClearUnknown} type="button">
            I checked this storage hash; clear lock
          </button>
        </div>
      </div>
    )
  }
  if (state.kind === 'ambiguous') {
    return (
      <div className="filecoin-storage-upload-problem" role="alert">
        <p>{state.message}</p>
        {state.recoveryError ? <p>{state.recoveryError}</p> : null}
        <p>
          A fee-bearing signature reached the provider without a transaction
          hash. Close any open prompt and check wallet and provider activity
          before allowing another attempt.
        </p>
        <button disabled={disabled} onClick={onClearAmbiguous} type="button">
          I checked wallet activity; clear storage lock
        </button>
      </div>
    )
  }
  if (state.kind === 'error' || state.kind === 'rejected') {
    return (
      <p className="error-message" role="alert">
        {state.message}
      </p>
    )
  }
  return null
}

export function FilecoinStorageUploadPanel({
  checkReceipt,
  disabled = false,
  onWriteLockChange,
  prepared,
  quote,
  recoveryJournal,
  session,
  uploadStorage,
}: {
  checkReceipt?: FilecoinStorageUploadReceiptChecker
  disabled?: boolean
  onWriteLockChange?(locked: boolean): void
  prepared: PreparedMediaCar
  quote?: FilecoinStorageQuote
  recoveryJournal?: FilecoinStorageUploadRecoveryJournal
  session: WalletSession
  uploadStorage?: FilecoinStorageUploader
}) {
  const titleId = useId()
  const providerIdId = useId()
  const acknowledgmentId = useId()
  const operationSequence = useRef(0)
  const operationActive = useRef(false)
  const dismissalActive = useRef(false)
  const activeController = useRef<AbortController | undefined>(undefined)
  const activeContext = useRef<UploadContext | undefined>(undefined)
  const activeJournal = useRef<
    FilecoinStorageUploadRecoveryJournal | undefined
  >(undefined)
  const latestPrepared = useRef(prepared)
  const latestSession = useRef(session)
  useLayoutEffect(() => {
    latestPrepared.current = prepared
    latestSession.current = session
  }, [prepared, session])
  const [providerIdInput, setProviderIdInput] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [dismissalPending, setDismissalPending] = useState(false)
  const [state, setState] = useState<UploadState>({ kind: 'idle' })
  const writeLocked = stateLocksWrites(state)
  const settled =
    state.kind === 'confirmed' ||
    state.kind === 'data-set-only' ||
    state.kind === 'cleanup'
  const providerId = parseProviderId(providerIdInput)
  const ready = quoteMatches(quote, prepared, session)
  useEffect(() => {
    onWriteLockChange?.(writeLocked)
  }, [onWriteLockChange, writeLocked])

  useEffect(
    () => () => {
      onWriteLockChange?.(false)
    },
    [onWriteLockChange],
  )

  useEffect(() => {
    setAcknowledged(false)
    setState((current) => {
      if (current.kind === 'confirmed' || current.kind === 'data-set-only') {
        if (
          !walletContextMatches(current.context, session) ||
          !mediaContextMatches(current.context, prepared)
        ) {
          if (current.recoveryWarning) {
            return {
              checkpoint:
                current.kind === 'confirmed'
                  ? current.confirmation.checkpoint
                  : current.checkpoint,
              kind: 'cleanup',
              message: current.recoveryWarning,
            }
          }
          return { kind: 'idle' }
        }
      }
      return current
    })
    const context = activeContext.current
    if (
      context &&
      (!walletContextMatches(context, session) ||
        !mediaContextMatches(context, prepared))
    ) {
      activeController.current?.abort(
        new DOMException('The upload context changed.', 'AbortError'),
      )
    }
  }, [
    prepared.carBytes,
    prepared.mediaCid.text,
    quote,
    session.account,
    session.chainId,
    session.provider,
    session.status,
  ])

  useEffect(
    () => () => {
      operationSequence.current += 1
      activeController.current?.abort(
        new DOMException('The upload panel closed.', 'AbortError'),
      )
      activeController.current = undefined
      activeContext.current = undefined
      activeJournal.current = undefined
      operationActive.current = false
      dismissalActive.current = false
    },
    [],
  )

  const runUpload = () => {
    const account = session.account
    const provider = session.provider
    if (
      disabled ||
      operationActive.current ||
      dismissalActive.current ||
      writeLocked ||
      !acknowledged ||
      !ready ||
      !quote ||
      !account ||
      !provider ||
      providerId === undefined ||
      session.chainId === undefined
    )
      return
    const context: UploadContext = {
      account,
      carBytes: prepared.carBytes,
      carByteLength: prepared.carBytes.byteLength,
      chainId: session.chainId,
      mediaCid: prepared.mediaCid.text,
      provider,
      providerId,
      walletName: session.name ?? 'Injected wallet',
    }
    const operationId = ++operationSequence.current
    const controller = new AbortController()
    activeController.current?.abort()
    activeController.current = controller
    activeContext.current = context
    activeJournal.current = undefined
    operationActive.current = true
    setAcknowledged(false)
    setState({ context, kind: 'preparing' })
    let checkpoint: FilecoinStorageUploadCheckpoint | undefined
    let journal: FilecoinStorageUploadRecoveryJournal | undefined
    let journalStaged = false
    const contextStillCurrent = () =>
      walletContextMatches(context, latestSession.current) &&
      mediaContextMatches(context, latestPrepared.current)

    void (async () => {
      try {
        const action =
          uploadStorage ??
          (await import('./filecoin-storage-upload')).uploadFilecoinStorage
        const operationJournal =
          recoveryJournal ??
          (
            await import('./filecoin-storage-recovery-journal')
          ).createFilecoinStorageRecoveryJournal()
        journal = operationJournal
        activeJournal.current = operationJournal
        if (controller.signal.aborted) throw controller.signal.reason
        const result = await action(provider, prepared, quote, providerId, {
          expectedAccount: account,
          expectedChainId: context.chainId,
          onProgress: (bytesUploaded) => {
            if (operationId !== operationSequence.current) return
            setState({ bytesUploaded, context, kind: 'uploading' })
          },
          onStored: async (value) => {
            checkpoint = value
            await operationJournal.stage(value)
            journalStaged = true
            if (operationId !== operationSequence.current) return
            setState({ checkpoint: value, context, kind: 'signing' })
          },
          onSubmitted: async (hash) => {
            if (!checkpoint) {
              throw new Error(
                'The provider reported a transaction before checkpoint staging.',
              )
            }
            await operationJournal.markSubmitted(checkpoint, hash)
            if (operationId !== operationSequence.current) return
            setState({ checkpoint, context, hash, kind: 'pending' })
          },
          signal: controller.signal,
        })
        if (operationId !== operationSequence.current) return
        const confirmation = completedConfirmation(result)
        const recoveryWarning = await clearRecovery(
          operationJournal,
          checkpoint?.uploadId ?? result.uploadId,
        )
        if (operationId !== operationSequence.current) return
        if (!recoveryWarning) activeJournal.current = undefined
        if (!contextStillCurrent()) {
          setState(
            recoveryWarning
              ? {
                  checkpoint: confirmation.checkpoint,
                  kind: 'cleanup',
                  message: recoveryWarning,
                }
              : { kind: 'idle' },
          )
          return
        }
        setState({
          confirmation,
          context,
          kind: 'confirmed',
          ...(recoveryWarning ? { recoveryWarning } : {}),
        })
      } catch (error) {
        const submissionUnknown = isSubmissionUnknown(error)
        let recoveryWarning: string | undefined
        if (!submissionUnknown && journalStaged && checkpoint && journal) {
          recoveryWarning = await clearRecovery(journal, checkpoint.uploadId)
          if (operationId === operationSequence.current && !recoveryWarning) {
            activeJournal.current = undefined
          }
        }
        if (operationId !== operationSequence.current) return
        if (submissionUnknown) {
          setState(
            error.transactionHash
              ? {
                  checkpoint: error.checkpoint,
                  context,
                  hash: error.transactionHash,
                  kind: 'unknown',
                  message: error.message,
                }
              : {
                  checkpoint: error.checkpoint,
                  context,
                  kind: 'ambiguous',
                  message: error.message,
                },
          )
        } else {
          const message = describeRpcError(
            error,
            'The Filecoin storage attempt did not complete.',
          )
          if (recoveryWarning && checkpoint) {
            setState({
              checkpoint,
              kind: 'cleanup',
              message: `${message} ${recoveryWarning}`,
            })
          } else if (!contextStillCurrent()) {
            setState({ kind: 'idle' })
          } else {
            setState({
              context,
              kind: getRpcErrorCode(error) === 4001 ? 'rejected' : 'error',
              message,
            })
          }
        }
      } finally {
        if (operationId === operationSequence.current) {
          operationActive.current = false
          activeContext.current = undefined
        }
        if (activeController.current === controller) {
          activeController.current = undefined
        }
      }
    })()
  }

  const retryReceipt = () => {
    if (
      state.kind !== 'unknown' ||
      disabled ||
      operationActive.current ||
      dismissalActive.current ||
      !walletContextMatches(state.context, session)
    )
      return
    const previous = state
    const contextStillCurrent = () =>
      walletContextMatches(previous.context, latestSession.current) &&
      mediaContextMatches(previous.context, latestPrepared.current)
    const operationId = ++operationSequence.current
    const controller = new AbortController()
    activeController.current = controller
    activeContext.current = previous.context
    operationActive.current = true
    setState({
      checkpoint: previous.checkpoint,
      context: previous.context,
      hash: previous.hash,
      kind: 'checking',
    })
    void (async () => {
      try {
        const action =
          checkReceipt ??
          (await import('./filecoin-storage-upload'))
            .checkFilecoinStorageUploadReceipt
        const recovered = await action(
          previous.context.provider,
          previous.hash,
          previous.checkpoint,
          {
            expectedAccount: previous.context.account,
            expectedChainId: previous.context.chainId,
            signal: controller.signal,
          },
        )
        if (operationId !== operationSequence.current) return
        const journal = activeJournal.current
        const recoveryWarning = journal
          ? await clearRecovery(journal, previous.checkpoint.uploadId)
          : 'The local recovery journal is unavailable; its entry could not be cleared.'
        if (operationId !== operationSequence.current) return
        if (!recoveryWarning) activeJournal.current = undefined
        if (!contextStillCurrent()) {
          setState(
            recoveryWarning
              ? {
                  checkpoint: previous.checkpoint,
                  kind: 'cleanup',
                  message: recoveryWarning,
                }
              : { kind: 'idle' },
          )
          return
        }
        if (recovered.kind === 'piece-added') {
          setState({
            confirmation: recoveredConfirmation(
              previous.checkpoint,
              previous.hash,
              recovered,
            ),
            context: previous.context,
            kind: 'confirmed',
            ...(recoveryWarning ? { recoveryWarning } : {}),
          })
        } else {
          setState({
            checkpoint: previous.checkpoint,
            context: previous.context,
            dataSetId: recovered.dataSetId,
            hash: previous.hash,
            kind: 'data-set-only',
            receipt: recovered.receipt,
            ...(recoveryWarning ? { recoveryWarning } : {}),
          })
        }
      } catch (error) {
        if (operationId !== operationSequence.current) return
        setState({
          ...previous,
          message: describeRpcError(
            error,
            'The provider transaction could not be authenticated.',
          ),
        })
      } finally {
        if (operationId === operationSequence.current) {
          operationActive.current = false
          activeContext.current = undefined
        }
        if (activeController.current === controller) {
          activeController.current = undefined
        }
      }
    })()
  }

  const reset = () => {
    operationSequence.current += 1
    activeController.current?.abort()
    activeController.current = undefined
    activeContext.current = undefined
    activeJournal.current = undefined
    operationActive.current = false
    dismissalActive.current = false
    setDismissalPending(false)
    setAcknowledged(false)
    setState({ kind: 'idle' })
  }

  const retryRecoveryCleanup = () => {
    if (
      disabled ||
      dismissalActive.current ||
      operationActive.current ||
      (state.kind !== 'confirmed' &&
        state.kind !== 'data-set-only' &&
        state.kind !== 'cleanup')
    )
      return
    const previous = state
    const checkpoint =
      previous.kind === 'confirmed'
        ? previous.confirmation.checkpoint
        : previous.checkpoint
    const journal = activeJournal.current
    const unavailable =
      'The local recovery journal is unavailable. Its entry was not cleared.'
    if (!journal) {
      setState(
        previous.kind === 'cleanup'
          ? { ...previous, message: unavailable }
          : { ...previous, recoveryWarning: unavailable },
      )
      return
    }
    const operationId = ++operationSequence.current
    dismissalActive.current = true
    setDismissalPending(true)
    void (async () => {
      try {
        await journal.remove(checkpoint.uploadId)
        if (operationId !== operationSequence.current) return
        activeJournal.current = undefined
        activeController.current = undefined
        activeContext.current = undefined
        operationActive.current = false
        setAcknowledged(false)
        setState({ kind: 'idle' })
      } catch (error) {
        if (operationId !== operationSequence.current) return
        const warning = `The local recovery entry could not be cleared. ${describeRpcError(
          error,
          'Browser storage is unavailable.',
        )}`
        setState(
          previous.kind === 'cleanup'
            ? { ...previous, message: warning }
            : { ...previous, recoveryWarning: warning },
        )
      } finally {
        if (operationId === operationSequence.current) {
          dismissalActive.current = false
          setDismissalPending(false)
        }
      }
    })()
  }

  const dismissRecovery = () => {
    if (
      disabled ||
      dismissalActive.current ||
      operationActive.current ||
      (state.kind !== 'ambiguous' && state.kind !== 'unknown')
    )
      return
    const previous = state
    const journal = activeJournal.current
    if (!journal) {
      setState({
        ...previous,
        recoveryError:
          'The local recovery journal is unavailable. This lock was not cleared.',
      })
      return
    }
    const operationId = ++operationSequence.current
    dismissalActive.current = true
    setDismissalPending(true)
    void (async () => {
      try {
        await journal.remove(previous.checkpoint.uploadId)
        if (operationId !== operationSequence.current) return
        activeJournal.current = undefined
        activeController.current = undefined
        activeContext.current = undefined
        operationActive.current = false
        setAcknowledged(false)
        setState({ kind: 'idle' })
      } catch (error) {
        if (operationId !== operationSequence.current) return
        setState({
          ...previous,
          recoveryError: `The local recovery entry could not be cleared. ${describeRpcError(
            error,
            'Browser storage is unavailable.',
          )}`,
        })
      } finally {
        if (operationId === operationSequence.current) {
          dismissalActive.current = false
          setDismissalPending(false)
        }
      }
    })()
  }

  const contextCurrent =
    state.kind !== 'idle' &&
    state.kind !== 'cleanup' &&
    walletContextMatches(state.context, session)
  const buttonLabel =
    state.kind === 'preparing'
      ? 'Preparing storage attempt…'
      : state.kind === 'uploading'
        ? 'Uploading CAR…'
        : state.kind === 'signing'
          ? 'Waiting for signatures…'
          : state.kind === 'pending' || state.kind === 'checking'
            ? 'Checking provider transaction…'
            : 'Upload and authorize one copy'

  return (
    <section className="filecoin-storage-upload" aria-labelledby={titleId}>
      <h5 id={titleId}>Upload to an independent Filecoin provider</h5>
      <p>
        Choose one on-chain provider ID. The CAR is sent directly to its public
        HTTPS service, while the provider submits the paid EVM transaction.
      </p>
      {!quote ? (
        <p>Run the contract check and one-copy quote above before uploading.</p>
      ) : !ready ? (
        <p>
          A fresh ready quote for this wallet, chain, and exact CAR is required.
          Fund Filecoin Pay above if the current estimate is not ready.
        </p>
      ) : (
        <>
          <label htmlFor={providerIdId}>
            Provider ID
            <input
              aria-describedby={`${providerIdId}-help`}
              disabled={disabled || writeLocked || settled}
              id={providerIdId}
              inputMode="numeric"
              maxLength={78}
              onChange={(event) => {
                setProviderIdInput(event.target.value)
                setAcknowledged(false)
              }}
              placeholder="Positive on-chain ID"
              type="text"
              value={providerIdInput}
            />
          </label>
          <p id={`${providerIdId}-help`}>
            Lifeinvader verifies this provider in the pinned registry but does
            not endorse it, select it automatically, or hide it from the public
            chain.
          </p>
          {providerIdInput && providerId === undefined ? (
            <p className="error-message" role="alert">
              Enter a positive uint256 provider ID without spaces or leading
              zeroes.
            </p>
          ) : null}
          <div className="filecoin-storage-upload-warning">
            <p>
              <strong>Expect two MetaMask typed-data prompts.</strong> The first
              can create a charged data set even if the piece step later fails.
            </p>
            <p>
              The account, provider, CID, PieceCID, and attempt ID are public.
              Indexing is requested, never promised. This does not publish a
              Lifeinvader post.
            </p>
          </div>
          <label
            className="filecoin-storage-acknowledgment"
            htmlFor={acknowledgmentId}
          >
            <input
              checked={acknowledged}
              disabled={
                disabled || writeLocked || settled || providerId === undefined
              }
              id={acknowledgmentId}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>
              I understand the provider receives these public bytes, the first
              signature may incur a fee, and storage remains separate from
              publication.
            </span>
          </label>
          <button
            className="button-accent"
            disabled={
              disabled ||
              writeLocked ||
              settled ||
              !acknowledged ||
              providerId === undefined
            }
            onClick={runUpload}
            type="button"
          >
            {buttonLabel}
          </button>
        </>
      )}

      <FilecoinUploadStatus
        contextCurrent={contextCurrent}
        disabled={disabled || dismissalPending}
        onClearAmbiguous={dismissRecovery}
        onClearUnknown={dismissRecovery}
        onReset={reset}
        onRetryRecoveryCleanup={retryRecoveryCleanup}
        onRetryReceipt={retryReceipt}
        state={state}
      />
    </section>
  )
}
