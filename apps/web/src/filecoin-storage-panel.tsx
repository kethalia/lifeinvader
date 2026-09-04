import { useEffect, useId, useRef, useState } from 'react'
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
import type { PreparedMediaCar } from './paid-media-car'
import type { WalletSession } from './wallet-session'

export type FilecoinStorageInspector = (
  provider: Eip1193Provider,
  options?: FilecoinStorageInspectionOptions,
) => Promise<FilecoinStorageInspection>

type InspectionState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { inspection: FilecoinStorageInspection; kind: 'complete' }
  | { kind: 'error'; message: string }

function formatByteLength(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function FilecoinStoragePanel({
  disabled = false,
  inspectStorage = inspectFilecoinStorage,
  prepared,
  publicationChainId,
  session,
}: {
  disabled?: boolean
  inspectStorage?: FilecoinStorageInspector
  prepared?: PreparedMediaCar
  publicationChainId?: bigint
  session: WalletSession
}) {
  const titleId = useId()
  const operationSequence = useRef(0)
  const activeController = useRef<AbortController | undefined>(undefined)
  const [state, setState] = useState<InspectionState>({ kind: 'idle' })
  const network = getFilecoinStorageNetwork(session.chainId)

  useEffect(() => {
    operationSequence.current += 1
    activeController.current?.abort()
    activeController.current = undefined
    setState({ kind: 'idle' })
    return () => {
      operationSequence.current += 1
      activeController.current?.abort()
      activeController.current = undefined
    }
  }, [prepared?.mediaCid.text, session.chainId, session.provider])

  if (!prepared) return null

  const runInspection = () => {
    const provider = session.provider
    if (!provider || session.status !== 'connected' || !network) return
    const operationId = ++operationSequence.current
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    setState({ kind: 'checking' })
    void (async () => {
      try {
        const inspection = await inspectStorage(provider, {
          expectedChainId: network.chainId,
          signal: controller.signal,
        })
        if (
          operationId !== operationSequence.current ||
          controller.signal.aborted
        )
          return
        setState({ inspection, kind: 'complete' })
      } catch (error) {
        if (
          operationId !== operationSequence.current ||
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
        if (operationId === operationSequence.current) {
          activeController.current = undefined
        }
      }
    })()
  }

  const inspection = state.kind === 'complete' ? state.inspection : undefined
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
            disabled={disabled || state.kind === 'checking'}
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
                {inspection.network.name} is ready for a paid-storage adapter.
              </p>
              <code title={inspection.network.contracts.fwss}>
                FWSS {shortAddress(inspection.network.contracts.fwss)}
              </code>
              <p>
                This preflight did not upload bytes, approve USDFC, pay for
                storage, pin the CID, or publish a post.
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
