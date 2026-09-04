import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WalletWriteBoundary,
  useWalletWriteBoundary,
  type WalletWriteScope,
} from './wallet-write-boundary'

function Scope({ local, scope }: { local: boolean; scope: WalletWriteScope }) {
  const lockedByAnother = useWalletWriteBoundary(scope, local)
  return <output data-testid={scope}>{String(lockedByAnother)}</output>
}

afterEach(cleanup)

describe('WalletWriteBoundary', () => {
  it('locks every other console without feeding a lock back to its owner', () => {
    const { rerender } = render(
      <WalletWriteBoundary>
        <Scope local scope="wallet" />
        <Scope local={false} scope="messages" />
        <Scope local={false} scope="feed" />
      </WalletWriteBoundary>,
    )

    expect(screen.getByTestId('wallet').textContent).toBe('false')
    expect(screen.getByTestId('messages').textContent).toBe('true')
    expect(screen.getByTestId('feed').textContent).toBe('true')

    rerender(
      <WalletWriteBoundary>
        <Scope local={false} scope="wallet" />
        <Scope local={false} scope="messages" />
        <Scope local={false} scope="feed" />
      </WalletWriteBoundary>,
    )

    expect(screen.getByTestId('wallet').textContent).toBe('false')
    expect(screen.getByTestId('messages').textContent).toBe('false')
    expect(screen.getByTestId('feed').textContent).toBe('false')
  })

  it('does not latch when two scopes are locally unresolved', () => {
    const { rerender } = render(
      <WalletWriteBoundary>
        <Scope local scope="group-actions" />
        <Scope local scope="group-messages" />
      </WalletWriteBoundary>,
    )

    expect(screen.getByTestId('group-actions').textContent).toBe('true')
    expect(screen.getByTestId('group-messages').textContent).toBe('true')

    rerender(
      <WalletWriteBoundary>
        <Scope local={false} scope="group-actions" />
        <Scope local={false} scope="group-messages" />
      </WalletWriteBoundary>,
    )

    expect(screen.getByTestId('group-actions').textContent).toBe('false')
    expect(screen.getByTestId('group-messages').textContent).toBe('false')
  })
})
