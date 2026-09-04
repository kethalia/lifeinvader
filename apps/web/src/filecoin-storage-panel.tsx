import { useEffect, useId, useRef, useState } from 'react'
import { formatUnits, type Address, type Hash } from 'viem'
import {
  describeRpcError,
  getRpcErrorCode,
  type Eip1193Provider,
} from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_MAINNET_CHAIN_ID,
  FILECOIN_STORAGE_CONTRACT_LABELS,
  getFilecoinStorageNetwork,
  inspectFilecoinStorage,
  type FilecoinStorageInspection,
  type FilecoinStorageInspectionOptions,
} from './filecoin-storage'
import {
  quoteFilecoinStorage,
  type FilecoinStorageQuote,
  type FilecoinStorageQuoteOptions,
} from './filecoin-storage-quote'
import type { PreparedMediaCar } from './paid-media-car'
import {
  isTransactionRevertedError,
  isTransactionSubmissionUnknownError,
  type TransactionReceipt,
} from './protocol'
import type { WalletSession } from './wallet-session'

type FilecoinStorageFundingModule = typeof import('./filecoin-storage-funding')

export type FilecoinStorageFunder =
  FilecoinStorageFundingModule['fundFilecoinStorage']

export type FilecoinStorageFundingReceiptChecker =
  FilecoinStorageFundingModule['checkFilecoinStorageFundingReceipt']

export type FilecoinStorageInspector = (
  provider: Eip1193Provider,
  options?: FilecoinStorageInspectionOptions,
) => Promise<FilecoinStorageInspection>

export type FilecoinStorageQuoter = (
  provider: Eip1193Provider,
  carByteLength: number,
  options: FilecoinStorageQuoteOptions,
) => Promise<FilecoinStorageQuote>

type InspectionState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { inspection: FilecoinStorageInspection; kind: 'complete' }
  | { kind: 'error'; message: string }

type QuoteState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'complete'; quote: FilecoinStorageQuote }
  | { kind: 'error'; message: string }

type FundingContext = {
  account: Address
  carByteLength: number
  chainId: bigint
  mediaCid: string
  provider: Eip1193Provider
  quote: FilecoinStorageQuote
  walletName: string
}

type FundingState =
  | { kind: 'idle' }
  | { context: FundingContext; kind: 'refreshing' }
  | { context: FundingContext; kind: 'opening' }
  | { context: FundingContext; hash: Hash; kind: 'pending' }
  | {
      context: FundingContext
      kind: 'ambiguous' | 'changed' | 'error' | 'rejected'
      message: string
    }
  | {
      context: FundingContext
      hash: Hash
      kind: 'failed' | 'unknown'
      message: string
    }
  | { context: FundingContext; kind: 'confirmed'; receipt: TransactionReceipt }

function formatByteLength(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatUsdfc(value: bigint, decimals: number) {
  return `${formatUnits(value, decimals)} USDFC`
}

function quoteFingerprint(quote: FilecoinStorageQuote) {
  return [
    quote.account.toLowerCase(),
    quote.chainId,
    quote.copies,
    quote.dataSize,
    quote.depositNeeded,
    quote.fees.addPiecesFee,
    quote.fees.createDataSetFee,
    quote.fees.total,
    quote.lockups.cacheMissLockup,
    quote.lockups.cdnLockup,
    quote.lockups.lifecycleLockup,
    quote.lockups.rateDeltaPerEpoch,
    quote.lockups.reserveReplenishment,
    quote.lockups.streamingLockup,
    quote.lockups.total,
    quote.needsServiceApproval,
    quote.rates.perEpoch,
    quote.rates.perMonth,
    quote.ready,
    quote.tokenDecimals,
    quote.tokenSymbol,
    quote.withCDN,
  ].join('|')
}

function fundingContextMatchesSession(
  context: FundingContext,
  session: WalletSession,
) {
  return (
    session.status === 'connected' &&
    session.provider === context.provider &&
    session.chainId === context.chainId &&
    session.account?.toLowerCase() === context.account.toLowerCase()
  )
}

function fundingStateLocksWrites(state: FundingState) {
  return (
    state.kind === 'refreshing' ||
    state.kind === 'opening' ||
    state.kind === 'pending' ||
    state.kind === 'unknown' ||
    state.kind === 'ambiguous'
  )
}

function fundingLockupPeriod(quote: FilecoinStorageQuote) {
  return quote.lockups.rateDeltaPerEpoch > 0n
    ? quote.lockups.streamingLockup / quote.lockups.rateDeltaPerEpoch
    : 0n
}

function FilecoinFundingStatus({
  contextCurrent,
  disabled,
  onClearAmbiguous,
  onClearUnknown,
  onRetryReceipt,
  state,
}: {
  contextCurrent: boolean
  disabled: boolean
  onClearAmbiguous(): void
  onClearUnknown(): void
  onRetryReceipt(): void
  state: FundingState
}) {
  if (state.kind === 'idle') return null
  if (!contextCurrent && !fundingStateLocksWrites(state)) return null
  if (state.kind === 'refreshing') {
    return <p role="status">Refreshing every displayed funding term…</p>
  }
  if (state.kind === 'opening') {
    return (
      <p role="status">
        Confirm the permit, if requested, and the one Filecoin Pay transaction
        in {state.context.walletName}.
      </p>
    )
  }
  if (state.kind === 'pending') {
    return (
      <p className="filecoin-storage-funding-status" role="status">
        Funding submitted on chain {state.context.chainId.toString()} ·{' '}
        <code title={state.hash}>{shortAddress(state.hash)}</code>. Waiting for
        its exact Filecoin Pay events…
      </p>
    )
  }
  if (state.kind === 'confirmed') {
    return (
      <div className="filecoin-storage-funding-status" role="status">
        <p>
          Account funding confirmed in block{' '}
          {state.receipt.blockNumber.toString()} ·{' '}
          <code title={state.receipt.hash}>
            {shortAddress(state.receipt.hash)}
          </code>
          .
        </p>
        <p>
          The CAR is still local and has not been uploaded or bound to a
          provider. Request or review a fresh account quote before another
          funding action.
        </p>
      </div>
    )
  }
  if (state.kind === 'unknown' || state.kind === 'failed') {
    return (
      <div className="filecoin-storage-funding-problem" role="alert">
        <p>{state.message}</p>
        <p>
          Transaction <code title={state.hash}>{shortAddress(state.hash)}</code>{' '}
          {state.kind === 'failed'
            ? 'reverted on-chain; refresh the quote before trying again.'
            : 'has an unknown final status. Do not submit another funding transaction yet.'}
        </p>
        {state.kind === 'unknown' ? (
          <div className="transaction-recovery-actions">
            <button
              disabled={disabled || !contextCurrent}
              onClick={onRetryReceipt}
              type="button"
            >
              {contextCurrent
                ? 'Check funding receipt again'
                : 'Reconnect original wallet to check receipt'}
            </button>
            <button onClick={onClearUnknown} type="button">
              I checked this funding hash; clear lock
            </button>
          </div>
        ) : null}
      </div>
    )
  }
  if (state.kind === 'ambiguous') {
    return (
      <div className="filecoin-storage-funding-problem" role="alert">
        <p>{state.message}</p>
        <p>
          The wallet returned no hash but may have broadcast. Close or reject
          any still-open prompt, then check wallet activity before allowing
          another funding attempt.
        </p>
        <button disabled={disabled} onClick={onClearAmbiguous} type="button">
          I checked the wallet; clear funding lock
        </button>
      </div>
    )
  }
  return (
    <p
      className={
        state.kind === 'changed'
          ? 'filecoin-storage-funding-status'
          : 'error-message'
      }
      role={state.kind === 'changed' ? 'status' : 'alert'}
    >
      {state.message}
    </p>
  )
}

export function FilecoinStoragePanel({
  checkFundingReceipt,
  disabled = false,
  fundStorage,
  inspectStorage = inspectFilecoinStorage,
  onWriteLockChange,
  prepared,
  publicationChainId,
  quoteStorage = quoteFilecoinStorage,
  session,
}: {
  checkFundingReceipt?: FilecoinStorageFundingReceiptChecker
  disabled?: boolean
  fundStorage?: FilecoinStorageFunder
  inspectStorage?: FilecoinStorageInspector
  onWriteLockChange?(locked: boolean): void
  prepared?: PreparedMediaCar
  publicationChainId?: bigint
  quoteStorage?: FilecoinStorageQuoter
  session: WalletSession
}) {
  const titleId = useId()
  const fundingAcknowledgmentId = useId()
  const inspectionSequence = useRef(0)
  const quoteSequence = useRef(0)
  const fundingSequence = useRef(0)
  const fundingOperationActive = useRef(false)
  const sessionRef = useRef(session)
  const activeInspectionController = useRef<AbortController | undefined>(
    undefined,
  )
  const activeQuoteController = useRef<AbortController | undefined>(undefined)
  const activeFundingController = useRef<AbortController | undefined>(undefined)
  const [state, setState] = useState<InspectionState>({ kind: 'idle' })
  const [quoteState, setQuoteState] = useState<QuoteState>({ kind: 'idle' })
  const [fundingState, setFundingState] = useState<FundingState>({
    kind: 'idle',
  })
  const [fundingAcknowledged, setFundingAcknowledged] = useState(false)
  const network = getFilecoinStorageNetwork(session.chainId)
  const fundingWriteLocked = fundingStateLocksWrites(fundingState)
  sessionRef.current = session

  useEffect(() => {
    onWriteLockChange?.(fundingWriteLocked)
    return () => onWriteLockChange?.(false)
  }, [fundingWriteLocked, onWriteLockChange])

  useEffect(() => {
    inspectionSequence.current += 1
    quoteSequence.current += 1
    fundingSequence.current += 1
    activeInspectionController.current?.abort()
    activeQuoteController.current?.abort()
    activeFundingController.current?.abort()
    activeInspectionController.current = undefined
    activeQuoteController.current = undefined
    activeFundingController.current = undefined
    fundingOperationActive.current = false
    setState({ kind: 'idle' })
    setQuoteState({ kind: 'idle' })
    setFundingState((current) => {
      if (current.kind === 'opening') {
        return {
          context: current.context,
          kind: 'ambiguous',
          message:
            'The wallet context or prepared CAR changed while the Filecoin Pay request was open.',
        }
      }
      if (current.kind === 'pending') {
        return {
          context: current.context,
          hash: current.hash,
          kind: 'unknown',
          message:
            'The wallet context or prepared CAR changed before the Filecoin Pay receipt was confirmed.',
        }
      }
      if (current.kind === 'unknown' || current.kind === 'ambiguous') {
        return current
      }
      return { kind: 'idle' }
    })
    setFundingAcknowledged(false)
    return () => {
      inspectionSequence.current += 1
      quoteSequence.current += 1
      fundingSequence.current += 1
      activeInspectionController.current?.abort()
      activeQuoteController.current?.abort()
      activeFundingController.current?.abort()
      activeInspectionController.current = undefined
      activeQuoteController.current = undefined
      activeFundingController.current = undefined
      fundingOperationActive.current = false
    }
  }, [
    prepared?.carBytes,
    prepared?.mediaCid.text,
    session.account,
    session.chainId,
    session.provider,
    session.status,
  ])

  if (!prepared) return null

  const runInspection = () => {
    const provider = session.provider
    if (
      !provider ||
      session.status !== 'connected' ||
      !network ||
      fundingWriteLocked
    )
      return
    const operationId = ++inspectionSequence.current
    quoteSequence.current += 1
    activeInspectionController.current?.abort()
    activeQuoteController.current?.abort()
    const controller = new AbortController()
    activeInspectionController.current = controller
    activeQuoteController.current = undefined
    setState({ kind: 'checking' })
    setQuoteState({ kind: 'idle' })
    setFundingState({ kind: 'idle' })
    setFundingAcknowledged(false)
    void (async () => {
      try {
        const inspection = await inspectStorage(provider, {
          expectedChainId: network.chainId,
          signal: controller.signal,
        })
        if (
          operationId !== inspectionSequence.current ||
          controller.signal.aborted
        )
          return
        setState({ inspection, kind: 'complete' })
      } catch (error) {
        if (
          operationId !== inspectionSequence.current ||
          controller.signal.aborted
        )
          return
        setState({
          kind: 'error',
          message: describeRpcError(
            error,
            'Filecoin storage could not be inspected through the wallet.',
          ),
        })
      } finally {
        if (operationId === inspectionSequence.current) {
          activeInspectionController.current = undefined
        }
      }
    })()
  }

  const runQuote = () => {
    const provider = session.provider
    const account = session.account
    if (
      !provider ||
      !account ||
      session.status !== 'connected' ||
      !network ||
      state.kind !== 'complete' ||
      state.inspection.kind !== 'ready' ||
      fundingWriteLocked
    )
      return
    const operationId = ++quoteSequence.current
    activeQuoteController.current?.abort()
    const controller = new AbortController()
    activeQuoteController.current = controller
    setQuoteState({ kind: 'checking' })
    setFundingState({ kind: 'idle' })
    setFundingAcknowledged(false)
    void (async () => {
      try {
        const quote = await quoteStorage(
          provider,
          prepared.carBytes.byteLength,
          {
            expectedAccount: account,
            expectedChainId: network.chainId,
            signal: controller.signal,
          },
        )
        if (operationId !== quoteSequence.current || controller.signal.aborted)
          return
        setQuoteState({ kind: 'complete', quote })
      } catch (error) {
        if (operationId !== quoteSequence.current || controller.signal.aborted)
          return
        setQuoteState({
          kind: 'error',
          message: describeRpcError(
            error,
            'Filecoin storage costs could not be quoted through the wallet.',
          ),
        })
      } finally {
        if (operationId === quoteSequence.current) {
          activeQuoteController.current = undefined
        }
      }
    })()
  }

  const refreshQuoteAfterFunding = async (
    context: FundingContext,
    operationId: number,
    signal: AbortSignal,
  ) => {
    if (
      operationId !== fundingSequence.current ||
      signal.aborted ||
      !fundingContextMatchesSession(context, sessionRef.current)
    )
      return
    setQuoteState({ kind: 'checking' })
    try {
      const refreshed = await quoteStorage(
        context.provider,
        context.carByteLength,
        {
          expectedAccount: context.account,
          expectedChainId: context.chainId,
          signal,
        },
      )
      if (
        operationId !== fundingSequence.current ||
        signal.aborted ||
        !fundingContextMatchesSession(context, sessionRef.current)
      )
        return
      setQuoteState({ kind: 'complete', quote: refreshed })
    } catch (error) {
      if (
        operationId !== fundingSequence.current ||
        signal.aborted ||
        !fundingContextMatchesSession(context, sessionRef.current)
      )
        return
      setQuoteState({
        kind: 'error',
        message: describeRpcError(
          error,
          'The confirmed funding could not be rechecked through the wallet.',
        ),
      })
    }
  }

  const runFunding = () => {
    const provider = session.provider
    const account = session.account
    const displayedQuote =
      quoteState.kind === 'complete' ? quoteState.quote : undefined
    if (
      disabled ||
      fundingOperationActive.current ||
      !fundingAcknowledged ||
      !provider ||
      !account ||
      session.status !== 'connected' ||
      !network ||
      !displayedQuote ||
      displayedQuote.ready
    )
      return

    fundingOperationActive.current = true
    const operationId = ++fundingSequence.current
    const controller = new AbortController()
    activeFundingController.current?.abort()
    activeFundingController.current = controller
    const context: FundingContext = {
      account,
      carByteLength: prepared.carBytes.byteLength,
      chainId: network.chainId,
      mediaCid: prepared.mediaCid.text,
      provider,
      quote: displayedQuote,
      walletName: session.name ?? 'Injected wallet',
    }
    let attemptContext = context
    let submittedHash: Hash | undefined
    let quoteRefreshCompleted = false
    let walletRequestOpened = false
    setFundingAcknowledged(false)
    setFundingState({ context, kind: 'refreshing' })
    setQuoteState({ kind: 'checking' })

    void (async () => {
      try {
        const freshQuote = await quoteStorage(provider, context.carByteLength, {
          expectedAccount: account,
          expectedChainId: context.chainId,
          signal: controller.signal,
        })
        quoteRefreshCompleted = true
        attemptContext = { ...context, quote: freshQuote }
        if (
          controller.signal.aborted ||
          !fundingContextMatchesSession(context, sessionRef.current)
        ) {
          throw new Error(
            'The wallet or prepared CAR changed before funding began.',
          )
        }
        setQuoteState({ kind: 'complete', quote: freshQuote })
        if (
          freshQuote.ready ||
          quoteFingerprint(freshQuote) !== quoteFingerprint(displayedQuote)
        ) {
          setFundingState({
            context: attemptContext,
            kind: 'changed',
            message: freshQuote.ready
              ? 'The refreshed quote is already funded. Review the new ready state; no transaction was opened.'
              : 'The live quote changed. Review the new amount and approval terms, acknowledge them again, then retry.',
          })
          return
        }

        const action =
          fundStorage ??
          (await import('./filecoin-storage-funding')).fundFilecoinStorage
        if (
          controller.signal.aborted ||
          !fundingContextMatchesSession(context, sessionRef.current)
        ) {
          throw new Error(
            'The wallet or prepared CAR changed before funding began.',
          )
        }
        walletRequestOpened = true
        setFundingState({ context: attemptContext, kind: 'opening' })
        const receipt = await action(provider, freshQuote, {
          expectedAccount: account,
          expectedChainId: context.chainId,
          onSubmitted: (hash) => {
            if (operationId !== fundingSequence.current) return
            submittedHash = hash
            setFundingState({
              context: attemptContext,
              hash,
              kind: 'pending',
            })
          },
          signal: controller.signal,
        })
        if (operationId !== fundingSequence.current) return
        setFundingState({
          context: attemptContext,
          kind: 'confirmed',
          receipt,
        })
        await refreshQuoteAfterFunding(
          attemptContext,
          operationId,
          controller.signal,
        )
      } catch (error) {
        if (operationId !== fundingSequence.current) return
        if (
          !quoteRefreshCompleted &&
          !controller.signal.aborted &&
          fundingContextMatchesSession(context, sessionRef.current)
        ) {
          setQuoteState({ kind: 'complete', quote: context.quote })
        }
        const message =
          controller.signal.aborted && !submittedHash
            ? 'The wallet or prepared CAR changed before funding completed.'
            : describeRpcError(error, 'The Filecoin Pay funding action failed.')
        if (submittedHash) {
          setFundingState({
            context: attemptContext,
            hash: submittedHash,
            kind: isTransactionRevertedError(error) ? 'failed' : 'unknown',
            message,
          })
        } else if (
          isTransactionSubmissionUnknownError(error) ||
          (controller.signal.aborted &&
            walletRequestOpened &&
            getRpcErrorCode(error) !== 4001)
        ) {
          setFundingState({
            context: attemptContext,
            kind: 'ambiguous',
            message,
          })
        } else {
          setFundingState({
            context: attemptContext,
            kind: getRpcErrorCode(error) === 4001 ? 'rejected' : 'error',
            message,
          })
        }
      } finally {
        if (operationId === fundingSequence.current) {
          fundingOperationActive.current = false
        }
        if (activeFundingController.current === controller) {
          activeFundingController.current = undefined
        }
      }
    })()
  }

  const clearAmbiguousFunding = () => {
    if (fundingState.kind !== 'ambiguous') return
    fundingSequence.current += 1
    activeFundingController.current?.abort()
    activeFundingController.current = undefined
    fundingOperationActive.current = false
    setFundingState({ kind: 'idle' })
  }

  const clearUnknownFunding = () => {
    if (fundingState.kind !== 'unknown') return
    fundingSequence.current += 1
    activeFundingController.current?.abort()
    activeFundingController.current = undefined
    fundingOperationActive.current = false
    setFundingState({ kind: 'idle' })
  }

  const retryFundingReceipt = () => {
    if (
      fundingState.kind !== 'unknown' ||
      fundingOperationActive.current ||
      !fundingContextMatchesSession(fundingState.context, session)
    )
      return
    fundingOperationActive.current = true
    const operationId = ++fundingSequence.current
    const context = fundingState.context
    const hash = fundingState.hash
    const controller = new AbortController()
    activeFundingController.current = controller
    setFundingState({ context, hash, kind: 'pending' })

    void (async () => {
      try {
        const action =
          checkFundingReceipt ??
          (await import('./filecoin-storage-funding'))
            .checkFilecoinStorageFundingReceipt
        if (!fundingContextMatchesSession(context, sessionRef.current)) {
          throw new Error('Reconnect the original wallet context first.')
        }
        const receipt = await action(context.provider, hash, context.quote, {
          expectedAccount: context.account,
          expectedChainId: context.chainId,
        })
        if (operationId !== fundingSequence.current) return
        setFundingState({ context, kind: 'confirmed', receipt })
        await refreshQuoteAfterFunding(context, operationId, controller.signal)
      } catch (error) {
        if (operationId !== fundingSequence.current) return
        setFundingState({
          context,
          hash,
          kind: isTransactionRevertedError(error) ? 'failed' : 'unknown',
          message: describeRpcError(
            error,
            'The Filecoin Pay receipt could not be confirmed.',
          ),
        })
      } finally {
        if (operationId === fundingSequence.current) {
          fundingOperationActive.current = false
        }
        if (activeFundingController.current === controller) {
          activeFundingController.current = undefined
        }
      }
    })()
  }

  const inspection = state.kind === 'complete' ? state.inspection : undefined
  const quote = quoteState.kind === 'complete' ? quoteState.quote : undefined
  const fundingContextCurrent =
    fundingState.kind !== 'idle' &&
    fundingContextMatchesSession(fundingState.context, session) &&
    fundingState.context.mediaCid === prepared.mediaCid.text &&
    fundingState.context.carByteLength === prepared.carBytes.byteLength
  const fundingButtonLabel =
    fundingState.kind === 'refreshing'
      ? 'Refreshing funding quote…'
      : fundingState.kind === 'opening'
        ? 'Opening wallet…'
        : fundingState.kind === 'pending'
          ? 'Waiting for funding receipt…'
          : 'Refresh quote and fund Filecoin Pay'
  return (
    <section className="filecoin-storage-panel" aria-labelledby={titleId}>
      <div>
        <p className="eyebrow">Optional paid persistence</p>
        <h4 id={titleId}>Check the Filecoin storage rail</h4>
      </div>
      <p>
        <strong>{prepared.file.name}</strong> and its{' '}
        {formatByteLength(prepared.carBytes.byteLength)} CAR remain in this tab.
        This step is separate from publishing the CID to Lifeinvader.
      </p>
      <code className="filecoin-storage-cid">{prepared.mediaCid.text}</code>

      {session.status !== 'connected' || !session.provider ? (
        <p>Reconnect the wallet before checking a paid storage network.</p>
      ) : !network ? (
        <div className="filecoin-storage-guidance">
          <p>
            Chain {session.chainId?.toString() ?? 'unknown'} is not a supported
            Filecoin storage rail. Select Filecoin mainnet (chain{' '}
            {FILECOIN_MAINNET_CHAIN_ID.toString()}) or Calibration (chain{' '}
            {FILECOIN_CALIBRATION_CHAIN_ID.toString()}) in the wallet.
          </p>
          <p>
            The app will not switch networks automatically or send a
            transaction. Your prepared CAR stays in memory while you switch.
          </p>
        </div>
      ) : (
        <div className="filecoin-storage-inspection">
          <p>
            The wallet reports {network.name} (chain{' '}
            {network.chainId.toString()}). Contract checks run only when you ask
            and never poll the RPC endpoint.
          </p>
          <button
            type="button"
            disabled={
              disabled ||
              fundingWriteLocked ||
              state.kind === 'checking' ||
              quoteState.kind === 'checking'
            }
            onClick={runInspection}
          >
            {state.kind === 'checking'
              ? 'Checking Filecoin contracts…'
              : state.kind === 'complete' || state.kind === 'error'
                ? 'Check Filecoin contracts again'
                : 'Check Filecoin contracts'}
          </button>

          {state.kind === 'checking' ? (
            <p role="status">Inspecting the deployed storage contract graph…</p>
          ) : null}
          {inspection?.kind === 'ready' ? (
            <div className="filecoin-storage-ready" role="status">
              <p>
                {inspection.network.name} passed the pinned storage-contract
                checks.
              </p>
              <code title={inspection.network.contracts.fwss}>
                FWSS {shortAddress(inspection.network.contracts.fwss)}
              </code>
              <p>
                Quote one new, non-CDN data set for one proof-backed copy of
                this CAR. The quote uses only capped wallet reads.
              </p>
              <button
                type="button"
                disabled={
                  disabled ||
                  fundingWriteLocked ||
                  quoteState.kind === 'checking'
                }
                onClick={runQuote}
              >
                {quoteState.kind === 'checking'
                  ? 'Reading Filecoin costs…'
                  : quoteState.kind === 'complete' ||
                      quoteState.kind === 'error'
                    ? 'Refresh one-copy quote'
                    : 'Quote one Filecoin copy'}
              </button>
              <p>
                The preflight and quote do not upload bytes, approve USDFC, fund
                Filecoin Pay, pin the CID, or publish a post.
              </p>
            </div>
          ) : null}
          {inspection?.kind === 'unavailable' ? (
            <div className="filecoin-storage-unavailable" role="alert">
              <p>The selected Filecoin deployment failed its safety checks.</p>
              <ul>
                {inspection.issues.map((issue) => (
                  <li
                    key={`${issue.contract}-${issue.kind}`}
                    title={
                      issue.kind === 'missing-code'
                        ? issue.address
                        : `Expected ${issue.expected}; received ${issue.received}`
                    }
                  >
                    {FILECOIN_STORAGE_CONTRACT_LABELS[issue.contract]}:{' '}
                    {issue.kind === 'missing-code'
                      ? 'no contract code found'
                      : 'FWSS reported an unexpected address'}
                  </li>
                ))}
              </ul>
              <p>No upload or payment was attempted.</p>
            </div>
          ) : null}
          {inspection?.kind === 'unsupported-chain' ? (
            <p className="error-message" role="alert">
              The wallet changed to unsupported chain{' '}
              {inspection.chainId.toString()} before the check began. Refresh
              the wallet connection and try again.
            </p>
          ) : null}
          {state.kind === 'error' ? (
            <p className="error-message" role="alert">
              {state.message}
            </p>
          ) : null}
          {quoteState.kind === 'checking' ? (
            <p role="status">
              Reading current Filecoin Pay balances, service approval, rates,
              fees, and lockups…
            </p>
          ) : null}
          {quote ? (
            <div className="filecoin-storage-quote" role="status">
              <p>
                One-copy estimate for a new data set and{' '}
                {formatByteLength(Number(quote.dataSize))} CAR:
              </p>
              <dl>
                <div>
                  <dt>Monthly rate</dt>
                  <dd>
                    <code>
                      {formatUsdfc(quote.rates.perMonth, quote.tokenDecimals)}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>One-time fees</dt>
                  <dd>
                    <code>
                      {formatUsdfc(quote.fees.total, quote.tokenDecimals)}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Required lockup</dt>
                  <dd>
                    <code>
                      {formatUsdfc(quote.lockups.total, quote.tokenDecimals)}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Deposit needed</dt>
                  <dd>
                    <code>
                      {formatUsdfc(quote.depositNeeded, quote.tokenDecimals)}
                    </code>
                  </dd>
                </div>
              </dl>
              <p>
                {quote.ready
                  ? 'Existing Filecoin Pay funds and service approval satisfy this estimate.'
                  : quote.needsServiceApproval
                    ? 'Funding would also require a maximum FWSS service approval.'
                    : 'The service approval is sufficient, but Filecoin Pay needs the displayed deposit.'}
              </p>
              <p>
                One-time fees are paid from the lifecycle reserve represented in
                the lockup; do not add them again to the deposit estimate.
              </p>
              <p>
                Costs are live chain state and may change. Refresh before a
                later funding transaction. No transaction or provider upload was
                requested.
              </p>
              {!quote.ready ? (
                <div className="filecoin-storage-funding">
                  <h5>Fund the public wallet account</h5>
                  <p>
                    This transaction deposits the displayed amount into Filecoin
                    Pay for{' '}
                    <code title={quote.account}>
                      {shortAddress(quote.account)}
                    </code>
                    . It is account-level credit, not a purchase tied to this
                    CAR or CID.
                  </p>
                  <p>
                    {quote.needsServiceApproval
                      ? `It also grants FWSS the maximum uint256 rate and lockup allowances with a maximum lockup period of ${fundingLockupPeriod(quote).toString()} epochs.`
                      : 'The existing FWSS service approval is sufficient, so no new operator approval is included.'}
                  </p>
                  <p>
                    <strong>
                      This does not upload bytes, choose a storage provider, pin
                      the CID, create a data set, or publish the Lifeinvader
                      post.
                    </strong>
                  </p>
                  <label
                    className="filecoin-storage-acknowledgment"
                    htmlFor={fundingAcknowledgmentId}
                  >
                    <input
                      checked={fundingAcknowledged}
                      disabled={disabled || fundingWriteLocked}
                      id={fundingAcknowledgmentId}
                      onChange={(event) =>
                        setFundingAcknowledged(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>
                      I understand the account-level deposit and approval terms,
                      and that media storage still requires a separate provider
                      upload.
                    </span>
                  </label>
                  <button
                    className="button-accent"
                    disabled={
                      disabled || fundingWriteLocked || !fundingAcknowledged
                    }
                    onClick={runFunding}
                    type="button"
                  >
                    {fundingButtonLabel}
                  </button>
                  <p>
                    The app rereads the full quote immediately before opening
                    the wallet. If any displayed term changes, it stops and asks
                    you to review again.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          {quoteState.kind === 'error' ? (
            <p className="error-message" role="alert">
              {quoteState.message}
            </p>
          ) : null}
        </div>
      )}

      <FilecoinFundingStatus
        contextCurrent={fundingContextCurrent}
        disabled={disabled}
        onClearAmbiguous={clearAmbiguousFunding}
        onClearUnknown={clearUnknownFunding}
        onRetryReceipt={retryFundingReceipt}
        state={fundingState}
      />

      {publicationChainId !== undefined &&
      session.chainId !== publicationChainId ? (
        <p className="filecoin-storage-return">
          After the storage step, return the wallet to publication chain{' '}
          {publicationChainId.toString()} to publish this CID as the original
          draft.
        </p>
      ) : null}
    </section>
  )
}
