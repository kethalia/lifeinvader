import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import {
  createHttpRpcProvider,
  MAX_HTTP_RPC_ENDPOINT_LENGTH,
  type HttpRpcProvider,
} from './http-rpc'
import {
  verifyReadRpcProvider,
  type ReadRpcVerification,
  type ReadRpcVerifier,
} from './read-rpc'
import type { WalletSession } from './wallet-session'

export type ReadRpcSelection = Readonly<{
  chainId: bigint
  provider: HttpRpcProvider
  verification: ReadRpcVerification
  walletProvider: Eip1193Provider
}>

type SelectionContext = {
  chainId: bigint
  walletProvider: Eip1193Provider
}

type ScopedError = SelectionContext & { message: string }

type SelectionAttempt = SelectionContext & {
  candidate: HttpRpcProvider
  candidateClosed: boolean
  controller: AbortController
}

export type ReadRpcSelectionController = {
  clear(): void
  connected: boolean
  dismissError(): void
  error?: string
  pending: boolean
  select(endpoint: string): Promise<boolean>
  selection?: ReadRpcSelection
}

export type ReadRpcSelectionOptions = {
  createProvider?: (endpoint: string) => HttpRpcProvider
  verify?: ReadRpcVerifier
}

function connectedContext(
  session: WalletSession,
): SelectionContext | undefined {
  return session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
    ? { chainId: session.chainId, walletProvider: session.provider }
    : undefined
}

function sameContext(
  context: SelectionContext | undefined,
  candidate: SelectionContext | undefined,
) {
  return (
    context !== undefined &&
    candidate !== undefined &&
    context.chainId === candidate.chainId &&
    context.walletProvider === candidate.walletProvider
  )
}

export function useReadRpcSelection(
  session: WalletSession,
  {
    createProvider = createHttpRpcProvider,
    verify = verifyReadRpcProvider,
  }: ReadRpcSelectionOptions = {},
): ReadRpcSelectionController {
  const [selectionState, setSelectionState] = useState<ReadRpcSelection>()
  const [pendingContext, setPendingContext] = useState<SelectionContext>()
  const [scopedError, setScopedError] = useState<ScopedError>()
  const activeAttempt = useRef<SelectionAttempt | undefined>(undefined)
  const selectionRef = useRef<ReadRpcSelection | undefined>(undefined)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const context = connectedContext(session)

  const replaceSelection = useCallback((next?: ReadRpcSelection) => {
    const current = selectionRef.current
    if (current?.provider !== next?.provider) current?.provider.close()
    selectionRef.current = next
    setSelectionState(next)
  }, [])

  const stopAttempt = useCallback(() => {
    const attempt = activeAttempt.current
    if (!attempt) return
    activeAttempt.current = undefined
    attempt.controller.abort()
    if (!attempt.candidateClosed) {
      attempt.candidateClosed = true
      attempt.candidate.close()
    }
  }, [])

  useEffect(() => {
    stopAttempt()
    setPendingContext(undefined)
    setScopedError(undefined)
    if (!sameContext(selectionRef.current, context)) {
      replaceSelection(undefined)
    }
  }, [context?.chainId, context?.walletProvider, replaceSelection, stopAttempt])

  useEffect(
    () => () => {
      stopAttempt()
      selectionRef.current?.provider.close()
      selectionRef.current = undefined
    },
    [stopAttempt],
  )

  const clear = useCallback(() => {
    stopAttempt()
    setPendingContext(undefined)
    setScopedError(undefined)
    replaceSelection(undefined)
  }, [replaceSelection, stopAttempt])

  const dismissError = useCallback(() => setScopedError(undefined), [])

  const select = useCallback(
    async (endpoint: string) => {
      const attemptContext = connectedContext(sessionRef.current)
      if (!attemptContext) return false
      stopAttempt()
      setPendingContext(undefined)
      setScopedError(undefined)

      let candidate: HttpRpcProvider
      try {
        candidate = createProvider(endpoint)
      } catch (error) {
        if (sameContext(attemptContext, connectedContext(sessionRef.current))) {
          setScopedError({
            ...attemptContext,
            message: describeRpcError(
              error,
              'The read RPC endpoint is invalid.',
            ),
          })
        }
        return false
      }

      const attempt: SelectionAttempt = {
        ...attemptContext,
        candidate,
        candidateClosed: false,
        controller: new AbortController(),
      }
      activeAttempt.current = attempt
      setPendingContext(attemptContext)
      try {
        const verification = await verify(
          attemptContext.walletProvider,
          attemptContext.chainId,
          candidate,
          { signal: attempt.controller.signal },
        )
        if (
          attempt.controller.signal.aborted ||
          activeAttempt.current !== attempt ||
          !sameContext(attemptContext, connectedContext(sessionRef.current))
        ) {
          return false
        }
        const selection = Object.freeze({
          ...attemptContext,
          provider: candidate,
          verification,
        })
        activeAttempt.current = undefined
        setPendingContext(undefined)
        replaceSelection(selection)
        return true
      } catch (error) {
        if (
          !attempt.controller.signal.aborted &&
          activeAttempt.current === attempt &&
          sameContext(attemptContext, connectedContext(sessionRef.current))
        ) {
          setScopedError({
            ...attemptContext,
            message: describeRpcError(
              error,
              'The read RPC endpoint could not be verified.',
            ),
          })
        }
        return false
      } finally {
        if (activeAttempt.current === attempt) {
          activeAttempt.current = undefined
          setPendingContext(undefined)
        }
        if (
          selectionRef.current?.provider !== candidate &&
          !attempt.candidateClosed
        ) {
          attempt.candidateClosed = true
          candidate.close()
        }
      }
    },
    [createProvider, replaceSelection, stopAttempt, verify],
  )

  const activeSelection = sameContext(selectionState, context)
    ? selectionState
    : undefined
  return {
    clear,
    connected: context !== undefined,
    dismissError,
    error: sameContext(scopedError, context) ? scopedError?.message : undefined,
    pending: sameContext(pendingContext, context),
    select,
    selection: activeSelection,
  }
}

export function ReadRpcPanel({
  controller,
  session,
}: {
  controller: ReadRpcSelectionController
  session: WalletSession
}) {
  const [draftState, setDraftState] = useState<{
    chainId?: bigint
    provider?: Eip1193Provider
    status: WalletSession['status']
    value: string
  }>()
  const draft =
    draftState?.status === session.status &&
    draftState.provider === session.provider &&
    draftState.chainId === session.chainId
      ? draftState.value
      : ''
  const setDraft = (value: string) =>
    setDraftState({
      chainId: session.chainId,
      provider: session.provider,
      status: session.status,
      value,
    })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void controller.select(draft).then((selected) => {
      if (selected) setDraft('')
    })
  }

  return (
    <section className="read-rpc-panel" aria-labelledby="read-rpc-title">
      <div>
        <p className="eyebrow">Bring your own public infrastructure</p>
        <h2 id="read-rpc-title">Choose the feed’s read RPC.</h2>
        <p id="read-rpc-help">
          This URL stays in this tab and is never posted on-chain or saved by
          Lifeinvader. Verification compares the wallet and endpoint at one
          shared confirmed block. The endpoint can observe your IP address,
          requested methods, contract address, and page origin.
        </p>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="read-rpc-endpoint">HTTPS JSON-RPC endpoint</label>
        <input
          aria-describedby="read-rpc-help"
          autoComplete="off"
          disabled={!controller.connected || controller.pending}
          id="read-rpc-endpoint"
          maxLength={MAX_HTTP_RPC_ENDPOINT_LENGTH}
          onChange={(event) => {
            setDraft(event.target.value)
            controller.dismissError()
          }}
          placeholder="https://rpc.example/your-key"
          spellCheck={false}
          type="url"
          value={draft}
        />
        <div className="read-rpc-actions">
          <button
            disabled={
              !controller.connected || controller.pending || draft.trim() === ''
            }
            type="submit"
          >
            {controller.pending ? 'Verifying RPC…' : 'Verify and use RPC'}
          </button>
          {controller.selection ? (
            <button
              disabled={controller.pending}
              onClick={controller.clear}
              type="button"
            >
              Use wallet RPC
            </button>
          ) : null}
        </div>
      </form>
      <div className="read-rpc-status" aria-live="polite">
        {!controller.connected ? (
          <p>Connect a wallet before selecting a matching read endpoint.</p>
        ) : controller.selection ? (
          <p>
            Public feed reads use{' '}
            <strong>{controller.selection.verification.endpointOrigin}</strong>,
            matched to wallet history at confirmed block{' '}
            {controller.selection.verification.blockNumber.toString()}.
          </p>
        ) : (
          <p>
            Public feed reads currently use the wallet’s RPC. Entering a URL
            sends nothing until you choose verification.
          </p>
        )}
        {controller.error ? <p role="alert">{controller.error}</p> : null}
      </div>
    </section>
  )
}
