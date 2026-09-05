import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { CID } from 'multiformats/cid'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hash, Hex } from 'viem'
import type { Eip1193Provider } from './ethereum'
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import {
  FilecoinStorageUploadPanel,
  type FilecoinStorageUploader,
  type FilecoinStorageUploadReceiptChecker,
} from './filecoin-storage-upload-panel'
import type {
  FilecoinStorageUploadCheckpoint,
  FilecoinStorageUploadResult,
} from './filecoin-storage-upload'
import { FILECOIN_CALIBRATION_CHAIN_ID } from './filecoin-storage'
import { parseMediaCid } from './media-cid'
import type { PreparedMediaCar } from './paid-media-car'
import type { TransactionReceipt } from './protocol'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb'
const SERVICE_PROVIDER = '0x0000000000000000000000000000000000005e11'
const TRANSACTION_HASH = `0x${'12'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'34'.repeat(32)}` as Hash
const UPLOAD_ID = `0x${'45'.repeat(32)}` as Hex
const PIECE_BYTES = `0x${'01'.repeat(32)}` as Hex
const MEDIA_CID = parseMediaCid(
  'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm',
)!
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
  copies: 1,
  dataSize: 273n,
  depositNeeded: 0n,
  fees: { addPiecesFee: 2n, createDataSetFee: 3n, total: 5n },
  lockups: {
    cacheMissLockup: 0n,
    cdnLockup: 0n,
    lifecycleLockup: 7n,
    rateDeltaPerEpoch: 1n,
    reserveReplenishment: 0n,
    streamingLockup: 11n,
    total: 18n,
  },
  needsServiceApproval: false,
  rates: { perEpoch: 1n, perMonth: 2_592_000n },
  ready: true,
  tokenDecimals: 18,
  tokenSymbol: 'USDFC',
  withCDN: false,
}
const receipt: TransactionReceipt = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  hash: TRANSACTION_HASH,
}
const checkpoint: FilecoinStorageUploadCheckpoint = {
  account: ACCOUNT,
  carByteLength: prepared.carBytes.byteLength,
  chainId: FILECOIN_CALIBRATION_CHAIN_ID,
  ipfsIndexingRequested: true,
  mediaCid: MEDIA_CID.text,
  piece: {
    bytes: PIECE_BYTES,
    paddedSize: 512n,
    size: prepared.carBytes.byteLength,
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
const result: FilecoinStorageUploadResult = {
  ...checkpoint,
  dataSetId: 29n,
  initialTransactionHash: TRANSACTION_HASH,
  pieceId: 41n,
  providerPieceUrl: `https://provider.example/pdp/piece/${checkpoint.piece.text}`,
  receipt,
  transactionHash: TRANSACTION_HASH,
}

function connectedSession(account: Address = ACCOUNT): WalletSession {
  return {
    account,
    chainId: FILECOIN_CALIBRATION_CHAIN_ID,
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

function submissionUnknown(hash?: Hash) {
  const error = new Error(
    hash
      ? 'The provider transaction has an unknown final result.'
      : 'The signed storage authorization was released without a hash.',
  ) as Error & {
    checkpoint: FilecoinStorageUploadCheckpoint
    transactionHash?: Hash
  }
  error.name = 'FilecoinStorageSubmissionUnknownError'
  error.checkpoint = checkpoint
  if (hash) error.transactionHash = hash
  return error
}

function renderUpload({
  checkReceipt,
  onWriteLockChange,
  session = connectedSession(),
  storageQuote = quote,
  uploadStorage,
}: {
  checkReceipt?: FilecoinStorageUploadReceiptChecker
  onWriteLockChange?(locked: boolean): void
  session?: WalletSession
  storageQuote?: FilecoinStorageQuote
  uploadStorage?: FilecoinStorageUploader
} = {}) {
  return render(
    <FilecoinStorageUploadPanel
      checkReceipt={checkReceipt}
      onWriteLockChange={onWriteLockChange}
      prepared={prepared}
      quote={storageQuote}
      session={session}
      uploadStorage={uploadStorage}
    />,
  )
}

function authorizeUpload() {
  fireEvent.change(screen.getByRole('textbox', { name: /provider ID/i }), {
    target: { value: '17' },
  })
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: /provider receives these public bytes/i,
    }),
  )
  fireEvent.click(
    screen.getByRole('button', { name: /upload and authorize one copy/i }),
  )
}

afterEach(cleanup)

describe('FilecoinStorageUploadPanel', () => {
  it('requires an exact ready quote, explicit provider, and fee warning', () => {
    const uploadStorage = vi.fn<FilecoinStorageUploader>()
    const view = renderUpload({
      storageQuote: { ...quote, ready: false },
      uploadStorage,
    })
    expect(screen.getByText(/fresh ready quote.*exact CAR/i)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /provider ID/i })).toBeNull()

    view.rerender(
      <FilecoinStorageUploadPanel
        prepared={prepared}
        quote={quote}
        session={connectedSession()}
        uploadStorage={uploadStorage}
      />,
    )
    expect(
      screen.getByText(/first can create a charged data set/i),
    ).toBeTruthy()
    expect(
      screen.getByText(/indexing is requested, never promised/i),
    ).toBeTruthy()
    const button = screen.getByRole('button', {
      name: /upload and authorize one copy/i,
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: /provider ID/i }), {
      target: { value: '017' },
    })
    expect(screen.getByRole('alert').textContent).toMatch(/leading zeroes/i)
    fireEvent.change(screen.getByRole('textbox', { name: /provider ID/i }), {
      target: { value: '17' },
    })
    const acknowledgment = screen.getByRole('checkbox', {
      name: /provider receives these public bytes/i,
    }) as HTMLInputElement
    expect(acknowledgment.disabled).toBe(false)
    fireEvent.click(acknowledgment)
    expect(button.disabled).toBe(false)
    view.rerender(
      <FilecoinStorageUploadPanel
        prepared={prepared}
        quote={{ ...quote, rates: { ...quote.rates, perEpoch: 2n } }}
        session={connectedSession()}
        uploadStorage={uploadStorage}
      />,
    )
    expect(acknowledgment.checked).toBe(false)
    expect(uploadStorage).not.toHaveBeenCalled()
  })

  it('reports upload, signing, submission, and canonical completion', async () => {
    const pendingResult = deferred<FilecoinStorageUploadResult>()
    const started = deferred<Parameters<FilecoinStorageUploader>[4]>()
    const uploadStorage = vi.fn<FilecoinStorageUploader>(
      async (_provider, _prepared, _quote, _providerId, options) => {
        started.resolve(options)
        return await pendingResult.promise
      },
    )
    const onWriteLockChange = vi.fn()
    renderUpload({ onWriteLockChange, uploadStorage })
    authorizeUpload()
    const options = await started.promise
    expect(uploadStorage).toHaveBeenCalledWith(
      provider,
      prepared,
      quote,
      17n,
      expect.objectContaining({
        expectedAccount: ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
        signal: expect.any(AbortSignal),
      }),
    )
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(true),
    )

    act(() => options.onProgress?.(136, 273))
    expect(screen.getByText(/136 B of 273 B/i)).toBeTruthy()
    act(() => options.onStored?.(checkpoint))
    expect(
      screen.getByText(/first signature can create and charge/i),
    ).toBeTruthy()
    act(() => options.onSubmitted?.(TRANSACTION_HASH))
    expect(screen.getByTitle(TRANSACTION_HASH)).toBeTruthy()

    await act(async () => pendingResult.resolve(result))
    expect(
      await screen.findByText(
        /storage confirmed in block 42.*data set 29.*piece 41/i,
      ),
    ).toBeTruthy()
    expect(screen.getByText(/not yet proven indexed, pinned/i)).toBeTruthy()
    const endpoint = screen.getByRole('link') as HTMLAnchorElement
    expect(endpoint.href).toBe(result.providerPieceUrl)
    expect(endpoint.rel).toBe('noreferrer')
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
    expect(
      (
        screen.getByRole('textbox', {
          name: /provider ID/i,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true)
  })

  it('distinguishes a pre-signature rejection from no-hash ambiguity', async () => {
    const rejected = vi.fn<FilecoinStorageUploader>(async () => {
      throw Object.assign(new Error('No thanks.'), { code: 4001 })
    })
    const rejectedLock = vi.fn()
    renderUpload({ onWriteLockChange: rejectedLock, uploadStorage: rejected })
    authorizeUpload()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /wallet request was rejected/i,
    )
    await waitFor(() => expect(rejectedLock).toHaveBeenLastCalledWith(false))

    cleanup()
    const ambiguous = vi.fn<FilecoinStorageUploader>(async () => {
      throw submissionUnknown()
    })
    const ambiguousLock = vi.fn()
    renderUpload({
      onWriteLockChange: ambiguousLock,
      uploadStorage: ambiguous,
    })
    authorizeUpload()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /fee-bearing signature.*without a transaction hash/i,
    )
    await waitFor(() => expect(ambiguousLock).toHaveBeenLastCalledWith(true))
    fireEvent.click(screen.getByRole('button', { name: /clear storage lock/i }))
    await waitFor(() => expect(ambiguousLock).toHaveBeenLastCalledWith(false))
  })

  it('recovers a standalone paid data set without claiming storage', async () => {
    const uploadStorage = vi.fn<FilecoinStorageUploader>(async () => {
      throw submissionUnknown(TRANSACTION_HASH)
    })
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>(
      async () => ({
        dataSetId: 29n,
        kind: 'data-set-created',
        receipt,
      }),
    )
    const onWriteLockChange = vi.fn()
    renderUpload({ checkReceipt, onWriteLockChange, uploadStorage })
    authorizeUpload()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /do not authorize another provider attempt/i,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /check storage receipt again/i }),
    )
    expect(
      await screen.findByText(
        /created data set 29.*did not add the CAR piece/i,
      ),
    ).toBeTruthy()
    expect(screen.getByText(/not storage completion/i)).toBeTruthy()
    expect(checkReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      checkpoint,
      {
        expectedAccount: ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
        signal: expect.any(AbortSignal),
      },
    )
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(false),
    )
  })

  it('recovers a completed piece and retains failures for another check', async () => {
    const uploadStorage = vi.fn<FilecoinStorageUploader>(async () => {
      throw submissionUnknown(TRANSACTION_HASH)
    })
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>()
    checkReceipt
      .mockRejectedValueOnce(new Error('RPC temporarily unavailable.'))
      .mockResolvedValueOnce({
        dataSetId: 29n,
        kind: 'piece-added',
        pieceId: 41n,
        receipt,
      })
    renderUpload({ checkReceipt, uploadStorage })
    authorizeUpload()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /check storage receipt again/i,
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /RPC temporarily unavailable/i,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /check storage receipt again/i }),
    )
    expect(
      await screen.findByText(/storage confirmed in block 42.*piece 41/i),
    ).toBeTruthy()
    expect(checkReceipt).toHaveBeenCalledTimes(2)
  })

  it('cancels receipt recovery when the original wallet context changes', async () => {
    const uploadStorage = vi.fn<FilecoinStorageUploader>(async () => {
      throw submissionUnknown(TRANSACTION_HASH)
    })
    let recoverySignal: AbortSignal | undefined
    const checkReceipt = vi.fn<FilecoinStorageUploadReceiptChecker>(
      async (_provider, _hash, _checkpoint, options) => {
        recoverySignal = options.signal
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          )
        })
      },
    )
    const onWriteLockChange = vi.fn()
    const view = renderUpload({
      checkReceipt,
      onWriteLockChange,
      uploadStorage,
    })
    authorizeUpload()
    fireEvent.click(
      await screen.findByRole('button', {
        name: /check storage receipt again/i,
      }),
    )
    await waitFor(() => expect(recoverySignal).toBeDefined())
    view.rerender(
      <FilecoinStorageUploadPanel
        checkReceipt={checkReceipt}
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quote={quote}
        session={connectedSession(OTHER_ACCOUNT)}
        uploadStorage={uploadStorage}
      />,
    )
    await waitFor(() => expect(recoverySignal?.aborted).toBe(true))
    const reconnectButton = await screen.findByRole('button', {
      name: /reconnect original wallet/i,
    })
    expect((reconnectButton as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(true),
    )
  })

  it('aborts on context change and keeps signed ambiguity visible', async () => {
    let uploadSignal: AbortSignal | undefined
    const uploadStorage = vi.fn<FilecoinStorageUploader>(
      async (_provider, _prepared, _quote, _providerId, options) => {
        uploadSignal = options.signal
        options.onStored?.(checkpoint)
        return await new Promise<FilecoinStorageUploadResult>(
          (_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(submissionUnknown()),
              { once: true },
            )
          },
        )
      },
    )
    const onWriteLockChange = vi.fn()
    const view = renderUpload({ onWriteLockChange, uploadStorage })
    authorizeUpload()
    await screen.findByText(/provider has the CAR/i)
    view.rerender(
      <FilecoinStorageUploadPanel
        onWriteLockChange={onWriteLockChange}
        prepared={prepared}
        quote={quote}
        session={connectedSession(OTHER_ACCOUNT)}
        uploadStorage={uploadStorage}
      />,
    )
    await waitFor(() => expect(uploadSignal?.aborted).toBe(true))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /signed storage authorization was released/i,
    )
    await waitFor(() =>
      expect(onWriteLockChange).toHaveBeenLastCalledWith(true),
    )
  })

  it('aborts a pending operation when the panel unmounts', async () => {
    let uploadSignal: AbortSignal | undefined
    const uploadStorage = vi.fn<FilecoinStorageUploader>(
      async (_provider, _prepared, _quote, _providerId, options) => {
        uploadSignal = options.signal
        return await new Promise<FilecoinStorageUploadResult>(() => undefined)
      },
    )
    const view = renderUpload({ uploadStorage })
    authorizeUpload()
    await waitFor(() => expect(uploadSignal).toBeDefined())
    view.unmount()
    expect(uploadSignal?.aborted).toBe(true)
  })
})
