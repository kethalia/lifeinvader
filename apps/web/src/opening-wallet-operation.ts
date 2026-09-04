import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { WalletSession } from './wallet-session'

type OpeningAttempt = {
  id: number
  status: 'ambiguous' | 'failed' | 'opening' | 'pending' | 'unknown'
}

export type WalletOperationControl = { active: boolean }

/**
 * Make an injected-wallet prompt recoverable when its originating wallet
 * context disappears. Late callbacks are ignored after invalidation, while the
 * ambiguous attempt remains locked until the user confirms they checked the
 * original wallet activity.
 */
export function useOpeningWalletOperations<T extends OpeningAttempt>(
  attempts: T[],
  setAttempts: Dispatch<SetStateAction<T[]>>,
  session: WalletSession,
  matchesSession: (attempt: T, session: WalletSession) => boolean,
  onStranded?: (ids: ReadonlySet<number>) => void,
) {
  const controls = useRef(new Map<number, WalletOperationControl>())
  const matchesSessionRef = useRef(matchesSession)
  const onStrandedRef = useRef(onStranded)
  matchesSessionRef.current = matchesSession
  onStrandedRef.current = onStranded

  useEffect(
    () => () => {
      for (const control of controls.current.values()) control.active = false
      controls.current.clear()
    },
    [],
  )

  useEffect(() => {
    const ids = new Set(
      attempts
        .filter(
          (attempt) =>
            attempt.status === 'opening' &&
            !matchesSessionRef.current(attempt, session),
        )
        .map((attempt) => attempt.id),
    )
    if (ids.size === 0) return

    for (const id of ids) {
      const control = controls.current.get(id)
      if (control) control.active = false
      controls.current.delete(id)
    }
    onStrandedRef.current?.(ids)
    setAttempts((current) =>
      current.map((attempt) =>
        ids.has(attempt.id)
          ? attempt.status === 'opening'
            ? { ...attempt, status: 'ambiguous' }
            : attempt.status === 'pending'
              ? { ...attempt, status: 'unknown' }
              : attempt
          : attempt,
      ),
    )
  }, [
    attempts,
    session.account,
    session.chainId,
    session.provider,
    session.status,
    setAttempts,
  ])

  return {
    begin(id: number) {
      const control: WalletOperationControl = { active: true }
      controls.current.set(id, control)
      return control
    },
    deactivate(id: number) {
      const control = controls.current.get(id)
      if (control) control.active = false
      controls.current.delete(id)
    },
    release(id: number, control: WalletOperationControl) {
      if (controls.current.get(id) === control) controls.current.delete(id)
    },
  }
}
