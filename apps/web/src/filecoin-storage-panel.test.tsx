import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import type { Hash } from 'viem'
import type { Eip1193Provider } from './ethereum'
import {
  FilecoinStoragePanel,
  type FilecoinStorageFunder,
  type FilecoinStorageFundingReceiptChecker,
  type FilecoinStorageInspector,
  type FilecoinStorageQuoter,
} from './filecoin-storage-panel'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_MAINNET_CHAIN_ID,
  FILECOIN_STORAGE_NETWORKS,
} from './filecoin-storage'
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import { parseMediaCid } from './media-cid'
import type { PreparedMediaCar } from './paid-media-car'
import {
  TransactionSubmissionUnknownError,
  type TransactionReceipt,
} from './protocol'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const MEDIA_CID = parseMediaCid(
  'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm',
)!
const CALIBRATION = FILECOIN_STORAGE_NETWORKS[1]
const STREAMING_LOCKUP = 120_000n * 86_400n
const TRANSACTION_HASH = `0x${'12'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'34'.repeat(32)}` as Hash
const receipt: TransactionReceipt = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  hash: TRANSACTION_HASH,
}
const provider: Eip1193Provider = {
  request: vi.fn(async () => undefined),
}

const prepared: PreparedMediaCar = {
  carBytes: new Uint8Array(273),
  file: { name: 'shareholder-proof.gif', size: 176, type: 'image/gif' },
  mediaCid: MEDIA_CID,
  rootCid: CID.parse(MEDIA_CID.text),
}

const quote: FilecoinStorageQuote = {
  account: ACCOUNT,
  chainId: FILECOIN_CALIBRATION_CHAIN_ID,
  copies: 1 as const,
  dataSize: 273n,
  depositNeeded: 13_000_000_000_000_000n,
  fees: {
    addPiecesFee: 2_000_000_000_000_000n,
    createDataSetFee: 3_000_000_000_000_000n,
    total: 5_000_000_000_000_000n,
  },
  lockups: {
    cacheMissLockup: 0n,
    cdnLockup: 0n,
    lifecycleLockup: 8_000_000_000_000_000n - STREAMING_LOCKUP,
    rateDeltaPerEpoch: 120_000n,
    reserveReplenishment: 0n,
    streamingLockup: STREAMING_LOCKUP,
    total: 8_000_000_000_000_000n,
  },
  needsServiceApproval: true,
  rates: {
    perEpoch: 120_000n,
    perMonth: 345_600_000_000n,
  },
  ready: false,
  tokenDecimals: 18 as const,
  tokenSymbol: 'USDFC' as const,
  withCDN: false as const,
}

function connectedSession(
  chainId: bigint = FILECOIN_CALIBRATION_CHAIN_ID,
): WalletSession {
  return {
    account: ACCOUNT,
    chainId,
    name: 'Media Wallet',
    provider,
    status: 'connected',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function renderFundingQuote({
  checkFundingReceipt,
  fundStorage,
  onWriteLockChange,
  quoteStorage,
  session = connectedSession(),
}: {
  checkFundingReceipt?: FilecoinStorageFundingReceiptChecker
  fundStorage?: FilecoinStorageFunder
  onWriteLockChange?(locked: boolean): void
  quoteStorage: FilecoinStorageQuoter
  session?: WalletSession
}) {
  const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
    kind: 'ready',
    network: CALIBRATION,
  }))
  const view = render(
    <FilecoinStoragePanel
      checkFundingReceipt={checkFundingReceipt}
      fundStorage={fundStorage}
      inspectStorage={inspectStorage}
      onWriteLockChange={onWriteLockChange}
      prepared={prepared}
      quoteStorage={quoteStorage}
      session={session}
    />,
  )
  fireEvent.click(
    screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
  )
  fireEvent.click(
    await screen.findByRole('button', { name: /quote one Filecoin copy/i }),
  )
  await screen.findByRole('heading', { name: /fund the public wallet/i })
  return view
}

afterEach(cleanup)

describe('FilecoinStoragePanel', () => {
  it('renders only for a prepared CAR and requires a connected wallet', () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>()
    const { rerender } = render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        session={{ status: 'disconnected' }}
      />,
    )
    expect(
      screen.queryByRole('heading', { name: /Filecoin storage rail/i }),
    ).toBeNull()

    rerender(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        session={{ status: 'disconnected' }}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /Filecoin storage rail/i }),
    ).toBeTruthy()
    expect(screen.getByText(/reconnect the wallet/i)).toBeTruthy()
    expect(screen.getByText(MEDIA_CID.text)).toBeTruthy()
    expect(inspectStorage).not.toHaveBeenCalled()
  })

  it('explains the manual cross-chain handoff without making RPC calls', () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>()
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        publicationChainId={1n}
        session={connectedSession(31_337n)}
      />,
    )

    expect(screen.getByText(/chain 31337 is not a supported/i)).toBeTruthy()
    expect(screen.getByText(/chain 314159/i)).toBeTruthy()
    expect(
      screen.getByText(/will not switch networks automatically/i),
    ).toBeTruthy()
    expect(screen.getByText(/return.*publication chain 1/i)).toBeTruthy()
    expect(inspectStorage).not.toHaveBeenCalled()
  })

  it('checks a supported deployment only after an explicit click', async () => {
    const pending = deferred<Awaited<ReturnType<FilecoinStorageInspector>>>()
    const inspectStorage = vi.fn<FilecoinStorageInspector>(
      async () => pending.promise,
    )
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        publicationChainId={1n}
        session={connectedSession()}
      />,
    )

    expect(screen.getByText(/never poll the RPC endpoint/i)).toBeTruthy()
    expect(inspectStorage).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    expect(screen.getByText(/inspecting the deployed/i)).toBeTruthy()
    expect(inspectStorage).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
        signal: expect.any(AbortSignal),
      }),
    )

    await act(async () =>
      pending.resolve({ kind: 'ready', network: CALIBRATION }),
    )
    expect(
      screen.getByText(/passed the pinned storage-contract checks/i),
    ).toBeTruthy()
    expect(
      screen.getByText(/preflight and quote do not upload bytes/i),
    ).toBeTruthy()
    expect(screen.getByTitle(CALIBRATION.contracts.fwss)).toBeTruthy()
  })

  it('quotes current one-copy costs only after a ready preflight and click', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      kind: 'ready',
      network: CALIBRATION,
    }))
    const pending = deferred<Awaited<ReturnType<FilecoinStorageQuoter>>>()
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(
      async () => pending.promise,
    )
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )

    expect(quoteStorage).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: /quote one Filecoin copy/i }),
    ).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    await screen.findByRole('button', { name: /quote one Filecoin copy/i })
    expect(quoteStorage).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: /quote one Filecoin copy/i }),
    )
    expect(
      screen.getByText(/reading current Filecoin Pay balances/i),
    ).toBeTruthy()
    expect(quoteStorage).toHaveBeenCalledWith(provider, 273, {
      expectedAccount: ACCOUNT,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      signal: expect.any(AbortSignal),
    })

    await act(async () => pending.resolve(quote))
    expect(screen.getByText('0.0000003456 USDFC')).toBeTruthy()
    expect(screen.getByText('0.005 USDFC')).toBeTruthy()
    expect(screen.getByText('0.008 USDFC')).toBeTruthy()
    expect(screen.getByText('0.013 USDFC')).toBeTruthy()
    expect(screen.getByText(/maximum FWSS service approval/i)).toBeTruthy()
    expect(screen.getByText(/do not add them again.*deposit/i)).toBeTruthy()
    expect(screen.getByText(/no transaction or provider upload/i)).toBeTruthy()
  })

  it('explains when existing Filecoin Pay funds satisfy the quote', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      kind: 'ready',
      network: CALIBRATION,
    }))
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(async () => ({
      ...quote,
      depositNeeded: 0n,
      needsServiceApproval: false,
      ready: true,
    }))
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /quote one Filecoin copy/i,
      }),
    )

    expect(
      await screen.findByText(/existing Filecoin Pay funds.*satisfy/i),
    ).toBeTruthy()
    expect(screen.getByText('0 USDFC')).toBeTruthy()
  })

  it('surfaces graph failures without implying that payment was attempted', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      issues: [
        {
          address: CALIBRATION.contracts.usdfc,
          contract: 'usdfc',
          kind: 'missing-code',
        },
      ],
      kind: 'unavailable',
      network: CALIBRATION,
    }))
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/USDFC token.*no contract code/i)
    expect(alert.textContent).toMatch(/no upload or payment was attempted/i)
  })

  it('aborts an obsolete inspection when the wallet context changes', async () => {
    let inspectionSignal: AbortSignal | undefined
    const inspectStorage = vi.fn<FilecoinStorageInspector>(
      (_provider, options) => {
        inspectionSignal = options?.signal
        return new Promise(() => undefined)
      },
    )
    const { rerender } = render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    await waitFor(() => expect(inspectStorage).toHaveBeenCalledTimes(1))

    rerender(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        session={connectedSession(FILECOIN_MAINNET_CHAIN_ID)}
      />,
    )
    await waitFor(() => expect(inspectionSignal?.aborted).toBe(true))
    expect(screen.queryByText(/inspecting the deployed/i)).toBeNull()
    expect(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    ).toBeTruthy()
  })

  it('aborts and hides an obsolete quote when the wallet account changes', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      kind: 'ready',
      network: CALIBRATION,
    }))
    let quoteSignal: AbortSignal | undefined
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(
      (_provider, _size, options) => {
        quoteSignal = options.signal
        return new Promise(() => undefined)
      },
    )
    const { rerender } = render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /quote one Filecoin copy/i,
      }),
    )
    await waitFor(() => expect(quoteStorage).toHaveBeenCalledTimes(1))

    rerender(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{
          ...connectedSession(),
          account: '0x000000000000000000000000000000000000b0bb',
        }}
      />,
    )
    await waitFor(() => expect(quoteSignal?.aborted).toBe(true))
    expect(
      screen.queryByText(/reading current Filecoin Pay balances/i),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    ).toBeTruthy()
  })

  it('clears wallet work across a disconnect with retained context', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      kind: 'ready',
      network: CALIBRATION,
    }))
    let quoteSignal: AbortSignal | undefined
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(
      (_provider, _size, options) => {
        quoteSignal = options.signal
        return new Promise(() => undefined)
      },
    )
    const { rerender } = render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /quote one Filecoin copy/i,
      }),
    )

    rerender(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{ ...connectedSession(), status: 'disconnected' }}
      />,
    )
    await waitFor(() => expect(quoteSignal?.aborted).toBe(true))
    expect(screen.getByText(/reconnect the wallet/i)).toBeTruthy()

    rerender(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    expect(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: /quote one Filecoin copy/i }),
    ).toBeNull()
  })

  it('clears an old quote before a fresh contract inspection', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      kind: 'ready',
      network: CALIBRATION,
    }))
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(async () => quote)
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /quote one Filecoin copy/i,
      }),
    )
    expect(await screen.findByText('0.013 USDFC')).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: /check Filecoin contracts again/i }),
    )
    expect(screen.queryByText('0.013 USDFC')).toBeNull()
  })

  it('discloses, requotes, submits once, and refreshes after confirmation', async () => {
    const readyQuote = {
      ...quote,
      depositNeeded: 0n,
      needsServiceApproval: false,
      ready: true,
    }
    const quoteStorage = vi.fn<FilecoinStorageQuoter>()
    quoteStorage
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(readyQuote)
    const pendingReceipt = deferred<TransactionReceipt>()
    const fundStorage = vi.fn<FilecoinStorageFunder>(
      async (_provider, _quote, options) => {
        options.onSubmitted?.(TRANSACTION_HASH)
        return await pendingReceipt.promise
      },
    )
    const onWriteLockChange = vi.fn()
    const view = await renderFundingQuote({
      fundStorage,
      onWriteLockChange,
      quoteStorage,
    })

    expect(screen.getByText(/account-level credit/i)).toBeTruthy()
    expect(screen.getByText(/maximum uint256 rate and lockup/i)).toBeTruthy()
    expect(screen.getByText(/86400 epochs/i)).toBeTruthy()
    expect(screen.getByText(/does not upload bytes/i)).toBeTruthy()
    const fundButton = screen.getByRole('button', {
      name: /refresh quote and fund Filecoin Pay/i,
    }) as HTMLButtonElement
    expect(fundButton.disabled).toBe(true)
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(fundButton)
    fireEvent.click(fundButton)

    await screen.findByTitle(TRANSACTION_HASH)
    expect(quoteStorage).toHaveBeenCalledTimes(2)
    expect(fundStorage).toHaveBeenCalledTimes(1)
    expect(fundStorage).toHaveBeenCalledWith(
      provider,
      quote,
      expect.objectContaining({
        expectedAccount: ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
        onSubmitted: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(onWriteLockChange).toHaveBeenCalledWith(true)

    await act(async () => pendingReceipt.resolve(receipt))
    expect(
      await screen.findByText(/account funding confirmed in block 42/i),
    ).toBeTruthy()
    await waitFor(() => expect(quoteStorage).toHaveBeenCalledTimes(3))
    expect(
      await screen.findByText(/existing Filecoin Pay funds.*satisfy/i),
    ).toBeTruthy()
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )

    view.rerender(
      <FilecoinStoragePanel
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{
          ...connectedSession(),
          account: '0x000000000000000000000000000000000000b0bb',
        }}
      />,
    )
    await waitFor(() =>
      expect(
        screen.queryByText(/account funding confirmed in block 42/i),
      ).toBeNull(),
    )
  })

  it('stops before the wallet when the refreshed quote changes', async () => {
    const changedQuote = {
      ...quote,
      depositNeeded: quote.depositNeeded + 1n,
    }
    const quoteStorage = vi.fn<FilecoinStorageQuoter>()
    quoteStorage
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(changedQuote)
    const fundStorage = vi.fn<FilecoinStorageFunder>()
    await renderFundingQuote({ fundStorage, quoteStorage })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: /refresh quote and fund Filecoin Pay/i,
      }),
    )

    expect(await screen.findByText(/live quote changed/i)).toBeTruthy()
    expect(fundStorage).not.toHaveBeenCalled()
    expect(screen.getByText('0.013000000000000001 USDFC')).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: /refresh quote and fund Filecoin Pay/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })

  it('distinguishes rejection from an ambiguous no-hash submission', async () => {
    const rejectedQuote = vi.fn<FilecoinStorageQuoter>(async () => quote)
    const rejectedFund = vi.fn<FilecoinStorageFunder>(async () => {
      throw Object.assign(new Error('User rejected.'), { code: 4001 })
    })
    await renderFundingQuote({
      fundStorage: rejectedFund,
      quoteStorage: rejectedQuote,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /refresh quote and fund/i }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /wallet request was rejected/i,
    )

    cleanup()
    const ambiguousQuote = vi.fn<FilecoinStorageQuoter>(async () => quote)
    const ambiguousFund = vi.fn<FilecoinStorageFunder>(async () => {
      throw new TransactionSubmissionUnknownError(new Error('No hash.'))
    })
    const onWriteLockChange = vi.fn()
    await renderFundingQuote({
      fundStorage: ambiguousFund,
      onWriteLockChange,
      quoteStorage: ambiguousQuote,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /refresh quote and fund/i }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /may have broadcast/i,
    )
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(true),
    )
    fireEvent.click(screen.getByRole('button', { name: /clear funding lock/i }))
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('makes an open wallet request dismissibly ambiguous after a context change', async () => {
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(async () => quote)
    const pendingFunding = deferred<TransactionReceipt>()
    let fundingSignal: AbortSignal | undefined
    const fundStorage = vi.fn<FilecoinStorageFunder>(
      async (_provider, _quote, options) => {
        fundingSignal = options.signal
        return await pendingFunding.promise
      },
    )
    const onWriteLockChange = vi.fn()
    const view = await renderFundingQuote({
      fundStorage,
      onWriteLockChange,
      quoteStorage,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /refresh quote and fund/i }),
    )
    await screen.findByText(/confirm the permit.*Filecoin Pay transaction/i)

    view.rerender(
      <FilecoinStoragePanel
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{
          ...connectedSession(),
          account: '0x000000000000000000000000000000000000b0bb',
        }}
      />,
    )

    await waitFor(() => expect(fundingSignal?.aborted).toBe(true))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/request was open/i)
    expect(alert.textContent).toMatch(/close or reject.*still-open prompt/i)
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(true),
    )

    fireEvent.click(screen.getByRole('button', { name: /clear funding lock/i }))
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )

    await act(async () => pendingFunding.resolve(receipt))
    expect(
      screen.queryByText(/account funding confirmed in block 42/i),
    ).toBeNull()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(false)
  })

  it('invalidates receipt completion across a context change and recovers with a fresh quote signal', async () => {
    const readyQuote = {
      ...quote,
      depositNeeded: 0n,
      needsServiceApproval: false,
      ready: true,
    }
    const quoteStorage = vi.fn<FilecoinStorageQuoter>()
    quoteStorage
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(readyQuote)
    const pendingFunding = deferred<TransactionReceipt>()
    const fundStorage = vi.fn<FilecoinStorageFunder>(
      async (_provider, _quote, options) => {
        options.onSubmitted?.(TRANSACTION_HASH)
        return await pendingFunding.promise
      },
    )
    const checkFundingReceipt = vi.fn<FilecoinStorageFundingReceiptChecker>(
      async () => receipt,
    )
    const onWriteLockChange = vi.fn()
    const view = await renderFundingQuote({
      checkFundingReceipt,
      fundStorage,
      onWriteLockChange,
      quoteStorage,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /refresh quote and fund/i }),
    )
    await screen.findByTitle(TRANSACTION_HASH)

    view.rerender(
      <FilecoinStoragePanel
        checkFundingReceipt={checkFundingReceipt}
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{
          ...connectedSession(),
          account: '0x000000000000000000000000000000000000b0bb',
        }}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /context or prepared CAR changed before.*receipt/i,
    )

    view.rerender(
      <FilecoinStoragePanel
        checkFundingReceipt={checkFundingReceipt}
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    await act(async () => pendingFunding.resolve(receipt))
    expect(
      screen.queryByText(/account funding confirmed in block 42/i),
    ).toBeNull()
    expect(
      screen.queryByText(/reading current Filecoin Pay balances/i),
    ).toBeNull()
    expect(quoteStorage).toHaveBeenCalledTimes(2)

    fireEvent.click(
      screen.getByRole('button', { name: /check funding receipt again/i }),
    )
    expect(
      await screen.findByText(/account funding confirmed in block 42/i),
    ).toBeTruthy()
    await waitFor(() => expect(quoteStorage).toHaveBeenCalledTimes(3))
    expect(checkFundingReceipt).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('lets a reviewed unknown funding hash release the global write lock', async () => {
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(async () => quote)
    const fundStorage = vi.fn<FilecoinStorageFunder>(
      async (_provider, _quote, options) => {
        options.onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Receipt unavailable.')
      },
    )
    const onWriteLockChange = vi.fn()
    const view = await renderFundingQuote({
      fundStorage,
      onWriteLockChange,
      quoteStorage,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /refresh quote and fund/i }),
    )
    await screen.findByTitle(TRANSACTION_HASH)

    view.rerender(
      <FilecoinStoragePanel
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{
          ...connectedSession(),
          account: '0x000000000000000000000000000000000000b0bb',
        }}
      />,
    )
    const retryButton = await screen.findByRole('button', {
      name: /reconnect original wallet/i,
    })
    expect((retryButton as HTMLButtonElement).disabled).toBe(true)
    const clearButton = screen.getByRole('button', {
      name: /I checked this funding hash; clear lock/i,
    }) as HTMLButtonElement
    expect(clearButton.disabled).toBe(false)
    fireEvent.click(clearButton)

    await waitFor(() =>
      expect(screen.queryByTitle(TRANSACTION_HASH)).toBeNull(),
    )
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('retains a submitted hash across context changes and recovers its receipt', async () => {
    const readyQuote = {
      ...quote,
      depositNeeded: 0n,
      needsServiceApproval: false,
      ready: true,
    }
    const quoteStorage = vi.fn<FilecoinStorageQuoter>()
    quoteStorage
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(quote)
      .mockResolvedValueOnce(readyQuote)
    const fundStorage = vi.fn<FilecoinStorageFunder>(
      async (_provider, _quote, options) => {
        options.onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Receipt unavailable.')
      },
    )
    const checkFundingReceipt = vi.fn<FilecoinStorageFundingReceiptChecker>(
      async () => receipt,
    )
    const view = await renderFundingQuote({
      checkFundingReceipt,
      fundStorage,
      quoteStorage,
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: /I understand the account-level/i }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: /refresh quote and fund/i }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /unknown final status/i,
    )

    view.rerender(
      <FilecoinStoragePanel
        checkFundingReceipt={checkFundingReceipt}
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={{
          ...connectedSession(),
          account: '0x000000000000000000000000000000000000b0bb',
        }}
      />,
    )
    expect(screen.getByTitle(TRANSACTION_HASH)).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: /reconnect original wallet/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)

    view.rerender(
      <FilecoinStoragePanel
        checkFundingReceipt={checkFundingReceipt}
        fundStorage={fundStorage}
        inspectStorage={vi.fn()}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /check funding receipt again/i }),
    )
    expect(
      await screen.findByText(/account funding confirmed in block 42/i),
    ).toBeTruthy()
    expect(checkFundingReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      quote,
      {
        expectedAccount: ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      },
    )
    await waitFor(() => expect(quoteStorage).toHaveBeenCalledTimes(3))
  })

  it('turns wallet failures into bounded user-facing errors', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => {
      throw new Error(`RPC secret\n${'x'.repeat(500)}`)
    })
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.length).toBeLessThanOrEqual(240)
    expect(alert.textContent).toMatch(/^RPC secret x+/)
  })

  it('turns quote failures into bounded user-facing errors', async () => {
    const inspectStorage = vi.fn<FilecoinStorageInspector>(async () => ({
      kind: 'ready',
      network: CALIBRATION,
    }))
    const quoteStorage = vi.fn<FilecoinStorageQuoter>(async () => {
      throw new Error(`Quote secret\n${'y'.repeat(500)}`)
    })
    render(
      <FilecoinStoragePanel
        inspectStorage={inspectStorage}
        prepared={prepared}
        quoteStorage={quoteStorage}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /^check Filecoin contracts$/i }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /quote one Filecoin copy/i,
      }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.length).toBeLessThanOrEqual(240)
    expect(alert.textContent).toMatch(/^Quote secret y+/)
  })
})
