import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  isAddress,
  maxUint256,
  multicall3Abi,
  parseSignature,
  toFunctionSelector,
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
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import { bindFilecoinStorageSynapseChain } from './filecoin-storage-synapse'
import {
  createTransactionGuard,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
  type TransactionReceipt,
  type TransactionSubmitted,
} from './protocol'

export const FILECOIN_STORAGE_FUNDING_READ_TIMEOUT_MS = 15_000
export const FILECOIN_STORAGE_FUNDING_RECEIPT_TIMEOUT_MS = 120_000
export const MAX_FILECOIN_STORAGE_FUNDING_RPC_REQUESTS = 20

const FUNDING_ABI = [
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'depositWithPermit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      { name: 'operator', type: 'address' },
      { name: 'rateAllowance', type: 'uint256' },
      { name: 'lockupAllowance', type: 'uint256' },
      { name: 'maxLockupPeriod', type: 'uint256' },
    ],
    name: 'depositWithPermitAndApproveOperator',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
      { name: 'rateAllowance', type: 'uint256' },
      { name: 'lockupAllowance', type: 'uint256' },
      { name: 'maxLockupPeriod', type: 'uint256' },
    ],
    name: 'setOperatorApproval',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const FUNDING_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
    name: 'DepositRecorded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'operator', type: 'address' },
      { indexed: false, name: 'approved', type: 'bool' },
      { indexed: false, name: 'rateAllowance', type: 'uint256' },
      { indexed: false, name: 'lockupAllowance', type: 'uint256' },
      { indexed: false, name: 'maxLockupPeriod', type: 'uint256' },
    ],
    name: 'OperatorApprovalUpdated',
    type: 'event',
  },
] as const

type FundingKind = 'approve' | 'deposit' | 'deposit-and-approve'

export type FilecoinStorageFundingPlan = {
  account: Address
  chainId: bigint
  depositAmount: bigint
  includesApproval: boolean
  kind: FundingKind
  maxLockupPeriod: bigint
  network: FilecoinStorageNetwork
}

export type FilecoinStorageFundingExecutor = (input: {
  plan: FilecoinStorageFundingPlan
  request(request: ProviderRequest): Promise<unknown>
}) => Promise<unknown>

export type FilecoinStorageFundingOptions = {
  executeFunding?: FilecoinStorageFundingExecutor
  expectedAccount: Address
  expectedChainId: bigint
  inspectStorage?: typeof inspectFilecoinStorage
  onSubmitted?: TransactionSubmitted
  pollIntervalMs?: number
  readTimeoutMs?: number
  receiptTimeoutMs?: number
  signal?: AbortSignal
}

function fundingError(reason: string, options?: ErrorOptions) {
  return new Error(`Cannot fund Filecoin storage: ${reason}`, options)
}

function sameAddress(first: string, second: string) {
  return first.toLowerCase() === second.toLowerCase()
}

function assertNonNegative(
  value: unknown,
  label: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maxUint256) {
    throw fundingError(`the quote has an invalid ${label}.`)
  }
}

export function planFilecoinStorageFunding(
  quote: FilecoinStorageQuote,
  expectedAccount: Address,
  expectedChainId: bigint,
): FilecoinStorageFundingPlan {
  let account: Address
  try {
    account = getAddress(expectedAccount)
  } catch (cause) {
    throw fundingError('the expected wallet account is invalid.', { cause })
  }
  const network = getFilecoinStorageNetwork(expectedChainId)
  if (!network) {
    throw fundingError(`chain ${expectedChainId.toString()} is unsupported.`)
  }
  if (
    !sameAddress(quote.account, account) ||
    quote.chainId !== expectedChainId
  ) {
    throw fundingError('the quote belongs to a different wallet context.')
  }
  if (
    quote.copies !== 1 ||
    quote.withCDN !== false ||
    quote.tokenDecimals !== 18 ||
    quote.tokenSymbol !== 'USDFC' ||
    quote.dataSize < 127n ||
    quote.dataSize > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw fundingError('the quote is not for one supported prepared CAR.')
  }
  assertNonNegative(quote.depositNeeded, 'deposit')
  assertNonNegative(quote.fees.createDataSetFee, 'data-set fee')
  assertNonNegative(quote.fees.addPiecesFee, 'piece fee')
  assertNonNegative(quote.fees.total, 'total fee')
  assertNonNegative(quote.lockups.lifecycleLockup, 'lifecycle lockup')
  assertNonNegative(
    quote.lockups.reserveReplenishment,
    'reserve-replenishment lockup',
  )
  assertNonNegative(quote.lockups.streamingLockup, 'streaming lockup')
  assertNonNegative(quote.lockups.cdnLockup, 'CDN lockup')
  assertNonNegative(quote.lockups.cacheMissLockup, 'cache-miss lockup')
  assertNonNegative(quote.lockups.total, 'total lockup')
  assertNonNegative(quote.lockups.rateDeltaPerEpoch, 'lockup rate')
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
    throw fundingError('the quote is internally inconsistent.')
  }
  if (quote.ready) {
    throw fundingError('the Filecoin Pay account is already ready.')
  }
  if (
    quote.lockups.rateDeltaPerEpoch === 0n ||
    quote.lockups.streamingLockup === 0n ||
    quote.lockups.streamingLockup % quote.lockups.rateDeltaPerEpoch !== 0n
  ) {
    throw fundingError('the quote has an invalid lockup period.')
  }
  const maxLockupPeriod =
    quote.lockups.streamingLockup / quote.lockups.rateDeltaPerEpoch
  if (maxLockupPeriod === 0n) {
    throw fundingError('the quote has an invalid lockup period.')
  }
  const includesApproval = quote.needsServiceApproval
  const depositAmount = quote.depositNeeded
  const kind =
    depositAmount > 0n
      ? includesApproval
        ? 'deposit-and-approve'
        : 'deposit'
      : 'approve'
  return Object.freeze({
    account,
    chainId: expectedChainId,
    depositAmount,
    includesApproval,
    kind,
    maxLockupPeriod,
    network: Object.freeze({
      ...network,
      contracts: Object.freeze({ ...network.contracts }),
    }),
  })
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fundingError(`the wallet adapter produced invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

function requestParams(request: ProviderRequest, label: string) {
  if (!Array.isArray(request.params)) {
    throw fundingError(
      `the wallet adapter produced invalid ${label} parameters.`,
    )
  }
  return request.params
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw fundingError(`the wallet adapter produced an invalid ${label}.`)
  }
  return getAddress(value)
}

function parseHex(value: unknown, label: string, maximumBytes: number): Hex {
  if (
    typeof value !== 'string' ||
    value.length > maximumBytes * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw fundingError(`the wallet adapter produced invalid ${label}.`)
  }
  return value as Hex
}

function parseQuantity(value: unknown, label: string): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x[0-9a-f]+$/i.test(value)
  ) {
    throw fundingError(`the wallet adapter produced an invalid ${label}.`)
  }
  return BigInt(value)
}

function validateTransactionEnvelope(
  value: unknown,
  plan: FilecoinStorageFundingPlan,
) {
  const transaction = asRecord(value, 'transaction')
  const to = parseAddress(transaction.to, 'transaction target')
  const from = parseAddress(transaction.from, 'transaction sender')
  if (!sameAddress(to, plan.network.contracts.filecoinPay)) {
    throw fundingError('the wallet adapter targeted an unexpected contract.')
  }
  if (!sameAddress(from, plan.account)) {
    throw fundingError('the wallet adapter selected an unexpected sender.')
  }
  if (
    transaction.value !== undefined &&
    parseQuantity(transaction.value, 'transaction value') !== 0n
  ) {
    throw fundingError('the Filecoin Pay transaction tried to send native FIL.')
  }
  if (
    transaction.chainId !== undefined &&
    parseQuantity(transaction.chainId, 'transaction chain') !== plan.chainId
  ) {
    throw fundingError('the wallet adapter selected an unexpected chain.')
  }
  const data = parseHex(transaction.data, 'transaction data', 4_096)
  return {
    data,
    request: {
      method: 'eth_sendTransaction',
      params: [
        {
          chainId: `0x${plan.chainId.toString(16)}`,
          data,
          from: plan.account,
          to: plan.network.contracts.filecoinPay,
        },
      ],
    } satisfies ProviderRequest,
  }
}

function validateFundingCalldata(
  data: Hex,
  plan: FilecoinStorageFundingPlan,
  permitDeadline: bigint | undefined,
  permitSignature: Hex | undefined,
) {
  let decoded: ReturnType<typeof decodeFunctionData<typeof FUNDING_ABI>>
  try {
    decoded = decodeFunctionData({ abi: FUNDING_ABI, data })
  } catch (cause) {
    throw fundingError(
      'the wallet adapter produced unknown Filecoin Pay data.',
      {
        cause,
      },
    )
  }
  const args = decoded.args
  if (!args)
    throw fundingError('the Filecoin Pay transaction has no arguments.')

  if (plan.kind === 'approve') {
    if (
      decoded.functionName !== 'setOperatorApproval' ||
      !sameAddress(args[0] as Address, plan.network.contracts.usdfc) ||
      !sameAddress(args[1] as Address, plan.network.contracts.fwss) ||
      args[2] !== true ||
      args[3] !== maxUint256 ||
      args[4] !== maxUint256 ||
      args[5] !== plan.maxLockupPeriod
    ) {
      throw fundingError('the service-approval transaction changed its terms.')
    }
    return
  }

  const expectedFunction =
    plan.kind === 'deposit'
      ? 'depositWithPermit'
      : 'depositWithPermitAndApproveOperator'
  if (
    decoded.functionName !== expectedFunction ||
    !sameAddress(args[0] as Address, plan.network.contracts.usdfc) ||
    !sameAddress(args[1] as Address, plan.account) ||
    args[2] !== plan.depositAmount ||
    args[3] !== permitDeadline
  ) {
    throw fundingError('the deposit transaction changed its permit terms.')
  }
  if (!permitSignature) {
    throw fundingError('the deposit transaction is missing its signed permit.')
  }
  const signature = parseSignature(permitSignature)
  if (
    signature.v === undefined ||
    args[4] !== Number(signature.v) ||
    args[5].toLowerCase() !== signature.r.toLowerCase() ||
    args[6].toLowerCase() !== signature.s.toLowerCase()
  ) {
    throw fundingError('the deposit transaction changed its permit signature.')
  }
  if (
    plan.kind === 'deposit-and-approve' &&
    (!sameAddress(args[7] as Address, plan.network.contracts.fwss) ||
      args[8] !== maxUint256 ||
      args[9] !== maxUint256 ||
      args[10] !== plan.maxLockupPeriod)
  ) {
    throw fundingError(
      'the combined funding transaction changed its approval terms.',
    )
  }
}

function parseTypedData(value: unknown) {
  if (typeof value !== 'string' || value.length > 50_000) {
    throw fundingError('the wallet adapter produced invalid permit data.')
  }
  try {
    return asRecord(JSON.parse(value), 'permit data')
  } catch (cause) {
    throw fundingError('the wallet adapter produced invalid permit data.', {
      cause,
    })
  }
}

function typedQuantity(value: unknown, label: string): bigint {
  if (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))
  ) {
    const parsed = BigInt(value)
    if (parsed <= maxUint256) return parsed
  }
  throw fundingError(`the permit has an invalid ${label}.`)
}

function exactTypedFields(
  value: unknown,
  expected: readonly { name: string; type: string }[],
) {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  return expected.every((field, index) => {
    const received = value[index]
    return (
      typeof received === 'object' &&
      received !== null &&
      !Array.isArray(received) &&
      (received as Record<string, unknown>).name === field.name &&
      (received as Record<string, unknown>).type === field.type &&
      Object.keys(received).length === 2
    )
  })
}

function validatePermit(
  request: ProviderRequest,
  plan: FilecoinStorageFundingPlan,
): { deadline: bigint; request: ProviderRequest } {
  const params = requestParams(request, 'permit')
  if (params.length !== 2) {
    throw fundingError('the wallet adapter produced invalid permit parameters.')
  }
  const signer = parseAddress(params[0], 'permit signer')
  if (!sameAddress(signer, plan.account)) {
    throw fundingError('the permit selected an unexpected signer.')
  }
  const typedData = parseTypedData(params[1])
  const domain = asRecord(typedData.domain, 'permit domain')
  const message = asRecord(typedData.message, 'permit message')
  const types = asRecord(typedData.types, 'permit types')
  if (
    typedData.primaryType !== 'Permit' ||
    !exactTypedFields(types.Permit, [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ]) ||
    !exactTypedFields(types.EIP712Domain, [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ])
  ) {
    throw fundingError('the wallet adapter produced an unexpected permit type.')
  }
  if (
    typeof domain.name !== 'string' ||
    domain.name.length === 0 ||
    domain.name.length > 128 ||
    typeof domain.version !== 'string' ||
    domain.version.length === 0 ||
    domain.version.length > 32 ||
    typedQuantity(domain.chainId, 'chain') !== plan.chainId ||
    !sameAddress(
      parseAddress(domain.verifyingContract, 'permit token'),
      plan.network.contracts.usdfc,
    ) ||
    !sameAddress(parseAddress(message.owner, 'permit owner'), plan.account) ||
    !sameAddress(
      parseAddress(message.spender, 'permit spender'),
      plan.network.contracts.filecoinPay,
    ) ||
    typedQuantity(message.value, 'value') !== plan.depositAmount
  ) {
    throw fundingError('the wallet adapter changed the permit terms.')
  }
  typedQuantity(message.nonce, 'nonce')
  const deadline = typedQuantity(message.deadline, 'deadline')
  const now = BigInt(Math.floor(Date.now() / 1_000))
  if (deadline < now || deadline > now + 7_200n) {
    throw fundingError('the permit deadline is outside the allowed window.')
  }
  return {
    deadline,
    request: {
      method: 'eth_signTypedData_v4',
      params: [signer, params[1] as string],
    },
  }
}

function validateReadCall(
  request: ProviderRequest,
  plan: FilecoinStorageFundingPlan,
  permitDeadline: bigint | undefined,
  permitSignature: Hex | undefined,
) {
  const params = requestParams(request, 'contract read')
  if (params.length < 1 || params.length > 2) {
    throw fundingError(
      'the wallet adapter produced invalid contract-read parameters.',
    )
  }
  const call = asRecord(params[0], 'contract read')
  const to = parseAddress(call.to, 'contract-read target')
  const data = parseHex(call.data, 'contract-read data', 4_096)
  if (
    call.from !== undefined &&
    !sameAddress(parseAddress(call.from, 'contract-read sender'), plan.account)
  ) {
    throw fundingError('the wallet adapter selected an unexpected read sender.')
  }
  if (
    call.value !== undefined &&
    parseQuantity(call.value, 'contract-read value') !== 0n
  ) {
    throw fundingError('the wallet adapter simulated a native FIL transfer.')
  }
  if (params[1] !== undefined && params[1] !== 'latest') {
    throw fundingError('the wallet adapter selected a stale read block.')
  }
  const simulatedData = validatePinnedRead(
    to,
    data,
    plan,
    permitDeadline,
    permitSignature,
  )
  const snapshot: Record<string, unknown> = { data, to }
  if (call.from !== undefined) snapshot.from = plan.account
  if (call.value !== undefined) snapshot.value = '0x0'
  return {
    request: {
      method: 'eth_call',
      params: [snapshot, 'latest'],
    } satisfies ProviderRequest,
    simulatedData,
  }
}

function validatePinnedRead(
  to: Address,
  data: Hex,
  plan: FilecoinStorageFundingPlan,
  permitDeadline: bigint | undefined,
  permitSignature: Hex | undefined,
) {
  if (
    !Object.values(plan.network.contracts).some((address) =>
      sameAddress(address, to),
    )
  ) {
    throw fundingError('the wallet adapter read an unexpected contract.')
  }
  if (sameAddress(to, plan.network.contracts.multicall3)) {
    validateMulticallRead(data, plan, permitDeadline, permitSignature)
    return undefined
  }
  if (sameAddress(to, plan.network.contracts.filecoinPay)) {
    try {
      validateFundingCalldata(data, plan, permitDeadline, permitSignature)
      return data
    } catch (error) {
      if (data.slice(0, 10) === expectedFundingSelector(plan.kind)) throw error
    }
  }
  return undefined
}

function validateMulticallRead(
  data: Hex,
  plan: FilecoinStorageFundingPlan,
  permitDeadline: bigint | undefined,
  permitSignature: Hex | undefined,
) {
  let decoded: ReturnType<typeof decodeFunctionData<typeof multicall3Abi>>
  try {
    decoded = decodeFunctionData({ abi: multicall3Abi, data })
  } catch (cause) {
    throw fundingError('the wallet adapter produced invalid Multicall3 data.', {
      cause,
    })
  }
  if (decoded.functionName !== 'aggregate3' || !decoded.args) {
    throw fundingError(
      'the wallet adapter requested an unexpected Multicall3 read.',
    )
  }
  const calls = decoded.args[0]
  if (calls.length === 0 || calls.length > 32) {
    throw fundingError(
      'the wallet adapter produced an invalid Multicall3 batch.',
    )
  }
  for (const call of calls) {
    const target = parseAddress(call.target, 'Multicall3 target')
    if (sameAddress(target, plan.network.contracts.multicall3)) {
      throw fundingError('the wallet adapter nested a Multicall3 read.')
    }
    validatePinnedRead(
      target,
      parseHex(call.callData, 'Multicall3 call data', 4_096),
      plan,
      permitDeadline,
      permitSignature,
    )
  }
}

function expectedFundingSelector(kind: FundingKind) {
  const functionName =
    kind === 'approve'
      ? 'setOperatorApproval'
      : kind === 'deposit'
        ? 'depositWithPermit'
        : 'depositWithPermitAndApproveOperator'
  const item = FUNDING_ABI.find((entry) => entry.name === functionName)
  if (!item) throw fundingError('the funding ABI is incomplete.')
  const signature = `${item.name}(${item.inputs.map(({ type }) => type).join(',')})`
  return toFunctionSelector(signature)
}

function validTimeout(value: number, maximum: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function validateReceiptTiming(
  options: Pick<
    FilecoinStorageFundingOptions,
    'pollIntervalMs' | 'receiptTimeoutMs'
  >,
) {
  const receiptTimeoutMs =
    options.receiptTimeoutMs ?? FILECOIN_STORAGE_FUNDING_RECEIPT_TIMEOUT_MS
  if (!validTimeout(receiptTimeoutMs, 300_000)) {
    throw fundingError('the receipt timeout is invalid.')
  }
  if (
    options.pollIntervalMs !== undefined &&
    !validTimeout(options.pollIntervalMs, 60_000)
  ) {
    throw fundingError('the receipt polling interval is invalid.')
  }
  return receiptTimeoutMs
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

const executeSynapseFunding: FilecoinStorageFundingExecutor = async ({
  plan,
  request,
}) => {
  const { Synapse, calibration, mainnet } = await import('@filoz/synapse-sdk')
  const binding = bindFilecoinStorageSynapseChain(plan.chainId, {
    calibration,
    mainnet,
  })
  if (!binding) {
    throw fundingError(`chain ${plan.chainId.toString()} is unsupported.`)
  }
  const transport = custom(
    {
      request: ({ method, params }) =>
        request({
          method,
          ...(params === undefined
            ? {}
            : { params: params as readonly unknown[] | object }),
        }),
    },
    { retryCount: 0 },
  )
  const synapse = Synapse.create({
    account: plan.account,
    chain: binding.chain,
    pieceBatching: false,
    source: 'lifeinvader',
    transport,
    withCDN: false,
  })
  return await synapse.payments.fund({
    amount: plan.depositAmount,
    needsFwssMaxApproval: plan.includesApproval,
  })
}

function parseLogQuantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x[0-9a-f]+$/i.test(value)
  )
    return undefined
  return BigInt(value)
}

function matchesFundingLog(
  value: unknown,
  receipt: TransactionReceipt,
  plan: FilecoinStorageFundingPlan,
  topics: readonly Hex[],
  data: Hex,
) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const log = value as Record<string, unknown>
  if (
    typeof log.address !== 'string' ||
    !sameAddress(log.address, plan.network.contracts.filecoinPay) ||
    typeof log.blockHash !== 'string' ||
    log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof log.transactionHash !== 'string' ||
    log.transactionHash.toLowerCase() !== receipt.hash.toLowerCase() ||
    parseLogQuantity(log.blockNumber) !== receipt.blockNumber ||
    typeof log.data !== 'string' ||
    log.data.toLowerCase() !== data.toLowerCase() ||
    !Array.isArray(log.topics) ||
    log.topics.length !== topics.length
  ) {
    return false
  }
  const logTopics = log.topics as unknown[]
  return topics.every(
    (topic, index) =>
      typeof logTopics[index] === 'string' &&
      logTopics[index].toLowerCase() === topic.toLowerCase(),
  )
}

export function assertFilecoinStorageFundingReceipt(
  logs: unknown,
  receipt: TransactionReceipt,
  plan: FilecoinStorageFundingPlan,
) {
  if (!Array.isArray(logs) || logs.length > 1_000) {
    throw fundingError('the wallet returned invalid funding receipt logs.')
  }
  const expected: { data: Hex; label: string; topics: readonly Hex[] }[] = []
  if (plan.depositAmount > 0n) {
    expected.push({
      data: encodeAbiParameters(
        [{ name: 'amount', type: 'uint256' }],
        [plan.depositAmount],
      ),
      label: 'deposit',
      topics: encodeEventTopics({
        abi: FUNDING_EVENT_ABI,
        eventName: 'DepositRecorded',
        args: {
          from: plan.account,
          to: plan.account,
          token: plan.network.contracts.usdfc,
        },
      }) as unknown as readonly Hex[],
    })
  }
  if (plan.includesApproval) {
    expected.push({
      data: encodeAbiParameters(
        [
          { name: 'approved', type: 'bool' },
          { name: 'rateAllowance', type: 'uint256' },
          { name: 'lockupAllowance', type: 'uint256' },
          { name: 'maxLockupPeriod', type: 'uint256' },
        ],
        [true, maxUint256, maxUint256, plan.maxLockupPeriod],
      ),
      label: 'service approval',
      topics: encodeEventTopics({
        abi: FUNDING_EVENT_ABI,
        eventName: 'OperatorApprovalUpdated',
        args: {
          client: plan.account,
          operator: plan.network.contracts.fwss,
          token: plan.network.contracts.usdfc,
        },
      }) as unknown as readonly Hex[],
    })
  }
  for (const event of expected) {
    const matches = logs.filter((log) =>
      matchesFundingLog(log, receipt, plan, event.topics, event.data),
    )
    if (matches.length !== 1) {
      throw fundingError(
        `the receipt did not contain one exact ${event.label} event.`,
      )
    }
  }
}

async function waitForFundingReceipt(
  provider: Eip1193Provider,
  hash: Hash,
  plan: FilecoinStorageFundingPlan,
  guard: Awaited<ReturnType<typeof createTransactionGuard>>,
  options: Pick<
    FilecoinStorageFundingOptions,
    'pollIntervalMs' | 'receiptTimeoutMs'
  >,
) {
  return await waitForTransactionReceipt(provider, hash, {
    assertCurrentChain: guard.assertSubmission,
    assertReceiptLogs: (logs, receipt) =>
      assertFilecoinStorageFundingReceipt(logs, receipt, plan),
    assertUnchanged: guard.assertUnchanged,
    pollIntervalMs: options.pollIntervalMs,
    selectedChainId: plan.chainId,
    timeoutMs:
      options.receiptTimeoutMs ?? FILECOIN_STORAGE_FUNDING_RECEIPT_TIMEOUT_MS,
  })
}

export async function checkFilecoinStorageFundingReceipt(
  provider: Eip1193Provider,
  hash: Hash,
  quote: FilecoinStorageQuote,
  options: Omit<
    FilecoinStorageFundingOptions,
    | 'executeFunding'
    | 'inspectStorage'
    | 'onSubmitted'
    | 'readTimeoutMs'
    | 'signal'
  >,
) {
  const receiptTimeoutMs = validateReceiptTiming(options)
  let transactionHash: Hash
  try {
    transactionHash = parseTransactionHash(hash)
  } catch (cause) {
    throw fundingError('the transaction hash is invalid.', { cause })
  }
  const plan = planFilecoinStorageFunding(
    quote,
    options.expectedAccount,
    options.expectedChainId,
  )
  const guard = await createTransactionGuard(
    provider,
    plan.account,
    plan.chainId,
  )
  try {
    return await waitForFundingReceipt(provider, transactionHash, plan, guard, {
      pollIntervalMs: options.pollIntervalMs,
      receiptTimeoutMs,
    })
  } finally {
    guard.release()
  }
}

/**
 * Reverify the Filecoin deployment, constrain Synapse to one exact permit and
 * Filecoin Pay transaction, and authenticate its canonical receipt. This only
 * funds/approves the account; it does not upload or bind the CAR to a provider.
 */
export async function fundFilecoinStorage(
  provider: Eip1193Provider,
  quote: FilecoinStorageQuote,
  options: FilecoinStorageFundingOptions,
): Promise<TransactionReceipt> {
  const plan = planFilecoinStorageFunding(
    quote,
    options.expectedAccount,
    options.expectedChainId,
  )
  const readTimeoutMs =
    options.readTimeoutMs ?? FILECOIN_STORAGE_FUNDING_READ_TIMEOUT_MS
  const receiptTimeoutMs = validateReceiptTiming(options)
  if (!validTimeout(readTimeoutMs, 60_000)) {
    throw fundingError('the wallet-read timeout is invalid.')
  }
  const inspectionOptions: FilecoinStorageInspectionOptions = {
    expectedChainId: plan.chainId,
    signal: options.signal,
  }
  const inspection = await (options.inspectStorage ?? inspectFilecoinStorage)(
    provider,
    inspectionOptions,
  )
  if (
    inspection.kind !== 'ready' ||
    !sameNetwork(inspection.network, plan.network)
  ) {
    throw fundingError('the pinned storage-contract graph is not ready.')
  }

  const guard = await createTransactionGuard(
    provider,
    plan.account,
    plan.chainId,
  )
  let requestCount = 0
  let signatureCount = 0
  let transactionCount = 0
  let permitDeadline: bigint | undefined
  let permitSignature: Hex | undefined
  let simulatedData: Hex | undefined
  let submittedHash: Hash | undefined
  let sendAttempted = false
  let rejected: unknown
  const request = async (request: ProviderRequest) => {
    const method = (request as { method?: unknown } | null)?.method
    if (typeof method !== 'string') {
      throw fundingError('the wallet adapter requested an invalid RPC method.')
    }
    requestCount += 1
    if (requestCount > MAX_FILECOIN_STORAGE_FUNDING_RPC_REQUESTS) {
      throw fundingError('the wallet adapter exceeded its RPC request budget.')
    }

    if (
      method === 'eth_accounts' ||
      method === 'eth_blockNumber' ||
      method === 'eth_call' ||
      method === 'eth_chainId'
    ) {
      let providerRequest: ProviderRequest = { method }
      let validatedSimulationData: Hex | undefined
      if (method === 'eth_call') {
        const validatedRead = validateReadCall(
          request,
          plan,
          permitDeadline,
          permitSignature,
        )
        providerRequest = validatedRead.request
        validatedSimulationData = validatedRead.simulatedData
      } else if (
        request.params !== undefined &&
        (!Array.isArray(request.params) || request.params.length !== 0)
      ) {
        throw fundingError(
          `the wallet adapter produced invalid ${method} parameters.`,
        )
      }
      const result = await requestProviderBeforeDeadline(
        provider,
        providerRequest,
        Date.now() + readTimeoutMs,
        () => fundingError('a wallet read timed out.'),
        options.signal,
        () => fundingError('the funding request was cancelled.'),
      )
      if (validatedSimulationData) {
        simulatedData = validatedSimulationData
      }
      if (method === 'eth_chainId' && parseChainId(result) !== plan.chainId) {
        throw fundingError('the wallet chain changed during funding.')
      }
      if (method === 'eth_accounts') {
        const selected = parseAccounts(result)[0]
        if (!selected || !sameAddress(selected, plan.account)) {
          throw fundingError(
            'the selected wallet account changed during funding.',
          )
        }
      }
      return result
    }

    if (method === 'eth_signTypedData_v4') {
      if (plan.depositAmount === 0n || signatureCount !== 0 || sendAttempted) {
        throw fundingError(
          'the wallet adapter requested an unexpected signature.',
        )
      }
      const validatedPermit = validatePermit(request, plan)
      permitDeadline = validatedPermit.deadline
      signatureCount += 1
      await guard.assertSubmission()
      const signature = await provider.request(validatedPermit.request)
      guard.assertUnchanged()
      permitSignature = parseHex(signature, 'permit signature', 65)
      if (permitSignature.length !== 132) {
        throw fundingError('the wallet returned an invalid permit signature.')
      }
      return permitSignature
    }

    if (method === 'eth_sendTransaction') {
      if (transactionCount !== 0) {
        throw fundingError(
          'the wallet adapter requested more than one transaction.',
        )
      }
      if (
        (plan.depositAmount > 0n && signatureCount !== 1) ||
        (plan.depositAmount === 0n && signatureCount !== 0)
      ) {
        throw fundingError(
          'the wallet adapter skipped or added a permit signature.',
        )
      }
      const params = requestParams(request, 'transaction')
      if (params.length !== 1) {
        throw fundingError(
          'the wallet adapter produced invalid transaction parameters.',
        )
      }
      const validatedTransaction = validateTransactionEnvelope(params[0], plan)
      const { data } = validatedTransaction
      validateFundingCalldata(data, plan, permitDeadline, permitSignature)
      if (
        !simulatedData ||
        simulatedData.toLowerCase() !== data.toLowerCase()
      ) {
        throw fundingError(
          'the wallet adapter did not simulate the exact transaction.',
        )
      }
      transactionCount += 1
      await guard.assertSubmission()
      sendAttempted = true
      let hashValue: unknown
      try {
        hashValue = await provider.request(validatedTransaction.request)
      } catch (error) {
        if (getRpcErrorCode(error) === 4001) rejected = error
        throw error
      }
      try {
        submittedHash = parseTransactionHash(hashValue)
      } catch (cause) {
        throw new TransactionSubmissionUnknownError(cause)
      }
      options.onSubmitted?.(submittedHash)
      await guard.assertSubmission()
      return submittedHash
    }

    throw fundingError(
      `the wallet adapter requested forbidden RPC method ${method.slice(0, 80)}.`,
    )
  }

  try {
    let returnedHash: Hash
    try {
      returnedHash = parseTransactionHash(
        await (options.executeFunding ?? executeSynapseFunding)({
          plan,
          request,
        }),
      )
    } catch (error) {
      if (rejected) throw rejected
      if (sendAttempted && !submittedHash) {
        throw new TransactionSubmissionUnknownError(error)
      }
      throw error
    }
    if (
      transactionCount !== 1 ||
      !submittedHash ||
      returnedHash.toLowerCase() !== submittedHash.toLowerCase()
    ) {
      throw fundingError(
        'the wallet adapter returned an unexpected transaction hash.',
      )
    }
    return await waitForFundingReceipt(provider, submittedHash, plan, guard, {
      pollIntervalMs: options.pollIntervalMs,
      receiptTimeoutMs,
    })
  } finally {
    guard.release()
  }
}
