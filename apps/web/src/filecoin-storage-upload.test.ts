import {
  fwss,
  fwssView,
  serviceProviderRegistry,
} from '@filoz/synapse-core/abis'
import { calculate } from '@filoz/synapse-core/piece'
import { EIP712Types } from '@filoz/synapse-core/typed-data'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  stringToHex,
  type Hash,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  assertFilecoinStorageUploadReceipt,
  checkFilecoinStorageUploadReceipt,
  FILECOIN_STORAGE_DATA_SET_METADATA,
  isFilecoinStorageSubmissionUnknownError,
  MAX_FILECOIN_STORAGE_UPLOAD_RPC_REQUESTS,
  planFilecoinStorageUpload,
  uploadFilecoinStorage,
  type FilecoinStorageUploadCheckpoint,
  type FilecoinStorageUploadExecutor,
  type FilecoinStorageUploadOptions,
} from './filecoin-storage-upload'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_STORAGE_NETWORKS,
} from './filecoin-storage'
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import { preparePaidMediaCar, type PreparedMediaCar } from './paid-media-car'
const SIGNER = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const OTHER_SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)
const ACCOUNT = SIGNER.address
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb'
const SERVICE_PROVIDER = '0x0000000000000000000000000000000000005e11'
const PROVIDER_ID = 17n
const DATA_SET_ID = 29n
const PIECE_ID = 41n
const CLIENT_DATA_SET_ID = 53n
const TX_HASH = `0x${'12'.repeat(32)}` as Hash
const REPLACEMENT_HASH = `0x${'23'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'34'.repeat(32)}` as Hash
const UPLOAD_ID = `0x${'45'.repeat(32)}` as Hex
const CALIBRATION = FILECOIN_STORAGE_NETWORKS[1]
let piece: Awaited<ReturnType<typeof calculate>>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}
// prettier-ignore
const TYPES = { ...EIP712Types, EIP712Domain: [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
] } as const
let prepared: PreparedMediaCar
beforeAll(async () => {
  const encoded = new TextEncoder().encode('public evidence '.repeat(16))
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength))
  bytes.set(encoded)
  prepared = await preparePaidMediaCar({
    name: 'evidence.gif',
    size: bytes.byteLength,
    stream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    type: 'image/gif',
  })
  piece = await calculate(prepared.carBytes)
})
function readyQuote(
  overrides: Partial<FilecoinStorageQuote> = {},
): FilecoinStorageQuote {
  // prettier-ignore
  return {
    account: ACCOUNT, chainId: FILECOIN_CALIBRATION_CHAIN_ID, copies: 1,
    dataSize: BigInt(prepared.carBytes.byteLength), depositNeeded: 0n,
    fees: { addPiecesFee: 2n, createDataSetFee: 3n, total: 5n },
    lockups: { cacheMissLockup: 0n, cdnLockup: 0n, lifecycleLockup: 7n,
      rateDeltaPerEpoch: 1n, reserveReplenishment: 0n, streamingLockup: 11n, total: 18n },
    needsServiceApproval: false, rates: { perEpoch: 1n, perMonth: 2_592_000n },
    ready: true, tokenDecimals: 18, tokenSymbol: 'USDFC', withCDN: false,
    ...overrides,
  }
}
function domain() {
  // prettier-ignore
  return { chainId: Number(FILECOIN_CALIBRATION_CHAIN_ID),
    name: 'FilecoinWarmStorageService', verifyingContract: CALIBRATION.contracts.fwss, version: '1' }
}
function createAuthorization(overrides: Record<string, unknown> = {}) {
  // prettier-ignore
  return JSON.stringify({
    domain: domain(),
    message: {
      clientDataSetId: CLIENT_DATA_SET_ID.toString(),
      metadata: [{ key: 'source', value: 'lifeinvader' }, { key: 'withIPFSIndexing', value: '' }],
      payee: SERVICE_PROVIDER, ...overrides,
    },
    primaryType: 'CreateDataSet', types: TYPES,
  })
}
function addAuthorization(
  mediaCid: string,
  overrides: Record<string, unknown> = {},
  uploadId: Hex = UPLOAD_ID,
) {
  // prettier-ignore
  return JSON.stringify({
    domain: domain(), message: {
      clientDataSetId: CLIENT_DATA_SET_ID.toString(), nonce: '61',
      pieceData: [{ data: bytesToHex(piece.bytes) }],
      pieceMetadata: [{ metadata: [
        { key: 'ipfsRootCID', value: mediaCid },
        { key: 'lifeinvaderUploadId', value: uploadId },
      ], pieceIndex: '0' }],
      ...overrides,
    },
    primaryType: 'AddPieces', types: TYPES,
  })
}
function signAuthorization(data: string, signer = SIGNER) {
  return signer.signTypedData(JSON.parse(data))
}
function providerDetails(overrides: Record<string, unknown> = {}) {
  // prettier-ignore
  return {
    ipniIpfs: true, isActive: true, maxPieceSizeInBytes: 32n * 1024n * 1024n,
    minPieceSizeInBytes: 127n, paymentTokenAddress: CALIBRATION.contracts.usdfc,
    payee: SERVICE_PROVIDER, providerId: PROVIDER_ID, serviceProvider: SERVICE_PROVIDER,
    serviceUrl: 'https://provider.example/pdp', ...overrides,
  }
}
function providerReadResult(overrides: Record<string, unknown> = {}) {
  const provider = providerDetails(overrides)
  // prettier-ignore
  return encodeFunctionResult({
    abi: serviceProviderRegistry, functionName: 'getProviderWithProduct',
    result: {
      product: {
        capabilityKeys: ['serviceURL', 'minPieceSizeInBytes', 'maxPieceSizeInBytes',
          'storagePricePerTibPerDay', 'minProvingPeriodInEpochs', 'location',
          'paymentTokenAddress', 'ipniIpfs'],
        isActive: true, productType: 0,
      },
      productCapabilityValues: [
        stringToHex(provider.serviceUrl), numberToHex(provider.minPieceSizeInBytes, { size: 32 }),
        numberToHex(provider.maxPieceSizeInBytes, { size: 32 }), '0x01', '0x01',
        stringToHex('test'), provider.paymentTokenAddress as Hex,
        provider.ipniIpfs ? '0x01' : '0x00',
      ],
      providerId: provider.providerId,
      providerInfo: {
        description: 'Fixture provider', isActive: provider.isActive, name: 'Fixture',
        payee: provider.payee as `0x${string}`,
        serviceProvider: provider.serviceProvider as `0x${string}`,
      },
    },
  })
}
// prettier-ignore
function storageLogs(hash: Hash = REPLACEMENT_HASH, overrides: {
  cdnRailId?: bigint; dataSetId?: bigint; dataSetMetadataValues?: string[]; mediaCid?: string
  payee?: `0x${string}`; pieceCid?: Hex; pieceId?: bigint; providerId?: bigint
  serviceProvider?: `0x${string}`; uploadId?: Hex
} = {}) {
  const dataSetId = overrides.dataSetId ?? DATA_SET_ID
  const pieceId = overrides.pieceId ?? PIECE_ID
  const serviceProvider = overrides.serviceProvider ?? SERVICE_PROVIDER
  const providerId = overrides.providerId ?? PROVIDER_ID
  const common = { address: CALIBRATION.contracts.fwss, blockHash: BLOCK_HASH,
    blockNumber: '0x2a', transactionHash: hash }
  return [
    {
      ...common,
      data: encodeAbiParameters(
        [
          { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
          { type: 'address' }, { type: 'address' }, { type: 'address' },
          { type: 'string[]' }, { type: 'string[]' },
        ],
        [
          67n, 0n, overrides.cdnRailId ?? 0n, ACCOUNT, serviceProvider, overrides.payee ?? serviceProvider,
          ['source', 'withIPFSIndexing'],
          overrides.dataSetMetadataValues ?? ['lifeinvader', ''],
        ],
      ),
      topics: encodeEventTopics({ abi: fwss, args: { dataSetId, providerId }, eventName: 'DataSetCreated' }),
    },
    {
      ...common,
      data: encodeAbiParameters(
        [
          { components: [{ name: 'data', type: 'bytes' }], type: 'tuple' },
          { type: 'string[]' }, { type: 'string[]' },
        ],
        [
          { data: overrides.pieceCid ?? bytesToHex(piece.bytes) },
          ['ipfsRootCID', 'lifeinvaderUploadId'],
          [overrides.mediaCid ?? prepared.mediaCid.text, overrides.uploadId ?? UPLOAD_ID],
        ],
      ),
      topics: encodeEventTopics({ abi: fwss, args: { dataSetId, pieceId }, eventName: 'PieceAdded' }),
    },
  ]
}
// prettier-ignore
function walletProvider({ account = ACCOUNT, approved = true, hash = REPLACEMENT_HASH,
  logs, methods = [], providerOverrides = {}, receiptRequest,
  signatureRequest, signatureError }: {
  account?: string; approved?: boolean; hash?: Hash
  logs?: unknown[] | ((uploadId: Hex) => unknown[]); methods?: string[]
  providerOverrides?: Record<string, unknown>; receiptRequest?: () => Promise<unknown>
  signatureRequest?: (request: ProviderRequest) => Promise<unknown>; signatureError?: unknown
} = {}): Eip1193Provider {
  let signedUploadId = UPLOAD_ID
  return {
    async request({ method, params }: ProviderRequest) {
      methods.push(method)
      if (method === 'eth_accounts') return [account]
      if (method === 'eth_chainId') {
        return `0x${FILECOIN_CALIBRATION_CHAIN_ID.toString(16)}`
      }
      if (method === 'eth_blockNumber') return '0x29'
      if (method === 'eth_call') {
        const call = Array.isArray(params) ? params[0] : undefined
        const target =
          typeof call === 'object' && call !== null && 'to' in call
            ? String(call.to).toLowerCase()
            : ''
        if (
          target === CALIBRATION.contracts.serviceProviderRegistry.toLowerCase()
        ) {
          return providerReadResult(providerOverrides)
        }
        if (target === CALIBRATION.contracts.fwssView.toLowerCase()) {
          return encodeFunctionResult({
            abi: fwssView,
            functionName: 'isProviderApproved',
            result: approved,
          })
        }
        throw new Error(`Unexpected eth_call target ${target}`)
      }
      if (method === 'eth_signTypedData_v4') {
        const data = Array.isArray(params) ? params[1] : undefined
        const match = typeof data === 'string'
          ? /"key"\s*:\s*"lifeinvaderUploadId"\s*,\s*"value"\s*:\s*"(0x[0-9a-f]{64})"/i.exec(data)
          : undefined
        if (match?.[1]) signedUploadId = match[1] as Hex
        if (signatureError) throw signatureError
        if (signatureRequest) return await signatureRequest({ method, params })
        return await signAuthorization(String(data))
      }
      if (method === 'eth_getTransactionReceipt') {
        if (receiptRequest) return await receiptRequest()
        return {
          blockHash: BLOCK_HASH,
          blockNumber: '0x2a',
          logs: typeof logs === 'function'
            ? logs(signedUploadId)
            : (logs ?? storageLogs(hash, { uploadId: signedUploadId })),
          status: '0x1',
          transactionHash: hash,
        }
      }
      if (method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      throw new Error(`Unexpected wallet method ${method}`)
    },
  }
}
// prettier-ignore
const inspection = () => vi.fn(async () => ({ kind: 'ready' as const, network: CALIBRATION }))
// prettier-ignore
async function selectProvider(input: Pick<Parameters<FilecoinStorageUploadExecutor>[0], 'plan' | 'request'>) {
  const reads = [
    [
      input.plan.network.contracts.serviceProviderRegistry,
      encodeFunctionData({ abi: serviceProviderRegistry, args: [input.plan.providerId, 0],
        functionName: 'getProviderWithProduct' }),
    ],
    [
      input.plan.network.contracts.fwssView,
      encodeFunctionData({ abi: fwssView, args: [input.plan.providerId], functionName: 'isProviderApproved' }),
    ],
  ] as const
  for (const [to, data] of reads)
    await input.request({ method: 'eth_call', params: [{ data, to }, 'latest'] })
}
// prettier-ignore
async function stagePiece(input: Pick<Parameters<FilecoinStorageUploadExecutor>[0],
  'onStored' | 'plan' | 'reportProgress' | 'request'>,
progress = input.plan.carBytes.byteLength) {
  await selectProvider(input)
  input.reportProgress(progress)
  input.onStored({ bytes: piece.bytes, paddedSize: piece.paddedSize,
    size: input.plan.carBytes.byteLength, text: piece.toString() })
}
function requestSignature(
  input: Parameters<FilecoinStorageUploadExecutor>[0],
  data: string,
) {
  return input.request({
    method: 'eth_signTypedData_v4',
    params: [input.plan.account, data],
  })
}
async function signAndAuthorize(
  input: Parameters<FilecoinStorageUploadExecutor>[0],
  createData = createAuthorization(),
  addData = addAuthorization(input.plan.mediaCid, {}, input.plan.uploadId),
) {
  await requestSignature(input, createData)
  await requestSignature(input, addData)
  await input.authorizeCommit()
}
// prettier-ignore
function successfulExecutor({ confirmedTxHash = REPLACEMENT_HASH, createData = createAuthorization(),
  addData, dataSetId = DATA_SET_ID, initialTxHash = TX_HASH, pieceId = PIECE_ID }: {
  addData?: string; confirmedTxHash?: Hash; createData?: string; dataSetId?: bigint
  initialTxHash?: Hash; pieceId?: bigint
} = {}): FilecoinStorageUploadExecutor {
  return async (input) => {
    await stagePiece(input)
    await signAndAuthorize(input, createData, addData)
    input.onSubmitted(initialTxHash)
    return { confirmedTxHash, dataSetId, isNewDataSet: true, pieceIds: [pieceId], txHash: initialTxHash }
  }
}
async function runUpload(
  executeUpload: FilecoinStorageUploadExecutor = successfulExecutor(),
  options: {
    hash?: Hash
    logs?: unknown[] | ((uploadId: Hex) => unknown[])
    onStored?: (checkpoint: FilecoinStorageUploadCheckpoint) => void
    onSubmitted?: (hash: Hash) => void
    provider?: Eip1193Provider
    quoteStorage?: NonNullable<FilecoinStorageUploadOptions['quoteStorage']>
    signal?: AbortSignal
  } = {},
) {
  const hash = options.hash ?? REPLACEMENT_HASH
  return await uploadFilecoinStorage(
    options.provider ?? walletProvider({ hash, logs: options.logs }),
    prepared,
    readyQuote(),
    PROVIDER_ID,
    {
      executeUpload,
      expectedAccount: ACCOUNT,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      inspectStorage: inspection(),
      onStored: options.onStored,
      onSubmitted: options.onSubmitted,
      pollIntervalMs: 1,
      quoteStorage: options.quoteStorage ?? vi.fn(async () => readyQuote()),
      receiptTimeoutMs: 100,
      signal: options.signal,
    },
  )
}
function recoveryFailure(cause: RegExp, hash: Hash | null = REPLACEMENT_HASH) {
  // prettier-ignore
  return { cause: { message: expect.stringMatching(cause) },
    name: 'FilecoinStorageSubmissionUnknownError', transactionHash: hash ?? undefined }
}
describe('Filecoin storage upload planning', () => {
  // prettier-ignore
  it('snapshots one ready quote and one explicit provider', async () => {
    const plan = await planFilecoinStorageUpload(
      prepared, readyQuote(), PROVIDER_ID, ACCOUNT, FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const byte = plan.carBytes[0]
    prepared.carBytes[0] = (prepared.carBytes[0] ?? 0) ^ 0xff
    expect(plan).toMatchObject({
      account: ACCOUNT, chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      mediaCid: prepared.mediaCid.text, providerId: PROVIDER_ID,
    })
    expect(plan.carBytes[0]).toBe(byte)
    expect(plan.carBytes).not.toBe(prepared.carBytes)
    expect(plan.piece).toEqual({
      bytes: bytesToHex(piece.bytes), paddedSize: piece.paddedSize,
      size: piece.size, text: piece.toString(),
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.piece)).toBe(true)
    expect(plan.uploadId).toMatch(/^0x[0-9a-f]{64}$/)
    prepared.carBytes[0] = (prepared.carBytes[0] ?? 0) ^ 0xff
    expect((await planFilecoinStorageUpload(prepared, readyQuote(), PROVIDER_ID,
      ACCOUNT, FILECOIN_CALIBRATION_CHAIN_ID)).uploadId).not.toBe(plan.uploadId)
  })
  // prettier-ignore
  it('rejects stale and unsupported upload plans', async () => {
    const attempt = (
      quote: FilecoinStorageQuote, selectedProvider = PROVIDER_ID,
      chainId = FILECOIN_CALIBRATION_CHAIN_ID,
    ) => planFilecoinStorageUpload(prepared, quote, selectedProvider, ACCOUNT, chainId)
    await expect(attempt(readyQuote({ dataSize: 999n }))).rejects.toThrow(/different media/i)
    await expect(attempt(readyQuote(), 0n)).rejects.toThrow(/provider ID/i)
    await expect(attempt(readyQuote(), PROVIDER_ID, 1n)).rejects.toThrow(/unsupported/i)
    const controller = new AbortController()
    controller.abort(new DOMException('Stop planning.', 'AbortError'))
    await expect(planFilecoinStorageUpload(
      prepared, readyQuote(), PROVIDER_ID, ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID, controller.signal,
    )).rejects.toThrow(/Stop planning/i)
  })
})
describe('Filecoin storage upload execution', () => {
  // prettier-ignore
  it('constrains reads and signatures, follows a replacement, and verifies events', async () => {
    const methods: string[] = []
    const submitted: Hash[] = []
    const stored = vi.fn()
    const result = await runUpload(successfulExecutor(), {
      onStored: stored, onSubmitted: (hash) => submitted.push(hash),
      provider: walletProvider({ methods })
    })
    expect(result).toMatchObject({
      account: ACCOUNT, carByteLength: prepared.carBytes.byteLength,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID, dataSetId: DATA_SET_ID,
      initialTransactionHash: TX_HASH, ipfsIndexingRequested: true,
      mediaCid: prepared.mediaCid.text, pieceId: PIECE_ID,
      provider: { id: PROVIDER_ID, serviceProvider: SERVICE_PROVIDER,
        serviceUrl: 'https://provider.example/pdp/' },
      transactionHash: REPLACEMENT_HASH, withCDN: false,
    })
    expect(result.providerPieceUrl).toBe(`https://provider.example/pdp/piece/${piece.toString()}`)
    expect(result.receipt.hash).toBe(REPLACEMENT_HASH)
    expect(submitted).toEqual([TX_HASH, REPLACEMENT_HASH])
    expect(stored).toHaveBeenCalledOnce()
    expect(methods.filter((method) => method === 'eth_call')).toHaveLength(2)
    expect(methods.filter((method) => method === 'eth_signTypedData_v4')).toHaveLength(2)
    expect(methods).not.toContain('eth_sendTransaction')
  })
  // prettier-ignore
  it('rejects arbitrary reads, transactions, and excess RPC requests', async () => {
    const forbidden: FilecoinStorageUploadExecutor = async ({ request }) => {
      await request({ method: 'eth_sendTransaction', params: [] })
      throw new Error('unreachable')
    }
    await expect(runUpload(forbidden)).rejects.toThrow(/forbidden RPC method/i)
    const wrongRead: FilecoinStorageUploadExecutor = async ({ plan, request }) => {
      await request({
        method: 'eth_call',
        params: [
          {
            data: encodeFunctionData({
              abi: fwssView, args: [plan.providerId + 1n], functionName: 'isProviderApproved',
            }),
            to: plan.network.contracts.fwssView,
          },
          'latest',
        ],
      })
      throw new Error('unreachable')
    }
    await expect(runUpload(wrongRead)).rejects.toThrow(/unexpected contract read/i)
    const greedy: FilecoinStorageUploadExecutor = async ({ request }) => {
      for (let index = 0; index <= MAX_FILECOIN_STORAGE_UPLOAD_RPC_REQUESTS; index += 1)
        await request({ method: 'eth_blockNumber' })
      throw new Error('unreachable')
    }
    await expect(runUpload(greedy)).rejects.toThrow(/RPC request budget/i)
  })
  // prettier-ignore
  it('rejects changed typed-data terms before forwarding them', async () => {
    const cases: [FilecoinStorageUploadExecutor, RegExp, number][] = [
      [successfulExecutor({ createData: createAuthorization({ payee: OTHER_ACCOUNT }) }),
        /data-set authorization terms/i, 0],
      [
        successfulExecutor({
          addData: addAuthorization(prepared.mediaCid.text, {
            pieceMetadata: [{ metadata: [{ key: 'ipfsRootCID', value: 'bafkqaaa' }], pieceIndex: '0' }],
          }),
        }),
        /piece authorization terms/i, 1,
      ],
    ]
    for (const [executor, message, signatures] of cases) {
      const wallet = walletProvider()
      const request = vi.spyOn(wallet, 'request')
      await expect(runUpload(executor, { provider: wallet })).rejects.toThrow(message)
      expect(request.mock.calls.filter(
        ([candidate]) => candidate.method === 'eth_signTypedData_v4',
      )).toHaveLength(signatures)
    }
  })
  // prettier-ignore
  it('revalidates costs and verifies the signer before authorization', async () => {
    const changedWallet = walletProvider()
    const changedRequest = vi.spyOn(changedWallet, 'request')
    let quoteReads = 0
    const quoteStorage = vi.fn(async () => ++quoteReads === 1 ? readyQuote()
      : readyQuote({ rates: { perEpoch: 2n, perMonth: 5_184_000n } }))
    await expect(runUpload(successfulExecutor(), {
      provider: changedWallet, quoteStorage,
    })).rejects.toThrow(/quote changed/i)
    expect(changedRequest.mock.calls.filter(
      ([candidate]) => candidate.method === 'eth_signTypedData_v4',
    )).toHaveLength(1)
    await expect(runUpload(successfulExecutor(), { provider: walletProvider({
      signatureRequest: async () => signAuthorization(createAuthorization(), OTHER_SIGNER),
    }) })).rejects.toThrow(/not signed by the selected account/i)
  })
  // prettier-ignore
  it('rejects providers that cannot perform the promised IPFS path', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ipniIpfs: false }, /does not advertise IPFS indexing/i],
      [{ payee: OTHER_ACCOUNT }, /payee must be its service account/i],
      [{ serviceUrl: 'http://provider.example/' }, /credential-free HTTPS/i],
      [{ minPieceSizeInBytes: BigInt(prepared.carBytes.byteLength + 1) }, /outside the provider size range/i],
    ]
    for (const [providerOverrides, message] of cases)
      await expect(runUpload(successfulExecutor(), {
        provider: walletProvider({ providerOverrides }),
      })).rejects.toThrow(message)
  })
  // prettier-ignore
  it('requires authenticated registry and approval reads before storage', async () => {
    const skipsReads: FilecoinStorageUploadExecutor = async (input) => {
      input.onStored({
        bytes: piece.bytes, paddedSize: piece.paddedSize,
        size: input.plan.carBytes.byteLength, text: piece.toString(),
      })
      throw new Error('unreachable')
    }
    await expect(runUpload(skipsReads)).rejects.toThrow(/unauthenticated provider/i)
    await expect(runUpload(successfulExecutor(), {
      provider: walletProvider({ approved: false }),
    })).rejects.toThrow(/not approved/i)
  })
  // prettier-ignore
  it('rejects a provider PieceCID for bytes other than the planned CAR', async () => {
    const wrongPiece = await calculate(new Uint8Array(prepared.carBytes.byteLength).fill(7))
    const dishonest: FilecoinStorageUploadExecutor = async (input) =>
      await successfulExecutor()({
        ...input,
        onStored(value) {
          input.onStored({
            ...value, bytes: wrongPiece.bytes,
            paddedSize: wrongPiece.paddedSize, text: wrongPiece.toString(),
          })
        },
      })
    await expect(runUpload(dishonest)).rejects.toThrow(/does not match/i)
  })
  it('requires a complete upload and exactly two signatures before commit', async () => {
    const incomplete: FilecoinStorageUploadExecutor = async (input) => {
      await stagePiece(input, input.plan.carBytes.byteLength - 1)
      await signAndAuthorize(input)
      throw new Error('unreachable')
    }
    await expect(runUpload(incomplete)).rejects.toMatchObject(
      recoveryFailure(/incomplete storage commit/i, null),
    )
  })
  it('serializes wallet prompts and withholds signatures after cancellation', async () => {
    const delayedWallet = () => {
      const prompted = deferred<void>()
      const response = deferred<Hex>()
      const signatureRequest = vi.fn(() => {
        prompted.resolve(undefined)
        return response.promise
      })
      return {
        prompted,
        provider: walletProvider({ signatureRequest }),
        response,
        signatureRequest,
      }
    }
    const concurrentWallet = delayedWallet()
    const concurrent: FilecoinStorageUploadExecutor = async (input) => {
      await stagePiece(input)
      const first = requestSignature(input, createAuthorization())
      await concurrentWallet.prompted.promise
      await expect(
        requestSignature(input, addAuthorization(input.plan.mediaCid)),
      ).rejects.toThrow(/unexpected signature/i)
      concurrentWallet.response.resolve(
        await signAuthorization(createAuthorization()),
      )
      await first
      await expect(input.authorizeCommit()).rejects.toThrow(/incomplete/i)
      throw new Error('fixture stopped after first signature')
    }
    await expect(
      runUpload(concurrent, { provider: concurrentWallet.provider }),
    ).rejects.toThrow(/provider did not complete/i)
    expect(concurrentWallet.signatureRequest).toHaveBeenCalledOnce()
    const cancelledWallet = delayedWallet()
    const controller = new AbortController()
    const pending = runUpload(successfulExecutor(), {
      provider: cancelledWallet.provider,
      signal: controller.signal,
    })
    await cancelledWallet.prompted.promise
    controller.abort(new DOMException('Stop upload.', 'AbortError'))
    await expect(pending).rejects.toThrow(/cancelled/i)
    const abandonedWallet = delayedWallet()
    const abandoned: FilecoinStorageUploadExecutor = async (input) => {
      await stagePiece(input)
      const first = requestSignature(input, createAuthorization())
      void first.catch(() => undefined)
      await abandonedWallet.prompted.promise
      await expect(
        requestSignature(input, addAuthorization(input.plan.mediaCid)),
      ).rejects.toThrow(/unexpected signature/i)
      throw new Error('adapter exited with an abandoned prompt')
    }
    await expect(
      runUpload(abandoned, { provider: abandonedWallet.provider }),
    ).rejects.toThrow(/provider did not complete/i)
  })
  it('preserves wallet rejection before any provider commit', async () => {
    const rejection = Object.assign(new Error('User rejected.'), { code: 4001 })
    await expect(
      runUpload(successfulExecutor(), {
        provider: walletProvider({ signatureError: rejection }),
      }),
    ).rejects.toBe(rejection)
    let signatures = 0
    const retried: FilecoinStorageUploadExecutor = async (input) => {
      await stagePiece(input)
      await expect(requestSignature(input, createAuthorization())).rejects.toBe(
        rejection,
      )
      await signAndAuthorize(input)
      input.onSubmitted(TX_HASH)
      throw new Error('provider failed after submission')
    }
    await expect(
      runUpload(retried, {
        provider: walletProvider({
          signatureRequest: async ({ params }) => {
            if (signatures++ === 0) throw rejection
            return await signAuthorization(
              String(Array.isArray(params) ? params[1] : undefined),
            )
          },
        }),
      }),
    ).rejects.toMatchObject(recoveryFailure(/after submission/i, TX_HASH))
  })
  // prettier-ignore
  it('cancels receipt polling and a hung authorized provider', async () => {
    const requested = deferred<void>()
    const controller = new AbortController()
    const pending = runUpload(successfulExecutor(), {
      provider: walletProvider({ receiptRequest() {
        requested.resolve(undefined); return new Promise(() => undefined)
      } }), signal: controller.signal,
    })
    await requested.promise
    controller.abort(new DOMException('Stop upload.', 'AbortError'))
    await expect(pending).rejects.toMatchObject(recoveryFailure(/cancelled/i))
    const authorized = deferred<void>()
    const hung: FilecoinStorageUploadExecutor = async (input) => {
      await stagePiece(input)
      await signAndAuthorize(input)
      authorized.resolve(undefined)
      return await new Promise(() => undefined)
    }
    const hungController = new AbortController()
    const hungUpload = runUpload(hung, { signal: hungController.signal })
    await authorized.promise
    hungController.abort(new DOMException('Stop commit.', 'AbortError'))
    await expect(hungUpload).rejects.toMatchObject(recoveryFailure(/cancelled/i, null))
    const guardRead = deferred<void>()
    const base = walletProvider()
    const guardProvider: Eip1193Provider = { ...base, request(request) {
      if (request.method !== 'eth_chainId') return base.request(request)
      guardRead.resolve(undefined); return new Promise(() => undefined)
    } }
    const guardController = new AbortController()
    const guardUpload = runUpload(successfulExecutor(), {
      provider: guardProvider, signal: guardController.signal,
    })
    await guardRead.promise
    guardController.abort(new DOMException('Stop guard.', 'AbortError'))
    await expect(guardUpload).rejects.toThrow(/Stop guard/i)
  })
  // prettier-ignore
  it('returns a recovery checkpoint when provider submission is uncertain', async () => {
    const checkpoints: FilecoinStorageUploadCheckpoint[] = []
    const uncertain: FilecoinStorageUploadExecutor = async (input) => {
      const base = successfulExecutor({ confirmedTxHash: TX_HASH })
      await base({
        ...input,
        onSubmitted(hash) { input.onSubmitted(hash)
          throw new Error('provider disconnected after accepting commit') },
      })
      throw new Error('unreachable')
    }
    let failure: unknown
    try {
      await runUpload(uncertain, { onStored: (checkpoint) => checkpoints.push(checkpoint) })
    } catch (error) { failure = error }
    expect(isFilecoinStorageSubmissionUnknownError(failure)).toBe(true)
    if (!isFilecoinStorageSubmissionUnknownError(failure)) return
    expect(failure.transactionHash).toBe(TX_HASH)
    expect(failure.checkpoint).toEqual(checkpoints[0])
    expect(failure.checkpoint.mediaCid).toBe(prepared.mediaCid.text)
    const noHash: FilecoinStorageUploadExecutor = async (input) => {
      await stagePiece(input)
      await requestSignature(input, createAuthorization())
      await requestSignature(input, addAuthorization(
        input.plan.mediaCid, {}, input.plan.uploadId,
      ))
      throw new Error('provider disconnected before returning a hash')
    }
    await expect(runUpload(noHash)).rejects.toMatchObject({ name:
      'FilecoinStorageSubmissionUnknownError', transactionHash: undefined })
    const malformed: FilecoinStorageUploadExecutor = async (input) => ({
      ...(await successfulExecutor({ confirmedTxHash: TX_HASH })(input)),
      pieceIds: [],
    })
    await expect(runUpload(malformed)).rejects.toMatchObject(recoveryFailure(/invalid commit result/i, TX_HASH))
  })
  // prettier-ignore
  it('releases both wallet listener layers when registration fails', async () => {
    const registrationFailure = new Error('listener registration failed')
    const base = walletProvider()
    const listeners = new Set<(...args: unknown[]) => void>()
    let registrations = 0
    const provider: Eip1193Provider = {
      request: base.request,
      on(_event, listener) { if (++registrations === 4) throw registrationFailure; listeners.add(listener) },
      removeListener(_event, listener) { listeners.delete(listener) },
    }
    await expect(runUpload(successfulExecutor(), { provider })).rejects.toBe(registrationFailure)
    expect(listeners.size).toBe(0)
  })
})
describe('Filecoin storage receipt authentication', () => {
  async function checkpoint() {
    let captured: FilecoinStorageUploadCheckpoint | undefined
    await runUpload(successfulExecutor(), {
      onStored(value) {
        captured = value
      },
    })
    if (!captured) throw new Error('Checkpoint was not captured.')
    return captured
  }
  // prettier-ignore
  it('derives IDs from exact canonical events for later recovery', async () => {
    const saved = await checkpoint()
    await expect(checkFilecoinStorageUploadReceipt(
      walletProvider({ logs: storageLogs(REPLACEMENT_HASH, { uploadId: saved.uploadId }) }),
      REPLACEMENT_HASH, saved, { expectedAccount: ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID, pollIntervalMs: 1, receiptTimeoutMs: 100 },
    )).resolves.toMatchObject({ dataSetId: DATA_SET_ID, pieceId: PIECE_ID,
      receipt: { hash: REPLACEMENT_HASH } })
  })
  // prettier-ignore
  it('rejects changed metadata, identities, duplicates, and provider result IDs', async () => {
    const changed: [Parameters<typeof storageLogs>[1], RegExp][] = [
      [{ dataSetMetadataValues: ['another-app', ''] }, /data-set event/i],
      [{ cdnRailId: 1n }, /data-set event/i],
      [{ mediaCid: 'bafkqaaa' }, /piece event/i],
      [{ uploadId: UPLOAD_ID }, /piece event/i],
      [{ payee: OTHER_ACCOUNT }, /data-set event/i],
      [{ serviceProvider: OTHER_ACCOUNT }, /data-set event/i],
    ]
    for (const [overrides, message] of changed)
      await expect(runUpload(successfulExecutor(), { logs: (uploadId) =>
        storageLogs(REPLACEMENT_HASH, { uploadId, ...overrides }),
      })).rejects.toMatchObject(recoveryFailure(message))
    await expect(runUpload(successfulExecutor(), { logs: (uploadId) => {
      const duplicated = storageLogs(REPLACEMENT_HASH, { uploadId })
      duplicated.push(duplicated[1] as (typeof duplicated)[number]); return duplicated
    } })).rejects.toMatchObject(recoveryFailure(/exactly one data set and one piece/i))
    await expect(runUpload(successfulExecutor({ pieceId: PIECE_ID + 1n })))
      .rejects.toMatchObject(recoveryFailure(/provider result disagrees/i))
  })
  // prettier-ignore
  it('rejects noncanonical receipt fields and wrong recovery context', async () => {
    const saved = await checkpoint()
    const receipt = { blockHash: BLOCK_HASH, blockNumber: 42n, hash: REPLACEMENT_HASH }
    const logs = storageLogs(REPLACEMENT_HASH, { uploadId: saved.uploadId })
    ;(logs[0] as Record<string, unknown>).transactionHash = TX_HASH
    expect(() => assertFilecoinStorageUploadReceipt(logs, receipt, saved)).toThrow(/not canonical/i)
    await expect(checkFilecoinStorageUploadReceipt(
      walletProvider(), REPLACEMENT_HASH, saved, { expectedAccount: OTHER_ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID, pollIntervalMs: 1, receiptTimeoutMs: 100 },
    )).rejects.toThrow(/different upload context/i)
  })
  it('does not mistake an indexing request for completed indexing', async () => {
    expect(FILECOIN_STORAGE_DATA_SET_METADATA).toEqual({
      source: 'lifeinvader',
      withIPFSIndexing: '',
    })
    const result = await runUpload()
    expect(result.ipfsIndexingRequested).toBe(true)
    expect(result).not.toHaveProperty('indexed')
    expect(result).not.toHaveProperty('pinned')
  })
})
