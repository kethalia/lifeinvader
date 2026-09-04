import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const WRITE_SCOPES = [
  'wallet',
  'messages',
  'follows',
  'group-actions',
  'group-messages',
  'feed',
] as const

export type WalletWriteScope = (typeof WRITE_SCOPES)[number]

type WalletWriteLocks = Readonly<Record<WalletWriteScope, boolean>>

type WalletWriteBoundaryValue = {
  locks: WalletWriteLocks
  report(scope: WalletWriteScope, locked: boolean): void
}

const INITIAL_LOCKS: WalletWriteLocks = {
  feed: false,
  follows: false,
  'group-actions': false,
  'group-messages': false,
  messages: false,
  wallet: false,
}

const WalletWriteBoundaryContext =
  createContext<WalletWriteBoundaryValue | null>(null)

/**
 * Coordinate transaction-producing consoles without centralizing their local
 * recovery state. Each mounted scope reports its own unresolved writes across
 * every retained wallet context; consumers receive a lock only when another
 * scope is unresolved.
 */
export function WalletWriteBoundary({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const [locks, setLocks] = useState(INITIAL_LOCKS)
  const report = useCallback((scope: WalletWriteScope, locked: boolean) => {
    setLocks((current) =>
      current[scope] === locked ? current : { ...current, [scope]: locked },
    )
  }, [])
  const value = useMemo(() => ({ locks, report }), [locks, report])

  return (
    <WalletWriteBoundaryContext.Provider value={value}>
      <div className={className}>{children}</div>
    </WalletWriteBoundaryContext.Provider>
  )
}

/**
 * Report one console's context-independent unresolved state and return whether
 * another console currently owns the shared wallet-write boundary.
 */
export function useWalletWriteBoundary(
  scope: WalletWriteScope,
  locallyLocked: boolean,
) {
  const boundary = useContext(WalletWriteBoundaryContext)
  const report = boundary?.report

  useEffect(() => {
    if (!report) return
    report(scope, locallyLocked)
    return () => report(scope, false)
  }, [locallyLocked, report, scope])

  return boundary
    ? WRITE_SCOPES.some(
        (candidate) => candidate !== scope && boundary.locks[candidate],
      )
    : false
}
