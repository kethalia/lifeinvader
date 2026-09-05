import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hash, Hex } from 'viem'
import type { Eip1193Provider } from './ethereum'
import {
  FilecoinStorageRecoveryPanel,
  type FilecoinStorageRecoveryJournalReader,
} from './filecoin-storage-recovery-panel'
import type { FilecoinStorageRecoveryRecord } from './filecoin-storage-recovery-journal'
import type {
  FilecoinStorageUploadCheckpoint,
  FilecoinStorageUploadReceipt,
} from './filecoin-storage-upload'
import type { FilecoinStorageUploadReceiptChecker } from './filecoin-storage-upload-panel'
import { FILECOIN_CALIBRATION_CHAIN_ID } from './filecoin-storage'
import type { TransactionReceipt } from './protocol'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb'
const SERVICE_PROVIDER = '0x0000000000000000000000000000000000005e11'
const HASH_A = `0x${'12'.repeat(32)}` as Hash
const HASH_B = `0x${'23'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'34'.repeat(32)}` as Hash
const UPLOAD_ID = `0x${'45'.repeat(32)}` as Hex
const PIECE_BYTES = `0x${'01'.repeat(32)}` as Hex
const MEDIA_CID = 'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm'
const provider: Eip1193Provider = {
  request: vi.fn(async () => undefined),
}
const checkpoint: FilecoinStorageUploadCheckpoint = {
  account: ACCOUNT,
  carByteLength: 273,
  chainId: FILECOIN_CALIBRATION_CHAIN_ID,
  ipfsIndexingRequested: true,
  mediaCid: MEDIA_CID,
  piece: {
    bytes: PIECE_BYTES,
    paddedSize: 512n,
    size: 273,
    text: 'baga6ea4seaq-test-piece-cid',
  },
  provider: {
    id: 17n,
    serviceProvider: SERVICE_PROVIDER,
    serviceUrl: 'https://provider.example/pdp/',
  },
  uploadId: UPLOAD_ID,
  withCDN: false,
}
const receipt: TransactionReceipt = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  hash: HASH_B,
}

function recoveryRecord(
  transactionHashes: readonly Hash[] = [],
): FilecoinStorageRecoveryRecord {
  return Object.freeze({
    checkpoint,
    createdAtMs: Date.parse('2026-09-05T00:00:00.000Z'),
    transactionHashes: Object.freeze([...transactionHashes]),
    updatedAtMs: Date.parse('2026-09-05T00:01:00.000Z'),
  })
}

function recoveryJournal(
  records: readonly FilecoinStorageRecoveryRecord[] = [],
): FilecoinStorageRecoveryJournalReader {
  return {
    list: vi.fn(async () => records),
    removeIfUnchanged: vi.fn(async () => true),
  }
}

function connectedSession(
  account: Address = ACCOUNT,
  chainId = FILECOIN_CALIBRATION_CHAIN_ID,
): WalletSession {
  return {
    account,
    chainId,
    name: 'Recovery Wallet',
    provider,
    status: 'connected',
  }
}

function renderRecovery({
  checkReceipt,
  journal = recoveryJournal(),
  onWriteLockChange,
  session = connectedSession(),
}: {
  checkReceipt?: FilecoinStorageUploadReceiptChecker
  journal?: FilecoinStorageRecoveryJournalReader
  onWriteLockChange?(locked: boolean): void
  session?: WalletSession
} = {}) {
  return render(
    <FilecoinStorageRecoveryPanel
      checkReceipt={checkReceipt}
      onWriteLockChange={onWriteLockChange}
      recoveryJournal={journal}
      session={session}
    />,
  )
}

afterEach(cleanup)

describe('FilecoinStorageRecoveryPanel', () => {
  it('locks while loading and disappears after proving the journal is empty', async () => {
    const onWriteLockChange = vi.fn()
    const journal = recoveryJournal()
    renderRecovery({ journal, onWriteLockChange })

    expect(screen.getByText(/checking this browser/i)).toBeTruthy()
    await waitFor(() => expect(journal.list).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
    expect(
      screen.queryByRole('heading', { name: /saved Filecoin/i }),
    ).toBeNull()
    expect(onWriteLockChange).toHaveBeenCalledWith(true)
  })

  it('keeps a no-hash recovery locked until explicit removal succeeds', async () => {
    const journal = recoveryJournal([recoveryRecord()])
    vi.mocked(journal.removeIfUnchanged)
      .mockRejectedValueOnce(new Error('IndexedDB deletion failed.'))
      .mockResolvedValueOnce(true)
    const onWriteLockChange = vi.fn()
    renderRecovery({ journal, onWriteLockChange })

    expect(
      await screen.findByText(/no transaction hash was returned/i),
    ).toBeTruthy()
    expect(screen.getByTitle(UPLOAD_ID)).toBeTruthy()
    expect(screen.getByTitle(MEDIA_CID)).toBeTruthy()
    expect(screen.getByText(/2026-09-05T00:01:00.000Z/i)).toBeTruthy()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(
      screen.getByRole('button', {
        name: /checked wallet and provider activity.*discard/i,
      }),
    )
    expect(await screen.findByText(/IndexedDB deletion failed/i)).toBeTruthy()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(
      screen.getByRole('button', {
        name: /checked wallet and provider activity.*discard/i,
      }),
    )
    await waitFor(() =>
      expect(journal.removeIfUnchanged).toHaveBeenCalledTimes(2),
    )
    expect(
      await screen.findByText(/browser-only recovery entry was discarded/i),
    ).toBeTruthy()
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('does not discard a record that gained a replacement hash in another tab', async () => {
    const stale = recoveryRecord([HASH_A])
    const latest = recoveryRecord([HASH_A, HASH_B])
    const journal = recoveryJournal([stale])
    vi.mocked(journal.list)
      .mockResolvedValueOnce([stale])
      .mockResolvedValueOnce([latest])
    vi.mocked(journal.removeIfUnchanged).mockResolvedValueOnce(false)
    const onWriteLockChange = vi.fn()
    renderRecovery({ journal, onWriteLockChange })

    fireEvent.click(
      await screen.findByRole('button', {
        name: /checked the newest hash.*discard/i,
      }),
    )

    expect(
      await screen.findByText(/changed in another tab and was not cleared/i),
    ).toBeTruthy()
    expect(screen.getByTitle(HASH_B)).toBeTruthy()
    expect(journal.removeIfUnchanged).toHaveBeenCalledWith(stale)
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)
  })

  it('checks only the newest provider hash in the original wallet context', async () => {
    const record = recoveryRecord([HASH_A, HASH_B])
    const journal = recoveryJournal([record])
    const recovered: FilecoinStorageUploadReceipt = {
      dataSetId: 29n,
      kind: 'piece-added',
      pieceId: 41n,
      receipt,
    }
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>(
      async () => recovered,
    )
    const onWriteLockChange = vi.fn()
    const view = renderRecovery({
      checkReceipt,
      journal,
      onWriteLockChange,
      session: connectedSession(OTHER_ACCOUNT),
    })

    const reconnect = await screen.findByRole('button', {
      name: /reconnect original account and chain/i,
    })
    expect((reconnect as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/checks the newest replacement/i)).toBeTruthy()

    view.rerender(
      <FilecoinStorageRecoveryPanel
        checkReceipt={checkReceipt}
        onWriteLockChange={onWriteLockChange}
        recoveryJournal={journal}
        session={connectedSession()}
      />,
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /check newest storage receipt/i,
      }),
    )

    expect(
      await screen.findByText(
        /recovered storage confirmation.*data set 29.*piece 41/i,
      ),
    ).toBeTruthy()
    expect(checkReceipt).toHaveBeenCalledWith(provider, HASH_B, checkpoint, {
      expectedAccount: ACCOUNT,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      pollIntervalMs: 3_000,
      receiptTimeoutMs: 15_000,
      signal: expect.any(AbortSignal),
    })
    expect(journal.removeIfUnchanged).toHaveBeenCalledWith(record)
    expect(checkReceipt).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('retries browser cleanup without rechecking an authenticated receipt', async () => {
    const record = recoveryRecord([HASH_A])
    const journal = recoveryJournal([record])
    vi.mocked(journal.removeIfUnchanged)
      .mockRejectedValueOnce(new Error('Cleanup was blocked.'))
      .mockResolvedValueOnce(true)
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>(
      async () => ({
        dataSetId: 29n,
        kind: 'data-set-created',
        receipt: { ...receipt, hash: HASH_A },
      }),
    )
    const onWriteLockChange = vi.fn()
    renderRecovery({ checkReceipt, journal, onWriteLockChange })
    fireEvent.click(
      await screen.findByRole('button', {
        name: /check newest storage receipt/i,
      }),
    )

    expect(
      await screen.findByText(
        /created charged data set 29.*not storage completion/i,
      ),
    ).toBeTruthy()
    expect(await screen.findByText(/Cleanup was blocked/i)).toBeTruthy()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)
    expect(
      screen.queryByRole('button', { name: /dismiss recovered result/i }),
    ).toBeNull()
    fireEvent.click(
      screen.getByRole('button', {
        name: /retry clearing authenticated recovery/i,
      }),
    )

    await waitFor(() =>
      expect(journal.removeIfUnchanged).toHaveBeenCalledTimes(2),
    )
    expect(checkReceipt).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
    expect(
      screen.getByRole('button', { name: /dismiss recovered result/i }),
    ).toBeTruthy()
  })

  it('revalidates the wallet session immediately after the receipt check', async () => {
    const record = recoveryRecord([HASH_A])
    const journal = recoveryJournal([record])
    const session = connectedSession()
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>(
      async () => {
        Object.assign(session, { account: OTHER_ACCOUNT })
        return {
          dataSetId: 29n,
          kind: 'piece-added',
          pieceId: 41n,
          receipt: { ...receipt, hash: HASH_A },
        }
      },
    )
    const onWriteLockChange = vi.fn()
    renderRecovery({ checkReceipt, journal, onWriteLockChange, session })

    fireEvent.click(
      await screen.findByRole('button', {
        name: /check newest storage receipt/i,
      }),
    )

    expect(
      await screen.findByRole('button', {
        name: /reconnect original account and chain/i,
      }),
    ).toBeTruthy()
    expect(journal.removeIfUnchanged).not.toHaveBeenCalled()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)
  })

  it('aborts a receipt check when the connected wallet context changes', async () => {
    const journal = recoveryJournal([recoveryRecord([HASH_A])])
    let signal: AbortSignal | undefined
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>(
      async (_provider, _hash, _checkpoint, options) => {
        signal = options.signal
        return await new Promise<FilecoinStorageUploadReceipt>(
          (_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            )
          },
        )
      },
    )
    const onWriteLockChange = vi.fn()
    const view = renderRecovery({ checkReceipt, journal, onWriteLockChange })
    fireEvent.click(
      await screen.findByRole('button', {
        name: /check newest storage receipt/i,
      }),
    )
    await waitFor(() => expect(signal).toBeDefined())

    view.rerender(
      <FilecoinStorageRecoveryPanel
        checkReceipt={checkReceipt}
        onWriteLockChange={onWriteLockChange}
        recoveryJournal={journal}
        session={connectedSession(OTHER_ACCOUNT)}
      />,
    )

    await waitFor(() => expect(signal?.aborted).toBe(true))
    expect(
      await screen.findByText(/transaction could not be authenticated/i),
    ).toBeTruthy()
    expect(journal.removeIfUnchanged).not.toHaveBeenCalled()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)
  })

  it('fails closed on a journal read error and permits a bounded retry', async () => {
    const journal = recoveryJournal()
    vi.mocked(journal.list)
      .mockRejectedValueOnce(new Error('IndexedDB open failed.'))
      .mockResolvedValueOnce([])
    const onWriteLockChange = vi.fn()
    renderRecovery({ journal, onWriteLockChange })

    expect(await screen.findByText(/IndexedDB open failed/i)).toBeTruthy()
    expect(screen.getByText(/wallet writes remain locked/i)).toBeTruthy()
    expect(onWriteLockChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(
      screen.getByRole('button', { name: /retry reading recoveries/i }),
    )

    await waitFor(() => expect(journal.list).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('reports the lock released when unmounted', async () => {
    const onWriteLockChange = vi.fn()
    const view = renderRecovery({
      journal: recoveryJournal([recoveryRecord()]),
      onWriteLockChange,
    })
    await screen.findByText(/no transaction hash was returned/i)

    view.unmount()

    expect(onWriteLockChange).toHaveBeenLastCalledWith(false)
  })
})
