import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Address } from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import type {
  FollowDirection,
  FollowProjectionReadPage,
} from './follow-projection'
import type { FollowProjectionReader } from './follow-read-model'
import type { FollowProjectionRunSnapshot } from './follow-projection-run'
import type {
  FollowProjectionAnchor,
  FollowStreamSnapshot,
  FollowStreamSynchronizer,
} from './follow-stream'
import {
  setFollow,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'
import type { FollowSet } from './protocol-events'
import { PublicFollowPanel } from './public-follow-panel'
import type { WalletSession } from './wallet-session'

const ACCOUNT_A = '0x000000000000000000000000000000000000a11c' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000b0bb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000c0cc' as Address
const CHECKSUMMED_ACCOUNT_B = getAddress(ACCOUNT_B)
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const ANCHOR = {
  account: ACCOUNT_A,
  chainId: 1n,
  direction: 'following',
  head: 20n,
  safeHead: 8n,
} as FollowProjectionAnchor
const RECEIPT = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  hash: TRANSACTION_HASH,
} satisfies TransactionReceipt

function connectedSession(
  provider: Eip1193Provider,
  account: Address = ACCOUNT_A,
): WalletSession {
  return {
    account,
    chainId: 1n,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function guardedProvider(account: Address = ACCOUNT_A): Eip1193Provider {
  return {
    on: vi.fn(),
    removeListener: vi.fn(),
    request: vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [account]
      throw new Error(`Unexpected provider method: ${method}`)
    }),
  }
}

function follow(followed: Address, follower: Address = ACCOUNT_A): FollowSet {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: 3n,
    followed,
    follower,
    following: true,
    logIndex: 0,
    transactionHash: TRANSACTION_HASH,
    transactionIndex: 0,
  }
}

function stream(
  projectionAnchor?: FollowProjectionAnchor,
  direction: FollowDirection = 'following',
): FollowStreamSnapshot {
  return {
    account: ACCOUNT_A,
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    direction,
    head: 20n,
    indexedThrough: 8n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentSignals: [],
    safeHead: 8n,
    scannedRanges: 1,
    startBlock: 0n,
  }
}

function projection(
  phase: FollowProjectionRunSnapshot['phase'],
): FollowProjectionRunSnapshot {
  return {
    account: ACCOUNT_A,
    chainId: 1n,
    direction: 'following',
    head: 20n,
    logsProcessed: phase === 'complete' ? 3n : 1n,
    relationshipsRetained: phase === 'complete' ? 1n : 0n,
    pagesScanned: 1n,
    phase,
    safeHead: 8n,
    startBlock: 0n,
  }
}

function reader(
  overrides: Partial<FollowProjectionReader> = {},
): FollowProjectionReader {
  return {
    advance: vi.fn(),
    account: ACCOUNT_A,
    close: vi.fn(),
    direction: 'following',
    getRelationship: vi.fn(),
    hasRelationship: vi.fn(),
    readRelationships: vi.fn().mockReturnValue({
      complete: true,
      relationships: [follow(ACCOUNT_B)],
      totalRelationships: 1n,
    } satisfies FollowProjectionReadPage),
    snapshot: projection('follows'),
    startBlock: 0n,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, reject, resolve }
}

function setTarget(value: string) {
  fireEvent.change(screen.getByLabelText('Follow target address'), {
    target: { value },
  })
}

afterEach(cleanup)

describe('PublicFollowPanel', () => {
  it('states the permanent public boundary and stays inert while disconnected', () => {
    const synchronize = vi.fn()
    const setFollowAction = vi.fn<typeof setFollow>()
    render(
      <PublicFollowPanel
        readModelOptions={{ synchronize }}
        session={{ status: 'disconnected' }}
        setFollowAction={setFollowAction}
      />,
    )

    expect(
      screen.getByRole('heading', {
        name: 'Follow the money. And everyone else.',
      }),
    ).toBeTruthy()
    expect(screen.getByText(/permanent public event/i)).toBeTruthy()
    expect(screen.getByText(/bounded EIP-1193 RPC connection/i)).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed follow history',
      }).disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Follow on-chain',
      }).disabled,
    ).toBe(true)
    expect(synchronize).not.toHaveBeenCalled()
    expect(setFollowAction).not.toHaveBeenCalled()
  })

  it('performs one bounded read step per click and hides relationships until complete', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn<FollowStreamSynchronizer>()
      .mockResolvedValueOnce(stream())
      .mockResolvedValueOnce(stream(ANCHOR))
    const run = reader({
      advance: vi
        .fn()
        .mockResolvedValueOnce(projection('authenticate'))
        .mockResolvedValueOnce(projection('complete')),
    })
    const openProjection = vi.fn().mockResolvedValue(run)
    render(
      <PublicFollowPanel
        readProvider={readProvider}
        readModelOptions={{ openProjection, synchronize }}
        session={connectedSession(provider)}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed follow history' }),
    )
    expect(
      await screen.findByText(/more confirmed history remains/i),
    ).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(1)
    expect(synchronize.mock.calls[0]?.[0]).toBe(readProvider)
    expect(run.advance).not.toHaveBeenCalled()
    expect(screen.queryByText(/Following · 1/)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'Load next bounded follow range' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Process next local relationship page',
        }),
      ).toBeTruthy(),
    )
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(openProjection).toHaveBeenCalledWith(ANCHOR)
    expect(run.advance).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Process next local relationship page',
      }),
    )
    expect(
      await screen.findByRole('button', {
        name: 'Authenticate projected relationships',
      }),
    ).toBeTruthy()
    expect(run.advance).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Following · 1/)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Authenticate projected relationships',
      }),
    )
    expect(await screen.findByText(/Following · 1/)).toBeTruthy()
    expect(screen.getByTitle(ACCOUNT_B)).toBeTruthy()
    expect(run.advance).toHaveBeenCalledTimes(2)
    expect(run.readRelationships).toHaveBeenCalledWith({
      after: undefined,
      limit: 25,
    })
  })

  it('aborts and hides follow state when the selected read provider changes', async () => {
    const walletProvider = { request: vi.fn() } as Eip1193Provider
    const firstReadProvider = { request: vi.fn() } as Eip1193Provider
    const secondReadProvider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<FollowStreamSnapshot>()
    const synchronize = vi
      .fn<FollowStreamSynchronizer>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(stream())
    const view = render(
      <PublicFollowPanel
        readProvider={firstReadProvider}
        readModelOptions={{ synchronize }}
        session={connectedSession(walletProvider)}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed follow history' }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]?.[4]?.signal

    view.rerender(
      <PublicFollowPanel
        readProvider={secondReadProvider}
        readModelOptions={{ synchronize }}
        session={connectedSession(walletProvider)}
      />,
    )
    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    expect(
      screen.getByRole('button', { name: 'Load confirmed follow history' }),
    ).toBeTruthy()
    await act(async () => pending.resolve(stream()))
    expect(screen.queryByText(/more confirmed history remains/i)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed follow history' }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    expect(synchronize.mock.calls[1]?.[0]).toBe(secondReadProvider)
  })

  it('explains when the protocol deployment is not confirmed yet', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi.fn().mockResolvedValue({
      ...stream(),
      safeHead: 8n,
      startBlock: 9n,
    })
    render(
      <PublicFollowPanel
        readModelOptions={{ synchronize }}
        session={connectedSession(provider)}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed follow history' }),
    )

    expect(
      await screen.findByText(/wait for deployment confirmations/i),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Check follow confirmations' }),
    ).toBeTruthy()
  })

  it('paginates only through the completed bounded relationship reader', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const firstPage = {
      complete: false,
      nextAfter: ACCOUNT_B,
      relationships: [follow(ACCOUNT_B)],
      totalRelationships: 2n,
    } satisfies FollowProjectionReadPage
    const secondPage = {
      complete: true,
      relationships: [follow(ACCOUNT_C)],
      totalRelationships: 2n,
    } satisfies FollowProjectionReadPage
    const readRelationships = vi.fn(({ after }: { after?: Address }) =>
      after ? secondPage : firstPage,
    )
    const run = reader({
      readRelationships,
      snapshot: projection('complete'),
    })
    render(
      <PublicFollowPanel
        readModelOptions={{
          openProjection: vi.fn().mockResolvedValue(run),
          synchronize: vi.fn().mockResolvedValue(stream(ANCHOR)),
        }}
        session={connectedSession(provider)}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed follow history' }),
    )
    expect(await screen.findByTitle(ACCOUNT_B)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next relationships' }))
    expect(await screen.findByTitle(ACCOUNT_C)).toBeTruthy()
    expect(screen.queryByTitle(ACCOUNT_B)).toBeNull()
    expect(readRelationships).toHaveBeenLastCalledWith({
      after: ACCOUNT_B,
      limit: 25,
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Previous relationships' }),
    )
    expect(await screen.findByTitle(ACCOUNT_B)).toBeTruthy()
  })

  it('validates read and write account scopes before enabling actions', () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    render(<PublicFollowPanel session={connectedSession(provider)} />)
    const readButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Load confirmed follow history',
    })
    const followButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Follow on-chain',
    })

    fireEvent.change(screen.getByLabelText('Public account address'), {
      target: { value: 'not-an-address' },
    })
    expect(screen.getByText(/valid EVM account address/i)).toBeTruthy()
    expect(readButton.disabled).toBe(true)
    setTarget('0x0000000000000000000000000000000000000000')
    expect(
      screen.getByText(/follow target address must be nonzero/i),
    ).toBeTruthy()
    expect(followButton.disabled).toBe(true)
    setTarget(ACCOUNT_A)
    expect(screen.getByText(/cannot follow itself/i)).toBeTruthy()
    expect(followButton.disabled).toBe(true)
    setTarget(ACCOUNT_B)
    expect(followButton.disabled).toBe(false)
  })

  it('submits an exact action, locks both writes, and reports its receipt', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<TransactionReceipt>()
    const setFollowAction = vi.fn<typeof setFollow>(
      (_provider, _account, _chainId, _followed, _following, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        return pending.promise
      },
    )
    render(
      <PublicFollowPanel
        readProvider={readProvider}
        session={connectedSession(provider)}
        setFollowAction={setFollowAction}
      />,
    )
    setTarget(ACCOUNT_B)

    fireEvent.click(screen.getByRole('button', { name: 'Follow on-chain' }))
    expect(await screen.findByTitle(TRANSACTION_HASH)).toBeTruthy()
    expect(
      screen.getByText(/waiting for an authenticated on-chain receipt/i),
    ).toBeTruthy()
    expect(setFollowAction).toHaveBeenCalledWith(
      provider,
      ACCOUNT_A,
      1n,
      CHECKSUMMED_ACCOUNT_B,
      true,
      expect.any(Function),
    )
    expect(readProvider.request).not.toHaveBeenCalled()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Following…' })
        .disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Unfollow on-chain',
      }).disabled,
    ).toBe(true)

    await act(async () => pending.resolve(RECEIPT))
    expect(await screen.findByText(/was confirmed in block 42/i)).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(false)
  })

  it('makes an old-context wallet prompt dismissible and ignores late callbacks', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<TransactionReceipt>()
    let reportSubmitted: TransactionSubmitted | undefined
    const setFollowAction = vi.fn<typeof setFollow>(
      (_provider, _account, _chainId, _followed, _following, onSubmitted) => {
        reportSubmitted = onSubmitted
        return pending.promise
      },
    )
    const { rerender } = render(
      <PublicFollowPanel
        session={connectedSession(provider)}
        setFollowAction={setFollowAction}
      />,
    )
    setTarget(ACCOUNT_B)
    fireEvent.click(screen.getByRole('button', { name: 'Follow on-chain' }))
    expect(await screen.findByText(/waiting for wallet approval/i)).toBeTruthy()

    rerender(
      <PublicFollowPanel
        session={connectedSession(provider, ACCOUNT_C)}
        setFollowAction={setFollowAction}
      />,
    )
    expect(
      await screen.findByText(/may have broadcast the action/i),
    ).toBeTruthy()
    act(() => reportSubmitted?.(TRANSACTION_HASH))
    expect(screen.queryByTitle(TRANSACTION_HASH)).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: /I checked my wallet/i }),
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(false)

    await act(async () => pending.resolve(RECEIPT))
    expect(screen.queryByText(/was confirmed in block 42/i)).toBeNull()
  })

  it('keeps an ambiguous action locked across wallet contexts', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const replacementProvider = { request: vi.fn() } as Eip1193Provider
    const setFollowAction = vi
      .fn<typeof setFollow>()
      .mockRejectedValue(
        new TransactionSubmissionUnknownError(new Error('Transport lost.')),
      )
    const { rerender } = render(
      <PublicFollowPanel
        session={connectedSession(provider)}
        setFollowAction={setFollowAction}
      />,
    )
    setTarget(ACCOUNT_B)
    fireEvent.click(screen.getByRole('button', { name: 'Follow on-chain' }))

    expect(
      await screen.findByText(/may have broadcast the action/i),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(true)
    rerender(
      <PublicFollowPanel
        session={connectedSession(replacementProvider)}
        setFollowAction={setFollowAction}
      />,
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(true)
    rerender(
      <PublicFollowPanel
        session={connectedSession(replacementProvider, ACCOUNT_C)}
        setFollowAction={setFollowAction}
      />,
    )
    expect(screen.getByText(/belongs to another wallet context/i)).toBeTruthy()
    expect(screen.getByText(/keeps every wallet write locked/i)).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(true)

    fireEvent.click(
      screen.getByRole('button', { name: /i checked my wallet/i }),
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(false)
  })

  it('keeps an unknown hash locked but recovers it only with its provider', async () => {
    const provider = guardedProvider()
    const replacementProvider = guardedProvider()
    const setFollowAction = vi.fn<typeof setFollow>(
      async (
        _provider,
        _account,
        _chainId,
        _followed,
        _following,
        onSubmitted,
      ) => {
        onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Receipt transport failed.')
      },
    )
    const waitForReceipt = vi
      .fn<typeof waitForTransactionReceipt>()
      .mockResolvedValue(RECEIPT)
    const { rerender } = render(
      <PublicFollowPanel
        session={connectedSession(provider)}
        setFollowAction={setFollowAction}
        waitForReceipt={waitForReceipt}
      />,
    )
    setTarget(ACCOUNT_B)
    fireEvent.click(screen.getByRole('button', { name: 'Unfollow on-chain' }))

    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()
    rerender(
      <PublicFollowPanel
        session={connectedSession(replacementProvider)}
        setFollowAction={setFollowAction}
        waitForReceipt={waitForReceipt}
      />,
    )
    expect(screen.getByText(/new writes remain locked/i)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Check follow receipt again' }),
    ).toBeNull()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Follow on-chain' })
        .disabled,
    ).toBe(true)
    rerender(
      <PublicFollowPanel
        session={connectedSession(provider)}
        setFollowAction={setFollowAction}
        waitForReceipt={waitForReceipt}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Check follow receipt again' }),
    )
    expect(await screen.findByText(/was confirmed in block 42/i)).toBeTruthy()
    expect(waitForReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      expect.objectContaining({
        assertCurrentChain: expect.any(Function),
        assertUnchanged: expect.any(Function),
        expectedFollow: {
          followed: CHECKSUMMED_ACCOUNT_B,
          follower: ACCOUNT_A,
          following: false,
        },
        selectedChainId: 1n,
      }),
    )
  })
})
