import {
  fwss as STORAGE_EVENT_ABI,
  fwssView as APPROVAL_READ_ABI,
  serviceProviderRegistry as PROVIDER_READ_ABI,
} from '@filoz/synapse-core/abis'
import {
  hasActivePDPProduct,
  parsePDPProvider,
} from '@filoz/synapse-core/sp-registry'
import {
  calculate as calculatePieceCid,
  from as parsePieceCid,
} from '@filoz/synapse-core/piece'
import { EIP712Types } from '@filoz/synapse-core/typed-data'
import {
  bytesToHex,
  custom,
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeEventTopics,
  getAddress,
  isAddress,
  maxUint256,
  verifyTypedData,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import {
  getRpcErrorCode,
  parseAccounts,
  parseChainId,
  parseTransactionHash,
  requestProviderBeforeDeadline,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  getFilecoinStorageNetwork,
  inspectFilecoinStorage,
  type FilecoinStorageInspectionOptions,
  type FilecoinStorageNetwork,
} from './filecoin-storage'
import {
  quoteFilecoinStorage,
  type FilecoinStorageQuote,
} from './filecoin-storage-quote'
import { bindFilecoinStorageSynapseChain } from './filecoin-storage-synapse'
import { parseMediaCid } from './media-cid'
import {
  MAX_PAID_MEDIA_CAR_BYTES,
  validatePreparedMediaCar,
  type PreparedMediaCar,
} from './paid-media-car'
import {
  createTransactionGuard,
  waitForTransactionReceipt,
  type TransactionReceipt,
} from './protocol'
export const FILECOIN_STORAGE_UPLOAD_READ_TIMEOUT_MS = 15_000
export const FILECOIN_STORAGE_UPLOAD_RECEIPT_TIMEOUT_MS = 180_000
export const MAX_FILECOIN_STORAGE_UPLOAD_RPC_REQUESTS = 32
export const FILECOIN_STORAGE_DATA_SET_METADATA = Object.freeze({
  source: 'lifeinvader',
  withIPFSIndexing: '',
})
const STORAGE_DOMAIN_NAME = 'FilecoinWarmStorageService'
const STORAGE_DOMAIN_VERSION = '1'
const PIECE_METADATA_KEY = 'ipfsRootCID'
const UPLOAD_METADATA_KEY = 'lifeinvaderUploadId'
const PDP_PRODUCT_TYPE = 0n
const EIP712_FIELDS = {
  ...EIP712Types,
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const
type PieceDetails<Bytes> = {
  bytes: Bytes
  paddedSize: bigint
  size: number
  text: string
}
export type FilecoinStorageUploadPlan = {
  account: Address
  carBytes: Uint8Array
  chainId: bigint
  mediaCid: string
  network: FilecoinStorageNetwork
  piece: PieceDetails<Hex>
  providerId: bigint
  quoteFingerprint: string
  uploadId: Hex
}
export type FilecoinStorageUploadPiece = PieceDetails<Uint8Array>
export type FilecoinStorageUploadCheckpoint = {
  account: Address
  carByteLength: number
  chainId: bigint
  ipfsIndexingRequested: true
  mediaCid: string
  piece: PieceDetails<Hex>
  provider: {
    id: bigint
    serviceProvider: Address
    serviceUrl: string
  }
  uploadId: Hex
  withCDN: false
}
export type FilecoinStorageUploadExecutorResult = {
  confirmedTxHash?: Hash
  dataSetId: bigint
  isNewDataSet: boolean
  pieceIds: bigint[]
  txHash: Hash
}
export type FilecoinStorageUploadExecutor = (input: {
  authorizeCommit(): Promise<void>
  onStored(piece: FilecoinStorageUploadPiece): Promise<void>
  onSubmitted(hash: Hash): void
  plan: FilecoinStorageUploadPlan
  reportProgress(bytesUploaded: number): void
  request(request: ProviderRequest): Promise<unknown>
  signal: AbortSignal
}) => Promise<FilecoinStorageUploadExecutorResult>
export type FilecoinStorageUploadOptions = {
  executeUpload?: FilecoinStorageUploadExecutor
  expectedAccount: Address
  expectedChainId: bigint
  inspectStorage?: typeof inspectFilecoinStorage
  onProgress?: (bytesUploaded: number, totalBytes: number) => void
  onStored?: (
    checkpoint: FilecoinStorageUploadCheckpoint,
  ) => Promise<void> | void
  onSubmitted?: (hash: Hash) => Promise<void> | void
  pollIntervalMs?: number
  readTimeoutMs?: number
  receiptTimeoutMs?: number
  quoteStorage?: typeof quoteFilecoinStorage
  signal?: AbortSignal
}
type FilecoinStorageUploadEvents =
  | { dataSetId: bigint; kind: 'data-set-created' }
  | { dataSetId: bigint; kind: 'piece-added'; pieceId: bigint }
export type FilecoinStorageUploadReceipt = FilecoinStorageUploadEvents & {
  receipt: TransactionReceipt
}
export type FilecoinStorageUploadResult = FilecoinStorageUploadCheckpoint & {
  dataSetId: bigint
  initialTransactionHash: Hash
  pieceId: bigint
  providerPieceUrl: string
  receipt: TransactionReceipt
  transactionHash: Hash
}
export type FilecoinStorageUploadReceiptOptions = {
  expectedAccount: Address
  expectedChainId: bigint
  pollIntervalMs?: number
  receiptTimeoutMs?: number
  signal?: AbortSignal
}
class FilecoinStorageUploadError extends Error {}
export class FilecoinStorageSubmissionUnknownError extends Error {
  readonly checkpoint: FilecoinStorageUploadCheckpoint
  readonly transactionHash?: Hash
  constructor(
    cause: unknown,
    checkpoint: FilecoinStorageUploadCheckpoint,
    transactionHash?: Hash,
  ) {
    super(
      transactionHash
        ? `The storage provider reported transaction ${transactionHash}, but its final result is unknown. Check that transaction before authorizing another storage agreement.`
        : 'The signed storage authorization was released for provider submission, but no transaction hash was returned. The provider may still submit it; check wallet and provider activity before trying again.',
      { cause },
    )
    this.name = 'FilecoinStorageSubmissionUnknownError'
    this.checkpoint = checkpoint
    this.transactionHash = transactionHash
  }
}
export function isFilecoinStorageSubmissionUnknownError(
  error: unknown,
): error is FilecoinStorageSubmissionUnknownError {
  return error instanceof FilecoinStorageSubmissionUnknownError
}
function uploadError(reason: string, options?: ErrorOptions) {
  return new FilecoinStorageUploadError(
    `Cannot store media on Filecoin: ${reason}`,
    options,
  )
}
function sameAddress(first: string, second: string) {
  return first.toLowerCase() === second.toLowerCase()
}
function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw uploadError(`the ${label} is invalid.`)
  }
  return getAddress(value)
}
function parseHex(value: unknown, label: string, maximumBytes: number): Hex {
  if (
    typeof value !== 'string' ||
    value.length > maximumBytes * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw uploadError(`the ${label} is invalid.`)
  }
  return value as Hex
}
function parseQuantity(value: unknown, label: string): bigint {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))
  ) {
    const parsed = BigInt(value)
    if (parsed <= maxUint256) return parsed
  }
  throw uploadError(`the ${label} is invalid.`)
}
function beforeUploadAbort<T>(
  start: () => PromiseLike<T>,
  signal: AbortSignal,
) {
  let handleAbort!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(uploadError('the upload was cancelled.'))
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
  })
  const pending = new Promise<T>((resolve, reject) => {
    if (!signal.aborted) Promise.resolve(start()).then(resolve, reject)
  })
  return Promise.race([interrupted, pending]).finally(() => {
    signal.removeEventListener('abort', handleAbort)
  })
}
function assertUnsigned(
  value: unknown,
  label: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maxUint256) {
    throw uploadError(`the quote has an invalid ${label}.`)
  }
}
function validTimeout(value: number, maximum: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}
function sameNetwork(
  first: FilecoinStorageNetwork,
  second: FilecoinStorageNetwork,
) {
  return (
    first.chainId === second.chainId &&
    Object.keys(first.contracts).every((name) =>
      sameAddress(
        first.contracts[name as keyof FilecoinStorageNetwork['contracts']],
        second.contracts[name as keyof FilecoinStorageNetwork['contracts']],
      ),
    )
  )
}
function quoteFingerprint(quote: FilecoinStorageQuote) {
  return JSON.stringify(quote, (_key, value) =>
    typeof value === 'bigint' ? `${value.toString()}n` : value,
  ).toLowerCase()
}
function validateReadyQuote(
  quote: FilecoinStorageQuote,
  account: Address,
  chainId: bigint,
  carByteLength: number,
) {
  if (
    !sameAddress(quote.account, account) ||
    quote.chainId !== chainId ||
    quote.dataSize !== BigInt(carByteLength)
  ) {
    throw uploadError('the quote belongs to different media or wallet context.')
  }
  if (
    quote.copies !== 1 ||
    quote.withCDN !== false ||
    quote.tokenDecimals !== 18 ||
    quote.tokenSymbol !== 'USDFC'
  ) {
    throw uploadError('the quote is not for one supported prepared CAR.')
  }
  assertUnsigned(quote.depositNeeded, 'deposit')
  assertUnsigned(quote.fees.createDataSetFee, 'data-set fee')
  assertUnsigned(quote.fees.addPiecesFee, 'piece fee')
  assertUnsigned(quote.fees.total, 'total fee')
  assertUnsigned(quote.lockups.lifecycleLockup, 'lifecycle lockup')
  assertUnsigned(quote.lockups.reserveReplenishment, 'reserve lockup')
  assertUnsigned(quote.lockups.streamingLockup, 'streaming lockup')
  assertUnsigned(quote.lockups.cdnLockup, 'CDN lockup')
  assertUnsigned(quote.lockups.cacheMissLockup, 'cache-miss lockup')
  assertUnsigned(quote.lockups.total, 'total lockup')
  assertUnsigned(quote.lockups.rateDeltaPerEpoch, 'lockup rate')
  assertUnsigned(quote.rates.perEpoch, 'per-epoch rate')
  assertUnsigned(quote.rates.perMonth, 'monthly rate')
  if (
    quote.fees.total !==
      quote.fees.createDataSetFee + quote.fees.addPiecesFee ||
    quote.lockups.total !==
      quote.lockups.lifecycleLockup +
        quote.lockups.reserveReplenishment +
        quote.lockups.streamingLockup +
        quote.lockups.cdnLockup +
        quote.lockups.cacheMissLockup ||
    quote.ready !== (quote.depositNeeded === 0n && !quote.needsServiceApproval)
  ) {
    throw uploadError('the quote is internally inconsistent.')
  }
  if (!quote.ready) {
    throw uploadError('the Filecoin Pay account is not ready for this upload.')
  }
  return quoteFingerprint(quote)
}
export async function planFilecoinStorageUpload(
  prepared: PreparedMediaCar,
  quote: FilecoinStorageQuote,
  providerId: bigint,
  expectedAccount: Address,
  expectedChainId: bigint,
  signal?: AbortSignal,
): Promise<FilecoinStorageUploadPlan> {
  let account: Address
  try {
    account = getAddress(expectedAccount)
  } catch (cause) {
    throw uploadError('the expected wallet account is invalid.', { cause })
  }
  const network = getFilecoinStorageNetwork(expectedChainId)
  if (!network) {
    throw uploadError(`chain ${expectedChainId.toString()} is unsupported.`)
  }
  if (
    typeof providerId !== 'bigint' ||
    providerId <= 0n ||
    providerId > maxUint256
  ) {
    throw uploadError('the selected provider ID is invalid.')
  }
  const snapshot = await validatePreparedMediaCar(prepared, { signal })
  const reviewedQuote = validateReadyQuote(
    quote,
    account,
    expectedChainId,
    snapshot.carBytes.byteLength,
  )
  signal?.throwIfAborted()
  const pieceCid = await calculatePieceCid(snapshot.carBytes)
  signal?.throwIfAborted()
  const uploadId = bytesToHex(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  )
  return Object.freeze({
    account,
    carBytes: snapshot.carBytes,
    chainId: expectedChainId,
    mediaCid: snapshot.mediaCid.text,
    network: Object.freeze({
      ...network,
      contracts: Object.freeze({ ...network.contracts }),
    }),
    piece: Object.freeze({
      bytes: bytesToHex(pieceCid.bytes),
      paddedSize: pieceCid.paddedSize,
      size: pieceCid.size,
      text: pieceCid.toString(),
    }),
    providerId,
    quoteFingerprint: reviewedQuote,
    uploadId,
  })
}
function normalizeServiceUrl(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw uploadError('the provider returned an invalid service URL.')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw uploadError('the provider returned an invalid service URL.', {
      cause,
    })
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw uploadError(
      'the provider service URL must be credential-free HTTPS without a query or fragment.',
    )
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  const normalized = url.toString()
  if (normalized.length > 2_048) {
    throw uploadError('the provider returned an invalid service URL.')
  }
  return normalized
}
function normalizeProvider(
  value: ReturnType<typeof parsePDPProvider>,
  plan: FilecoinStorageUploadPlan,
) {
  if (!value || typeof value !== 'object') {
    throw uploadError('the registry returned invalid provider details.')
  }
  if (value.id !== plan.providerId || value.isActive !== true) {
    throw uploadError('the selected provider is unavailable.')
  }
  if (value.pdp.ipniIpfs !== true) {
    throw uploadError('the selected provider does not advertise IPFS indexing.')
  }
  const serviceProvider = parseAddress(value.serviceProvider, 'service account')
  if (
    !sameAddress(parseAddress(value.payee, 'provider payee'), serviceProvider)
  ) {
    throw uploadError('the provider payee must be its service account.')
  }
  // FWSS fixes the payment token in the preflighted contract graph. Current
  // provider registrations may use the zero-address sentinel for this
  // informational capability, so only its encoding is checked here.
  parseAddress(value.pdp.paymentTokenAddress, 'provider payment token')
  if (
    typeof value.pdp.minPieceSizeInBytes !== 'bigint' ||
    typeof value.pdp.maxPieceSizeInBytes !== 'bigint' ||
    value.pdp.minPieceSizeInBytes < 0n ||
    value.pdp.maxPieceSizeInBytes < value.pdp.minPieceSizeInBytes ||
    value.pdp.maxPieceSizeInBytes > maxUint256 ||
    BigInt(plan.carBytes.byteLength) < value.pdp.minPieceSizeInBytes ||
    BigInt(plan.carBytes.byteLength) > value.pdp.maxPieceSizeInBytes
  ) {
    throw uploadError('the prepared CAR is outside the provider size range.')
  }
  return Object.freeze({
    id: plan.providerId,
    serviceProvider,
    serviceUrl: normalizeServiceUrl(value.pdp.serviceURL),
  })
}
function normalizePiece(
  value: FilecoinStorageUploadPiece,
  plan: FilecoinStorageUploadPlan,
) {
  if (
    !value ||
    typeof value !== 'object' ||
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength === 0 ||
    value.bytes.byteLength > 128 ||
    !Number.isSafeInteger(value.size) ||
    value.size !== plan.carBytes.byteLength ||
    typeof value.paddedSize !== 'bigint' ||
    typeof value.text !== 'string' ||
    value.text.length === 0 ||
    value.text.length > 256
  ) {
    throw uploadError('the provider returned an invalid PieceCID result.')
  }
  let cid: ReturnType<typeof parsePieceCid>
  try {
    cid = parsePieceCid(value.bytes)
  } catch (cause) {
    throw uploadError('the provider returned an invalid PieceCID result.', {
      cause,
    })
  }
  if (
    cid.toString() !== value.text ||
    bytesToHex(cid.bytes).toLowerCase() !== plan.piece.bytes.toLowerCase() ||
    value.paddedSize !== plan.piece.paddedSize ||
    value.size !== plan.piece.size ||
    value.text !== plan.piece.text
  ) {
    throw uploadError(
      'the provider returned a PieceCID that does not match the uploaded CAR.',
    )
  }
  return Object.freeze({
    bytes: bytesToHex(cid.bytes),
    paddedSize: value.paddedSize,
    size: value.size,
    text: cid.toString(),
  })
}
function makeCheckpoint(
  plan: FilecoinStorageUploadPlan,
  provider: ReturnType<typeof normalizeProvider>,
  piece: ReturnType<typeof normalizePiece>,
): FilecoinStorageUploadCheckpoint {
  return Object.freeze({
    account: plan.account,
    carByteLength: plan.carBytes.byteLength,
    chainId: plan.chainId,
    ipfsIndexingRequested: true,
    mediaCid: plan.mediaCid,
    piece,
    provider: Object.freeze({
      id: provider.id,
      serviceProvider: provider.serviceProvider,
      serviceUrl: provider.serviceUrl,
    }),
    uploadId: plan.uploadId,
    withCDN: false,
  })
}
function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const received = Object.keys(value).sort()
  return (
    received.length === expected.length &&
    [...expected].sort().every((key, index) => received[index] === key)
  )
}
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw uploadError(`the adapter produced invalid ${label}.`)
  }
  return value as Record<string, unknown>
}
function exactTypedFields(
  value: unknown,
  expected: readonly { readonly name: string; readonly type: string }[],
) {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  return expected.every((field, index) => {
    const received = value[index]
    return (
      typeof received === 'object' &&
      received !== null &&
      !Array.isArray(received) &&
      exactKeys(received as Record<string, unknown>, ['name', 'type']) &&
      (received as Record<string, unknown>).name === field.name &&
      (received as Record<string, unknown>).type === field.type
    )
  })
}
function validateTypes(value: unknown) {
  const types = asRecord(value, 'storage authorization types')
  if (
    !exactKeys(types, Object.keys(EIP712_FIELDS)) ||
    !Object.entries(EIP712_FIELDS).every(([name, fields]) =>
      exactTypedFields(types[name], fields),
    )
  ) {
    throw uploadError('the adapter requested unexpected authorization types.')
  }
}
function validateDomain(value: unknown, plan: FilecoinStorageUploadPlan) {
  const domain = asRecord(value, 'storage authorization domain')
  if (
    !exactKeys(domain, ['chainId', 'name', 'verifyingContract', 'version']) ||
    domain.name !== STORAGE_DOMAIN_NAME ||
    domain.version !== STORAGE_DOMAIN_VERSION ||
    parseQuantity(domain.chainId, 'authorization chain') !== plan.chainId ||
    !sameAddress(
      parseAddress(domain.verifyingContract, 'authorization contract'),
      plan.network.contracts.fwss,
    )
  ) {
    throw uploadError('the adapter changed the storage authorization domain.')
  }
}
function exactMetadata(
  value: unknown,
  expected: readonly { key: string; value: string }[],
) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((entry, index) => {
      const candidate = value[index]
      return (
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        exactKeys(candidate as Record<string, unknown>, ['key', 'value']) &&
        (candidate as Record<string, unknown>).key === entry.key &&
        (candidate as Record<string, unknown>).value === entry.value
      )
    })
  )
}
function dataSetMetadataEntries(uploadId: Hex) {
  const { source, withIPFSIndexing } = FILECOIN_STORAGE_DATA_SET_METADATA
  return [
    { key: UPLOAD_METADATA_KEY, value: uploadId },
    { key: 'source', value: source },
    { key: 'withIPFSIndexing', value: withIPFSIndexing },
  ] as const
}
function parseTypedRequest(request: ProviderRequest, account: Address) {
  if (!Array.isArray(request.params) || request.params.length !== 2) {
    throw uploadError('the adapter produced invalid authorization parameters.')
  }
  if (
    !sameAddress(
      parseAddress(request.params[0], 'authorization signer'),
      account,
    )
  ) {
    throw uploadError('the adapter selected an unexpected signer.')
  }
  const encoded = request.params[1]
  if (typeof encoded !== 'string' || encoded.length > 50_000) {
    throw uploadError('the adapter produced invalid authorization data.')
  }
  let typedData: Record<string, unknown>
  try {
    typedData = asRecord(JSON.parse(encoded), 'storage authorization data')
  } catch (cause) {
    if (cause instanceof FilecoinStorageUploadError) throw cause
    throw uploadError('the adapter produced invalid authorization data.', {
      cause,
    })
  }
  if (!exactKeys(typedData, ['domain', 'message', 'primaryType', 'types'])) {
    throw uploadError('the adapter produced invalid authorization data.')
  }
  return { encoded, typedData }
}
function validateCreateAuthorization(
  request: ProviderRequest,
  plan: FilecoinStorageUploadPlan,
  provider: FilecoinStorageUploadCheckpoint['provider'],
) {
  const parsed = parseTypedRequest(request, plan.account)
  const { typedData } = parsed
  validateDomain(typedData.domain, plan)
  validateTypes(typedData.types)
  const message = asRecord(typedData.message, 'CreateDataSet message')
  if (
    typedData.primaryType !== 'CreateDataSet' ||
    !exactKeys(message, ['clientDataSetId', 'metadata', 'payee']) ||
    !sameAddress(
      parseAddress(message.payee, 'data-set payee'),
      provider.serviceProvider,
    ) ||
    !exactMetadata(message.metadata, dataSetMetadataEntries(plan.uploadId))
  ) {
    throw uploadError('the adapter changed the data-set authorization terms.')
  }
  return {
    clientDataSetId: parseQuantity(
      message.clientDataSetId,
      'client data-set ID',
    ),
    request: {
      method: 'eth_signTypedData_v4',
      params: [plan.account, parsed.encoded],
    } satisfies ProviderRequest,
    typedData,
  }
}
function validateAddPiecesAuthorization(
  request: ProviderRequest,
  plan: FilecoinStorageUploadPlan,
  checkpoint: FilecoinStorageUploadCheckpoint,
  clientDataSetId: bigint,
) {
  const parsed = parseTypedRequest(request, plan.account)
  const { typedData } = parsed
  validateDomain(typedData.domain, plan)
  validateTypes(typedData.types)
  const message = asRecord(typedData.message, 'AddPieces message')
  const pieceData = message.pieceData
  const pieceMetadata = message.pieceMetadata
  const piece =
    Array.isArray(pieceData) && pieceData.length === 1
      ? asRecord(pieceData[0], 'piece data')
      : undefined
  const metadata =
    Array.isArray(pieceMetadata) && pieceMetadata.length === 1
      ? asRecord(pieceMetadata[0], 'piece metadata')
      : undefined
  if (
    typedData.primaryType !== 'AddPieces' ||
    !exactKeys(message, [
      'clientDataSetId',
      'nonce',
      'pieceData',
      'pieceMetadata',
    ]) ||
    parseQuantity(message.clientDataSetId, 'client data-set ID') !==
      clientDataSetId ||
    !piece ||
    !exactKeys(piece, ['data']) ||
    parseHex(piece.data, 'authorized PieceCID', 128).toLowerCase() !==
      checkpoint.piece.bytes.toLowerCase() ||
    !metadata ||
    !exactKeys(metadata, ['metadata', 'pieceIndex']) ||
    parseQuantity(metadata.pieceIndex, 'piece index') !== 0n ||
    !exactMetadata(metadata.metadata, [
      { key: PIECE_METADATA_KEY, value: checkpoint.mediaCid },
      { key: UPLOAD_METADATA_KEY, value: checkpoint.uploadId },
    ])
  ) {
    throw uploadError('the adapter changed the piece authorization terms.')
  }
  parseQuantity(message.nonce, 'piece authorization nonce')
  return {
    request: {
      method: 'eth_signTypedData_v4',
      params: [plan.account, parsed.encoded],
    } satisfies ProviderRequest,
    typedData,
  }
}
function requestParams(request: ProviderRequest, label: string) {
  if (!Array.isArray(request.params)) {
    throw uploadError(`the adapter produced invalid ${label} parameters.`)
  }
  return request.params
}
function validateReadCall(
  request: ProviderRequest,
  plan: FilecoinStorageUploadPlan,
) {
  const params = requestParams(request, 'contract read')
  if (params.length < 1 || params.length > 2) {
    throw uploadError('the adapter produced invalid contract-read parameters.')
  }
  const call = asRecord(params[0], 'contract read')
  if (!exactKeys(call, ['data', 'to'])) {
    throw uploadError('the adapter produced an unexpected contract read.')
  }
  if (params[1] !== undefined && params[1] !== 'latest') {
    throw uploadError('the adapter selected a stale contract-read block.')
  }
  const target = parseAddress(call.to, 'contract-read target')
  const data = parseHex(call.data, 'contract-read data', 4_096)
  let kind: 'approval' | 'provider' | undefined
  try {
    if (sameAddress(target, plan.network.contracts.serviceProviderRegistry)) {
      const decoded = decodeFunctionData({ abi: PROVIDER_READ_ABI, data })
      if (
        decoded.functionName === 'getProviderWithProduct' &&
        decoded.args[0] === plan.providerId &&
        BigInt(decoded.args[1]) === PDP_PRODUCT_TYPE
      ) {
        kind = 'provider'
      }
    } else if (sameAddress(target, plan.network.contracts.fwssView)) {
      const decoded = decodeFunctionData({ abi: APPROVAL_READ_ABI, data })
      if (
        decoded.functionName === 'isProviderApproved' &&
        decoded.args[0] === plan.providerId
      ) {
        kind = 'approval'
      }
    }
  } catch {
    kind = undefined
  }
  if (!kind) {
    throw uploadError('the adapter requested an unexpected contract read.')
  }
  return {
    kind,
    request: {
      method: 'eth_call',
      params: [{ data, to: target }, 'latest'],
    } satisfies ProviderRequest,
  }
}
function authenticateProviderRead(
  value: unknown,
  plan: FilecoinStorageUploadPlan,
) {
  const data = parseHex(value, 'provider-registry response', 16_384)
  try {
    const decoded = decodeFunctionResult({
      abi: PROVIDER_READ_ABI,
      data,
      functionName: 'getProviderWithProduct',
    })
    if (!hasActivePDPProduct(decoded)) {
      throw uploadError('the selected provider has no active PDP product.')
    }
    return normalizeProvider(parsePDPProvider(decoded), plan)
  } catch (cause) {
    if (cause instanceof FilecoinStorageUploadError) throw cause
    throw uploadError('the wallet returned invalid provider-registry data.', {
      cause,
    })
  }
}
function authenticateApprovalRead(value: unknown) {
  const data = parseHex(value, 'provider-approval response', 32)
  try {
    if (
      decodeFunctionResult({
        abi: APPROVAL_READ_ABI,
        data,
        functionName: 'isProviderApproved',
      }) !== true
    ) {
      throw uploadError('the selected provider is not approved for storage.')
    }
  } catch (cause) {
    if (cause instanceof FilecoinStorageUploadError) throw cause
    throw uploadError('the wallet returned invalid provider-approval data.', {
      cause,
    })
  }
}
const executeSynapseUpload: FilecoinStorageUploadExecutor = async ({
  authorizeCommit,
  onStored,
  onSubmitted,
  plan,
  reportProgress,
  request,
  signal,
}) => {
  const [{ Synapse, calibration, mainnet }, { StorageContext }, warmStorage] =
    await Promise.all([
      import('@filoz/synapse-sdk'),
      import('@filoz/synapse-sdk/storage'),
      import('@filoz/synapse-sdk/warm-storage'),
    ])
  const binding = bindFilecoinStorageSynapseChain(plan.chainId, {
    calibration,
    mainnet,
  })
  if (!binding) {
    throw uploadError(`chain ${plan.chainId.toString()} is unsupported.`)
  }
  const transport = custom({ request }, { retryCount: 0 })
  const synapse = Synapse.create({
    account: plan.account,
    chain: binding.chain,
    pieceBatching: false,
    source: 'lifeinvader',
    transport,
    withCDN: false,
  })
  const warmStorageService = new warmStorage.WarmStorageService({
    client: synapse.client,
    readClient: synapse.readClient,
  })
  const [provider, approved] = await Promise.all([
    synapse.providers.getProvider({ providerId: plan.providerId }),
    warmStorageService.isProviderIdApproved({ providerId: plan.providerId }),
  ])
  if (!provider || !approved) {
    throw uploadError('the selected provider is not registered and approved.')
  }
  const context = new StorageContext({
    dataSetId: undefined,
    dataSetMetadata: {
      [UPLOAD_METADATA_KEY]: plan.uploadId,
      ...FILECOIN_STORAGE_DATA_SET_METADATA,
    },
    options: { withCDN: false },
    provider,
    synapse,
    warmStorageService,
  })
  const stored = await context.store(plan.carBytes, {
    onProgress: reportProgress,
    pieceCid: parsePieceCid(plan.piece.bytes),
    signal,
  })
  await onStored({
    bytes: stored.pieceCid.bytes,
    paddedSize: stored.pieceCid.paddedSize,
    size: stored.size,
    text: stored.pieceCid.toString(),
  })
  const pieces = [
    {
      pieceCid: stored.pieceCid,
      pieceMetadata: {
        [PIECE_METADATA_KEY]: plan.mediaCid,
        [UPLOAD_METADATA_KEY]: plan.uploadId,
      },
    },
  ]
  const extraData = await context.presignForCommit(pieces)
  await authorizeCommit()
  const committed = await context.commit({
    extraData,
    onSubmitted,
    pieces,
  })
  return {
    ...(committed.confirmedTxHash
      ? { confirmedTxHash: committed.confirmedTxHash }
      : {}),
    dataSetId: committed.dataSetId,
    isNewDataSet: committed.isNewDataSet,
    pieceIds: committed.pieceIds,
    txHash: committed.txHash,
  }
}
function parseLogQuantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x[0-9a-f]+$/i.test(value)
  ) {
    return undefined
  }
  return BigInt(value)
}
function canonicalEventLogs(
  logs: unknown,
  receipt: TransactionReceipt,
  network: FilecoinStorageNetwork,
  eventName: 'DataSetCreated' | 'PieceAdded',
) {
  if (!Array.isArray(logs) || logs.length > 1_000) {
    throw uploadError('the wallet returned invalid storage receipt logs.')
  }
  const topic = encodeEventTopics({ abi: STORAGE_EVENT_ABI, eventName })[0]
  const candidates = logs.filter((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false
    }
    const log = value as Record<string, unknown>
    return (
      typeof log.address === 'string' &&
      sameAddress(log.address, network.contracts.fwss) &&
      Array.isArray(log.topics) &&
      typeof log.topics[0] === 'string' &&
      log.topics[0].toLowerCase() === topic?.toLowerCase()
    )
  })
  return candidates.map((value) => {
    const log = value as Record<string, unknown>
    if (
      typeof log.blockHash !== 'string' ||
      log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      typeof log.transactionHash !== 'string' ||
      log.transactionHash.toLowerCase() !== receipt.hash.toLowerCase() ||
      parseLogQuantity(log.blockNumber) !== receipt.blockNumber ||
      !Array.isArray(log.topics) ||
      log.topics.length !== 3
    ) {
      throw uploadError(`the ${eventName} receipt log is not canonical.`)
    }
    const topics = log.topics.map((entry) =>
      parseHex(entry, `${eventName} topic`, 32),
    )
    if (topics.some((entry) => entry.length !== 66)) {
      throw uploadError(`the ${eventName} receipt topics are invalid.`)
    }
    const data = parseHex(log.data, `${eventName} event data`, 16_384)
    try {
      return decodeEventLog({
        abi: STORAGE_EVENT_ABI,
        data,
        eventName,
        strict: true,
        topics: topics as [Hex, ...Hex[]],
      })
    } catch (cause) {
      throw uploadError(`the ${eventName} receipt log is invalid.`, { cause })
    }
  })
}
export function assertFilecoinStorageUploadReceipt(
  logs: unknown,
  receipt: TransactionReceipt,
  checkpoint: FilecoinStorageUploadCheckpoint,
): FilecoinStorageUploadEvents {
  const network = getFilecoinStorageNetwork(checkpoint.chainId)
  if (!network) throw uploadError('the checkpoint chain is unsupported.')
  const dataSetLogs = canonicalEventLogs(
    logs,
    receipt,
    network,
    'DataSetCreated',
  )
  const pieceLogs = canonicalEventLogs(logs, receipt, network, 'PieceAdded')
  if (dataSetLogs.length !== 1 || pieceLogs.length > 1) {
    throw uploadError('the receipt created an unexpected number of records.')
  }
  const dataSetArgs = dataSetLogs[0]?.args as
    | {
        cacheMissRailId: bigint
        cdnRailId: bigint
        dataSetId: bigint
        metadataKeys: readonly string[]
        metadataValues: readonly string[]
        payee: Address
        payer: Address
        providerId: bigint
        serviceProvider: Address
      }
    | undefined
  const pieceArgs = pieceLogs[0]?.args as
    | {
        dataSetId: bigint
        keys: readonly string[]
        pieceCid: { data: Hex }
        pieceId: bigint
        values: readonly string[]
      }
    | undefined
  if (!dataSetArgs) {
    throw uploadError('the receipt did not expose storage event arguments.')
  }
  const expectedMetadata = dataSetMetadataEntries(checkpoint.uploadId)
  if (
    dataSetArgs.providerId !== checkpoint.provider.id ||
    dataSetArgs.cacheMissRailId !== 0n ||
    dataSetArgs.cdnRailId !== 0n ||
    !sameAddress(dataSetArgs.payer, checkpoint.account) ||
    !sameAddress(
      dataSetArgs.serviceProvider,
      checkpoint.provider.serviceProvider,
    ) ||
    !sameAddress(dataSetArgs.payee, checkpoint.provider.serviceProvider) ||
    dataSetArgs.metadataKeys.length !== expectedMetadata.length ||
    dataSetArgs.metadataValues.length !== expectedMetadata.length ||
    expectedMetadata.some(
      (entry, index) =>
        dataSetArgs.metadataKeys[index] !== entry.key ||
        dataSetArgs.metadataValues[index] !== entry.value,
    )
  ) {
    throw uploadError('the data-set event changed the authorized terms.')
  }
  if (!pieceArgs) {
    return { dataSetId: dataSetArgs.dataSetId, kind: 'data-set-created' }
  }
  if (
    pieceArgs.dataSetId !== dataSetArgs.dataSetId ||
    pieceArgs.pieceCid.data.toLowerCase() !==
      checkpoint.piece.bytes.toLowerCase() ||
    pieceArgs.keys.length !== 2 ||
    pieceArgs.keys[0] !== PIECE_METADATA_KEY ||
    pieceArgs.keys[1] !== UPLOAD_METADATA_KEY ||
    pieceArgs.values.length !== 2 ||
    pieceArgs.values[0] !== checkpoint.mediaCid ||
    pieceArgs.values[1] !== checkpoint.uploadId
  ) {
    throw uploadError('the piece event changed the authorized terms.')
  }
  return {
    dataSetId: dataSetArgs.dataSetId,
    kind: 'piece-added',
    pieceId: pieceArgs.pieceId,
  }
}
function validateReceiptTiming(
  options: Pick<
    FilecoinStorageUploadOptions,
    'pollIntervalMs' | 'receiptTimeoutMs'
  >,
) {
  const receiptTimeoutMs =
    options.receiptTimeoutMs ?? FILECOIN_STORAGE_UPLOAD_RECEIPT_TIMEOUT_MS
  if (!validTimeout(receiptTimeoutMs, 600_000)) {
    throw uploadError('the receipt timeout is invalid.')
  }
  if (
    options.pollIntervalMs !== undefined &&
    !validTimeout(options.pollIntervalMs, 60_000)
  ) {
    throw uploadError('the receipt polling interval is invalid.')
  }
  return receiptTimeoutMs
}
export function normalizeFilecoinStorageUploadCheckpoint(
  value: FilecoinStorageUploadCheckpoint,
  expectedAccount: Address,
  expectedChainId: bigint,
) {
  const network = getFilecoinStorageNetwork(expectedChainId)
  if (!network) {
    throw uploadError(`chain ${expectedChainId.toString()} is unsupported.`)
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !value.provider ||
    typeof value.provider !== 'object' ||
    !value.piece ||
    typeof value.piece !== 'object'
  ) {
    throw uploadError('the recovery checkpoint is invalid.')
  }
  const account = parseAddress(value?.account, 'checkpoint account')
  if (
    !sameAddress(account, expectedAccount) ||
    value.chainId !== expectedChainId ||
    value.withCDN !== false ||
    value.ipfsIndexingRequested !== true ||
    !Number.isSafeInteger(value.carByteLength) ||
    value.carByteLength < 127 ||
    value.carByteLength > MAX_PAID_MEDIA_CAR_BYTES
  ) {
    throw uploadError('the checkpoint belongs to a different upload context.')
  }
  let mediaCid: string
  try {
    const parsed = parseMediaCid(value.mediaCid)
    if (!parsed || parsed.text !== value.mediaCid) {
      throw new Error('media CID is not canonical')
    }
    mediaCid = parsed.text
  } catch (cause) {
    throw uploadError('the checkpoint has an invalid media CID.', { cause })
  }
  const provider = Object.freeze({
    id: value.provider.id,
    serviceProvider: parseAddress(
      value.provider.serviceProvider,
      'checkpoint provider',
    ),
    serviceUrl: normalizeServiceUrl(value.provider.serviceUrl),
  })
  if (
    typeof provider.id !== 'bigint' ||
    provider.id <= 0n ||
    provider.id > maxUint256
  ) {
    throw uploadError('the checkpoint provider ID is invalid.')
  }
  const pieceBytes = parseHex(value.piece.bytes, 'checkpoint PieceCID', 128)
  const uploadId = parseHex(value.uploadId, 'checkpoint upload ID', 32)
  let pieceCid: ReturnType<typeof parsePieceCid>
  try {
    pieceCid = parsePieceCid(pieceBytes)
  } catch (cause) {
    throw uploadError('the checkpoint PieceCID is invalid.', { cause })
  }
  if (
    uploadId.length !== 66 ||
    pieceCid.toString() !== value.piece.text ||
    !Number.isSafeInteger(value.piece.size) ||
    value.piece.size !== value.carByteLength ||
    pieceCid.size !== value.piece.size ||
    typeof value.piece.paddedSize !== 'bigint' ||
    pieceCid.paddedSize !== value.piece.paddedSize
  ) {
    throw uploadError('the checkpoint PieceCID details are invalid.')
  }
  return Object.freeze({
    account,
    carByteLength: value.carByteLength,
    chainId: expectedChainId,
    ipfsIndexingRequested: true as const,
    mediaCid,
    piece: Object.freeze({
      bytes: bytesToHex(pieceCid.bytes),
      paddedSize: value.piece.paddedSize,
      size: value.piece.size,
      text: pieceCid.toString(),
    }),
    provider,
    uploadId,
    withCDN: false as const,
  })
}
async function waitForUploadReceipt(
  provider: Eip1193Provider,
  hash: Hash,
  checkpoint: FilecoinStorageUploadCheckpoint,
  guard: Awaited<ReturnType<typeof createTransactionGuard>>,
  options: Pick<
    FilecoinStorageUploadOptions,
    'pollIntervalMs' | 'receiptTimeoutMs' | 'signal'
  > & { deadline?: number },
): Promise<FilecoinStorageUploadReceipt> {
  let eventResult: FilecoinStorageUploadEvents | undefined
  const receipt = await waitForTransactionReceipt(provider, hash, {
    assertCurrentChain: guard.assertSubmission,
    assertReceiptLogs: (logs, candidate) => {
      eventResult = assertFilecoinStorageUploadReceipt(
        logs,
        candidate,
        checkpoint,
      )
    },
    assertUnchanged: guard.assertUnchanged,
    pollIntervalMs: options.pollIntervalMs,
    selectedChainId: checkpoint.chainId,
    signal: options.signal,
    deadline: options.deadline,
    timeoutMs:
      options.receiptTimeoutMs ?? FILECOIN_STORAGE_UPLOAD_RECEIPT_TIMEOUT_MS,
  })
  if (!eventResult) {
    throw uploadError('the canonical receipt was not authenticated.')
  }
  return { ...eventResult, receipt }
}
export async function checkFilecoinStorageUploadReceipt(
  provider: Eip1193Provider,
  hash: Hash,
  checkpoint: FilecoinStorageUploadCheckpoint,
  options: FilecoinStorageUploadReceiptOptions,
): Promise<FilecoinStorageUploadReceipt> {
  const receiptTimeoutMs = validateReceiptTiming(options)
  const deadline = Date.now() + receiptTimeoutMs
  let transactionHash: Hash
  let expectedAccount: Address
  try {
    transactionHash = parseTransactionHash(hash)
    expectedAccount = getAddress(options.expectedAccount)
  } catch (cause) {
    throw uploadError('the receipt recovery input is invalid.', { cause })
  }
  const normalized = normalizeFilecoinStorageUploadCheckpoint(
    checkpoint,
    expectedAccount,
    options.expectedChainId,
  )
  const guard = await createTransactionGuard(
    provider,
    normalized.account,
    normalized.chainId,
    options.signal,
    deadline,
  )
  try {
    return await waitForUploadReceipt(
      provider,
      transactionHash,
      normalized,
      guard,
      {
        deadline,
        pollIntervalMs: options.pollIntervalMs,
        receiptTimeoutMs,
        signal: options.signal,
      },
    )
  } finally {
    guard.release()
  }
}
export async function uploadFilecoinStorage(
  wallet: Eip1193Provider,
  prepared: PreparedMediaCar,
  quote: FilecoinStorageQuote,
  providerId: bigint,
  options: FilecoinStorageUploadOptions,
): Promise<FilecoinStorageUploadResult> {
  const plan = await planFilecoinStorageUpload(
    prepared,
    quote,
    providerId,
    options.expectedAccount,
    options.expectedChainId,
    options.signal,
  )
  const readTimeoutMs =
    options.readTimeoutMs ?? FILECOIN_STORAGE_UPLOAD_READ_TIMEOUT_MS
  const receiptTimeoutMs = validateReceiptTiming(options)
  if (!validTimeout(readTimeoutMs, 60_000)) {
    throw uploadError('the wallet-read timeout is invalid.')
  }
  const inspectionOptions: FilecoinStorageInspectionOptions = {
    expectedChainId: plan.chainId,
    signal: options.signal,
  }
  const inspection = await (options.inspectStorage ?? inspectFilecoinStorage)(
    wallet,
    inspectionOptions,
  )
  if (
    inspection.kind !== 'ready' ||
    !sameNetwork(inspection.network, plan.network)
  ) {
    throw uploadError('the pinned storage-contract graph is not ready.')
  }
  const guard = await createTransactionGuard(
    wallet,
    plan.account,
    plan.chainId,
    options.signal,
  )
  const operationController = new AbortController()
  const requestController = new AbortController()
  const abortRequests = () =>
    requestController.abort(operationController.signal.reason)
  operationController.signal.addEventListener('abort', abortRequests, {
    once: true,
  })
  const abortOperation = () => {
    if (!operationController.signal.aborted) {
      operationController.abort(
        new DOMException('The wallet context changed.', 'AbortError'),
      )
    }
  }
  const abortFromCaller = () =>
    operationController.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (operationController.signal.aborted) abortRequests()
  const removeProviderListener = wallet.removeListener?.bind(wallet)
  const contextListeners = ['accountsChanged', 'chainChanged', 'disconnect']
  const registeredContextListeners: string[] = []
  if (wallet.on && removeProviderListener) {
    try {
      for (const event of contextListeners) {
        // Record first because a nonstandard provider may attach and throw.
        registeredContextListeners.push(event)
        wallet.on(event, abortOperation)
      }
    } catch (error) {
      for (const event of registeredContextListeners) {
        try {
          removeProviderListener(event, abortOperation)
        } catch {
          // Preserve the listener-registration failure.
        }
      }
      options.signal?.removeEventListener('abort', abortFromCaller)
      guard.release()
      throw error
    }
  }
  let requestCount = 0
  let signatureCount = 0
  let signaturePending = false
  let clientDataSetId: bigint | undefined
  let authenticatedProvider: ReturnType<typeof normalizeProvider> | undefined
  let providerReadState: 'complete' | 'none' | 'pending' = 'none'
  let approvalReadState: 'complete' | 'none' | 'pending' = 'none'
  let checkpoint: FilecoinStorageUploadCheckpoint | undefined
  let checkpointNotification: Promise<void> | undefined
  let checkpointNotificationError: unknown
  let checkpointNotificationFailed = false
  let commitAuthorized = false
  let submittedHash: Hash | undefined
  let submissionNotification: Promise<void> | undefined
  let submissionNotificationError: unknown
  let submissionNotificationFailed = false
  let recoveryHash: Hash | undefined
  let submittedCount = 0
  let walletRejection: unknown
  let transportClosed = false
  let lastProgress = 0
  const pendingRequests = new Set<Promise<unknown>>()
  const authorizationCanBeSubmitted = () =>
    commitAuthorized || signatureCount > 0
  const criticalNotification = (
    start: () => PromiseLike<void> | void,
    failed: (error: unknown) => void,
  ) => {
    let notification: Promise<void>
    try {
      notification = Promise.resolve(start()).then(() => undefined)
    } catch (error) {
      notification = Promise.reject(error)
    }
    void notification.catch((error) => {
      failed(error)
      if (!operationController.signal.aborted) {
        operationController.abort(error)
      }
    })
    return notification
  }
  const awaitSubmissionNotification = async () => {
    const notification = submissionNotification
    if (!notification) return
    try {
      await beforeUploadAbort(() => notification, operationController.signal)
    } catch (error) {
      if (submissionNotificationFailed) throw submissionNotificationError
      throw error
    }
  }
  const assertTransportOpen = () => {
    if (transportClosed) {
      throw uploadError('the adapter used a closed upload transport.')
    }
  }
  const assertOperationActive = () => {
    if (operationController.signal.aborted) {
      throw uploadError('the upload was cancelled.', {
        cause: operationController.signal.reason,
      })
    }
  }
  const assertFreshQuote = async () => {
    const refreshed = await (options.quoteStorage ?? quoteFilecoinStorage)(
      wallet,
      plan.carBytes.byteLength,
      {
        expectedAccount: plan.account,
        expectedChainId: plan.chainId,
        signal: requestController.signal,
      },
    )
    assertTransportOpen()
    assertOperationActive()
    if (
      validateReadyQuote(
        refreshed,
        plan.account,
        plan.chainId,
        plan.carBytes.byteLength,
      ) !== plan.quoteFingerprint
    ) {
      throw uploadError('the storage quote changed before authorization.')
    }
  }
  const requestThroughTransport = async (request: ProviderRequest) => {
    assertTransportOpen()
    assertOperationActive()
    const method = (request as { method?: unknown } | null)?.method
    if (typeof method !== 'string') {
      throw uploadError('the adapter requested an invalid RPC method.')
    }
    requestCount += 1
    if (requestCount > MAX_FILECOIN_STORAGE_UPLOAD_RPC_REQUESTS) {
      throw uploadError('the adapter exceeded its wallet RPC request budget.')
    }
    if (
      ['eth_accounts', 'eth_blockNumber', 'eth_chainId', 'eth_call'].includes(
        method,
      )
    ) {
      const read =
        method === 'eth_call' ? validateReadCall(request, plan) : undefined
      if (read) {
        const state =
          read.kind === 'provider' ? providerReadState : approvalReadState
        if (state !== 'none') {
          throw uploadError('the adapter repeated a storage contract read.')
        }
        if (read.kind === 'provider') providerReadState = 'pending'
        else approvalReadState = 'pending'
      }
      const forwarded = read?.request ?? ({ method } satisfies ProviderRequest)
      if (
        method !== 'eth_call' &&
        request.params !== undefined &&
        (!Array.isArray(request.params) || request.params.length !== 0)
      ) {
        throw uploadError(`the adapter produced invalid ${method} parameters.`)
      }
      const result = await requestProviderBeforeDeadline(
        wallet,
        forwarded,
        Date.now() + readTimeoutMs,
        () => uploadError('a wallet read timed out.'),
        requestController.signal,
        () => uploadError('the upload was cancelled.'),
      )
      assertTransportOpen()
      assertOperationActive()
      if (read?.kind === 'provider') {
        authenticatedProvider = authenticateProviderRead(result, plan)
        assertOperationActive()
        providerReadState = 'complete'
      } else if (read?.kind === 'approval') {
        authenticateApprovalRead(result)
        approvalReadState = 'complete'
      }
      if (method === 'eth_chainId' && parseChainId(result) !== plan.chainId) {
        throw uploadError('the wallet chain changed during the upload.')
      }
      if (method === 'eth_accounts') {
        const account = parseAccounts(result)[0]
        if (!account || !sameAddress(account, plan.account)) {
          throw uploadError('the selected wallet account changed.')
        }
      }
      if (method === 'eth_blockNumber') {
        parseQuantity(result, 'wallet block number')
      }
      return result
    }
    if (method === 'eth_signTypedData_v4') {
      const ready = checkpointNotification
      if (
        !checkpoint ||
        !ready ||
        commitAuthorized ||
        signaturePending ||
        signatureCount >= 2
      ) {
        throw uploadError('the adapter requested an unexpected signature.')
      }
      signaturePending = true
      try {
        await beforeUploadAbort(() => ready, requestController.signal)
        assertTransportOpen()
        assertOperationActive()
        let authorization:
          | ReturnType<typeof validateCreateAuthorization>
          | ReturnType<typeof validateAddPiecesAuthorization>
        let nextClientDataSetId: bigint | undefined
        if (signatureCount === 0) {
          const validated = validateCreateAuthorization(
            request,
            plan,
            checkpoint.provider,
          )
          authorization = validated
          nextClientDataSetId = validated.clientDataSetId
        } else {
          if (clientDataSetId === undefined) {
            throw uploadError('the data-set authorization is missing.')
          }
          authorization = validateAddPiecesAuthorization(
            request,
            plan,
            checkpoint,
            clientDataSetId,
          )
        }
        if (signatureCount === 0) await assertFreshQuote()
        await guard.assertSubmission()
        assertTransportOpen()
        assertOperationActive()
        let signatureValue: unknown
        try {
          signatureValue = await beforeUploadAbort(
            () => wallet.request(authorization.request),
            requestController.signal,
          )
        } catch (error) {
          assertOperationActive()
          if (getRpcErrorCode(error) === 4001) walletRejection = error
          throw error
        }
        assertOperationActive()
        guard.assertUnchanged()
        assertTransportOpen()
        walletRejection = undefined
        await assertFreshQuote()
        const signature = parseHex(
          signatureValue,
          'wallet storage signature',
          65,
        )
        if (signature.length !== 132) {
          throw uploadError('the wallet returned an invalid storage signature.')
        }
        const signatureValid = await verifyTypedData({
          ...authorization.typedData,
          address: plan.account,
          signature,
        } as Parameters<typeof verifyTypedData>[0]).catch(() => false)
        assertOperationActive()
        guard.assertUnchanged()
        assertTransportOpen()
        if (!signatureValid) {
          throw uploadError(
            'the storage authorization was not signed by the selected account.',
          )
        }
        if (nextClientDataSetId !== undefined)
          clientDataSetId = nextClientDataSetId
        signatureCount += 1
        return signature
      } finally {
        signaturePending = false
      }
    }
    throw uploadError(
      `the adapter requested forbidden RPC method ${method.slice(0, 80)}.`,
    )
  }
  const request = (candidate: ProviderRequest) => {
    if (transportClosed) {
      const denied = Promise.reject(
        uploadError('the adapter used a closed upload transport.'),
      )
      void denied.catch(() => undefined)
      return denied
    }
    const pending = requestThroughTransport(candidate)
    pendingRequests.add(pending)
    void pending.then(
      () => pendingRequests.delete(pending),
      () => pendingRequests.delete(pending),
    )
    return pending
  }
  const closeTransport = async () => {
    transportClosed = true
    requestController.abort(uploadError('the upload transport closed.'))
    await Promise.allSettled([...pendingRequests])
  }
  const onStored = (value: FilecoinStorageUploadPiece) => {
    assertTransportOpen()
    assertOperationActive()
    if (
      providerReadState !== 'complete' ||
      approvalReadState !== 'complete' ||
      !authenticatedProvider
    ) {
      throw uploadError('the adapter used an unauthenticated provider.')
    }
    if (checkpoint || signaturePending || signatureCount !== 0) {
      throw uploadError('the adapter reported an unexpected stored piece.')
    }
    const storedPiece = normalizePiece(value, plan)
    const nextCheckpoint = makeCheckpoint(
      plan,
      authenticatedProvider,
      storedPiece,
    )
    checkpoint = nextCheckpoint
    checkpointNotification = criticalNotification(
      () => options.onStored?.(nextCheckpoint),
      (error) => {
        checkpointNotificationFailed = true
        checkpointNotificationError = error
      },
    )
    return checkpointNotification
  }
  const reportProgress = (bytesUploaded: number) => {
    assertTransportOpen()
    assertOperationActive()
    if (
      !authenticatedProvider ||
      providerReadState !== 'complete' ||
      approvalReadState !== 'complete' ||
      checkpoint ||
      !Number.isSafeInteger(bytesUploaded) ||
      bytesUploaded < lastProgress ||
      bytesUploaded > plan.carBytes.byteLength
    ) {
      throw uploadError('the adapter reported invalid upload progress.')
    }
    lastProgress = bytesUploaded
    options.onProgress?.(bytesUploaded, plan.carBytes.byteLength)
  }
  const authorizeCommit = async () => {
    assertTransportOpen()
    assertOperationActive()
    if (
      commitAuthorized ||
      !checkpoint ||
      signaturePending ||
      signatureCount !== 2 ||
      lastProgress !== plan.carBytes.byteLength
    ) {
      throw uploadError('the adapter attempted an incomplete storage commit.')
    }
    await guard.assertSubmission()
    assertTransportOpen()
    assertOperationActive()
    commitAuthorized = true
  }
  const onSubmitted = (value: Hash) => {
    assertTransportOpen()
    if (!authorizationCanBeSubmitted() || submittedCount !== 0) {
      throw uploadError('the provider reported an unexpected transaction.')
    }
    submittedCount += 1
    const nextHash = parseTransactionHash(value)
    submittedHash = nextHash
    recoveryHash = nextHash
    submissionNotificationFailed = false
    submissionNotificationError = undefined
    submissionNotification = criticalNotification(
      () => options.onSubmitted?.(nextHash),
      (error) => {
        submissionNotificationFailed = true
        submissionNotificationError = error
      },
    )
  }
  try {
    let executionResult: FilecoinStorageUploadExecutorResult
    try {
      try {
        executionResult = await beforeUploadAbort(
          () =>
            (options.executeUpload ?? executeSynapseUpload)({
              authorizeCommit,
              onStored,
              onSubmitted,
              plan,
              reportProgress,
              request,
              signal: operationController.signal,
            }),
          operationController.signal,
        )
      } finally {
        await closeTransport()
      }
    } catch (error) {
      let failure = checkpointNotificationFailed
        ? checkpointNotificationError
        : error
      if (submissionNotification) {
        try {
          await awaitSubmissionNotification()
        } catch (notificationError) {
          failure = notificationError
        }
      }
      if (walletRejection && !authorizationCanBeSubmitted())
        throw walletRejection
      try {
        guard.assertUnchanged()
      } catch (contextError) {
        if (!authorizationCanBeSubmitted()) throw contextError
      }
      if (authorizationCanBeSubmitted() && checkpoint) {
        throw new FilecoinStorageSubmissionUnknownError(
          failure,
          checkpoint,
          recoveryHash,
        )
      }
      if (failure instanceof FilecoinStorageUploadError) throw failure
      throw uploadError('the provider did not complete the upload.', {
        cause: failure,
      })
    }
    try {
      await awaitSubmissionNotification()
      if (
        !checkpoint ||
        !commitAuthorized ||
        signatureCount !== 2 ||
        submittedCount !== 1 ||
        !executionResult ||
        executionResult.isNewDataSet !== true ||
        !Array.isArray(executionResult.pieceIds) ||
        executionResult.pieceIds.length !== 1 ||
        typeof executionResult.dataSetId !== 'bigint' ||
        executionResult.dataSetId < 0n ||
        typeof executionResult.pieceIds[0] !== 'bigint' ||
        executionResult.pieceIds[0] < 0n
      ) {
        throw uploadError('the provider returned an invalid commit result.')
      }
      const initialHash = parseTransactionHash(executionResult.txHash)
      if (!submittedHash || !sameAddress(initialHash, submittedHash)) {
        throw uploadError('the provider returned a different transaction hash.')
      }
      const transactionHash = executionResult.confirmedTxHash
        ? parseTransactionHash(executionResult.confirmedTxHash)
        : initialHash
      if (transactionHash.toLowerCase() !== initialHash.toLowerCase()) {
        recoveryHash = transactionHash
        submissionNotificationFailed = false
        submissionNotificationError = undefined
        submissionNotification = criticalNotification(
          () => options.onSubmitted?.(transactionHash),
          (error) => {
            submissionNotificationFailed = true
            submissionNotificationError = error
          },
        )
        await awaitSubmissionNotification()
      }
      await guard.assertSubmission()
      const confirmed = await waitForUploadReceipt(
        wallet,
        transactionHash,
        checkpoint,
        guard,
        {
          pollIntervalMs: options.pollIntervalMs,
          receiptTimeoutMs,
          signal: operationController.signal,
        },
      )
      if (
        confirmed.kind !== 'piece-added' ||
        confirmed.dataSetId !== executionResult.dataSetId ||
        confirmed.pieceId !== executionResult.pieceIds[0]
      ) {
        throw uploadError('the provider result disagrees with the receipt.')
      }
      return Object.freeze({
        ...checkpoint,
        dataSetId: confirmed.dataSetId,
        initialTransactionHash: initialHash,
        pieceId: confirmed.pieceId,
        providerPieceUrl: new URL(
          `piece/${checkpoint.piece.text}`,
          checkpoint.provider.serviceUrl,
        ).toString(),
        receipt: confirmed.receipt,
        transactionHash,
      })
    } catch (error) {
      if (authorizationCanBeSubmitted() && checkpoint) {
        throw new FilecoinStorageSubmissionUnknownError(
          error,
          checkpoint,
          recoveryHash,
        )
      }
      throw error
    }
  } finally {
    transportClosed = true
    operationController.signal.removeEventListener('abort', abortRequests)
    if (wallet.on && removeProviderListener) {
      for (const event of registeredContextListeners) {
        try {
          removeProviderListener(event, abortOperation)
        } catch {
          // A nonstandard provider cleanup failure cannot change the outcome.
        }
      }
    }
    options.signal?.removeEventListener('abort', abortFromCaller)
    guard.release()
  }
}
