import { useEffect, useId, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
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
import type { WalletSession } from './wallet-session'

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

export function FilecoinStoragePanel({
  disabled = false,
  inspectStorage = inspectFilecoinStorage,
  prepared,
  publicationChainId,
  quoteStorage = quoteFilecoinStorage,
  session,
}: {
  disabled?: boolean
  inspectStorage?: FilecoinStorageInspector
  prepared?: PreparedMediaCar
  publicationChainId?: bigint
  quoteStorage?: FilecoinStorageQuoter
  session: WalletSession
}) {
  const titleId = useId()
  const inspectionSequence = useRef(0)
  const quoteSequence = useRef(0)
  const activeInspectionController = useRef<AbortController | undefined>(
    undefined,
  )
  const activeQuoteController = useRef<AbortController | undefined>(undefined)
  const [state, setState] = useState<InspectionState>({ kind: 'idle' })
  const [quoteState, setQuoteState] = useState<QuoteState>({ kind: 'idle' })
  const network = getFilecoinStorageNetwork(session.chainId)

  useEffect(() => {
    inspectionSequence.current += 1
    quoteSequence.current += 1
    activeInspectionController.current?.abort()
    activeQuoteController.current?.abort()
    activeInspectionController.current = undefined
    activeQuoteController.current = undefined
    setState({ kind: 'idle' })
    setQuoteState({ kind: 'idle' })
    return () => {
      inspectionSequence.current += 1
      quoteSequence.current += 1
      activeInspectionController.current?.abort()
      activeQuoteController.current?.abort()
      activeInspectionController.current = undefined
      activeQuoteController.current = undefined
    }
  }, [
    prepared?.mediaCid.text,
    session.account,
    session.chainId,
    session.provider,
  ])

  if (!prepared) return null

  const runInspection = () => {
    const provider = session.provider
    if (!provider || session.status !== 'connected' || !network) return
    const operationId = ++inspectionSequence.current
    quoteSequence.current += 1
    activeInspectionController.current?.abort()
    activeQuoteController.current?.abort()
    const controller = new AbortController()
    activeInspectionController.current = controller
    activeQuoteController.current = undefined
    setState({ kind: 'checking' })
    setQuoteState({ kind: 'idle' })
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
      state.inspection.kind !== 'ready'
    )
      return
    const operationId = ++quoteSequence.current
    activeQuoteController.current?.abort()
    const controller = new AbortController()
    activeQuoteController.current = controller
    setQuoteState({ kind: 'checking' })
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

  const inspection = state.kind === 'complete' ? state.inspection : undefined
  const quote = quoteState.kind === 'complete' ? quoteState.quote : undefined
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
                disabled={disabled || quoteState.kind === 'checking'}
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
                Costs are live chain state and may change. Refresh before a
                later funding transaction. No transaction or provider upload was
                requested.
              </p>
            </div>
          ) : null}
          {quoteState.kind === 'error' ? (
            <p className="error-message" role="alert">
              {quoteState.message}
            </p>
          ) : null}
        </div>
      )}

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
