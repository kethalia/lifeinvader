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
import type { Eip1193Provider } from './ethereum'
import {
  FilecoinStoragePanel,
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
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const MEDIA_CID = parseMediaCid(
  'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm',
)!
const CALIBRATION = FILECOIN_STORAGE_NETWORKS[1]
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
    lifecycleLockup: 8_000_000_000_000_000n,
    rateDeltaPerEpoch: 120_000n,
    reserveReplenishment: 0n,
    streamingLockup: 0n,
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
