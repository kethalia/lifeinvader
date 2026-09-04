import { custom, getAddress, type Address } from 'viem'
import {
  beforeDeadline,
  parseAccounts,
  parseChainId,
  requestProviderBeforeDeadline,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_MAINNET_CHAIN_ID,
  getFilecoinStorageNetwork,
} from './filecoin-storage'

export const FILECOIN_STORAGE_QUOTE_TIMEOUT_MS = 30_000
export const MAX_FILECOIN_STORAGE_QUOTE_RPC_REQUESTS = 16

const QUOTE_RPC_METHODS = new Set([
  'eth_accounts',
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
])

export type FilecoinStorageCosts = {
  depositNeeded: bigint
  fees: {
    addPiecesFee: bigint
    createDataSetFee: bigint
    total: bigint
  }
  lockups: {
    cacheMissLockup: bigint
    cdnLockup: bigint
    lifecycleLockup: bigint
    streamingLockup: bigint
    total: bigint
  }
  needsFwssMaxApproval: boolean
  rates: {
    perEpoch: bigint
    perMonth: bigint
  }
  ready: boolean
}

export type FilecoinStorageQuote = {
  account: Address
  chainId: bigint
  copies: 1
  dataSize: bigint
  depositNeeded: bigint
  fees: FilecoinStorageCosts['fees']
  lockups: FilecoinStorageCosts['lockups']
  needsServiceApproval: boolean
  rates: FilecoinStorageCosts['rates']
  ready: boolean
  tokenDecimals: 18
  tokenSymbol: 'USDFC'
  withCDN: false
}

export type FilecoinStorageCostReader = (input: {
  account: Address
  chainId: bigint
  dataSize: bigint
  request(request: ProviderRequest): Promise<unknown>
}) => Promise<FilecoinStorageCosts>

export type FilecoinStorageQuoteOptions = {
  expectedAccount: Address
  expectedChainId: bigint
  readCosts?: FilecoinStorageCostReader
  signal?: AbortSignal
  timeoutMs?: number
}

class FilecoinStorageQuoteError extends Error {}

function quoteError(reason: string, options?: ErrorOptions) {
  return new FilecoinStorageQuoteError(
    `Cannot quote Filecoin storage: ${reason}`,
    options,
  )
}

function validTimeout(value: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= 60_000
}

function assertDataSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 127) {
    throw quoteError('the prepared CAR byte length is invalid.')
  }
}

function assertNonNegative(
  value: unknown,
  label: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw quoteError(`Synapse returned an invalid ${label}.`)
  }
}

function validateCosts(value: FilecoinStorageCosts): FilecoinStorageCosts {
  if (!value || typeof value !== 'object') {
    throw quoteError('Synapse returned invalid costs.')
  }
  assertNonNegative(value.rates?.perEpoch, 'per-epoch rate')
  assertNonNegative(value.rates?.perMonth, 'monthly rate')
  assertNonNegative(value.fees?.createDataSetFee, 'data-set fee')
  assertNonNegative(value.fees?.addPiecesFee, 'piece fee')
  assertNonNegative(value.fees?.total, 'total fee')
  assertNonNegative(value.lockups?.lifecycleLockup, 'lifecycle lockup')
  assertNonNegative(value.lockups?.streamingLockup, 'streaming lockup')
  assertNonNegative(value.lockups?.cdnLockup, 'CDN lockup')
  assertNonNegative(value.lockups?.cacheMissLockup, 'cache-miss lockup')
  assertNonNegative(value.lockups?.total, 'total lockup')
  assertNonNegative(value.depositNeeded, 'required deposit')
  if (
    typeof value.needsFwssMaxApproval !== 'boolean' ||
    typeof value.ready !== 'boolean'
  ) {
    throw quoteError('Synapse returned invalid readiness flags.')
  }
  if (
    value.fees.total !==
    value.fees.createDataSetFee + value.fees.addPiecesFee
  ) {
    throw quoteError('Synapse returned inconsistent service fees.')
  }
  if (
    value.ready !== (value.depositNeeded === 0n && !value.needsFwssMaxApproval)
  ) {
    throw quoteError('Synapse returned inconsistent readiness state.')
  }
  return value
}

const readSynapseCosts: FilecoinStorageCostReader = async ({
  account,
  chainId,
  dataSize,
  request,
}) => {
  const { Synapse, calibration, mainnet } = await import('@filoz/synapse-sdk')
  const chainTemplate =
    chainId === FILECOIN_MAINNET_CHAIN_ID
      ? mainnet
      : chainId === FILECOIN_CALIBRATION_CHAIN_ID
        ? calibration
        : undefined
  const network = getFilecoinStorageNetwork(chainId)
  if (!chainTemplate || !network) {
    throw quoteError(`chain ${chainId.toString()} is unsupported.`)
  }

  // Bind SDK reads to the exact address graph that the preceding preflight
  // verified instead of trusting addresses bundled into a dependency release.
  const chain = {
    ...chainTemplate,
    contracts: {
      ...chainTemplate.contracts,
      endorsements: {
        ...chainTemplate.contracts.endorsements,
        address: network.contracts.endorsements,
      },
      filecoinPay: {
        ...chainTemplate.contracts.filecoinPay,
        address: network.contracts.filecoinPay,
      },
      fwss: {
        ...chainTemplate.contracts.fwss,
        address: network.contracts.fwss,
      },
      fwssView: {
        ...chainTemplate.contracts.fwssView,
        address: network.contracts.fwssView,
      },
      pdp: {
        ...chainTemplate.contracts.pdp,
        address: network.contracts.pdp,
      },
      serviceProviderRegistry: {
        ...chainTemplate.contracts.serviceProviderRegistry,
        address: network.contracts.serviceProviderRegistry,
      },
      sessionKeyRegistry: {
        ...chainTemplate.contracts.sessionKeyRegistry,
        address: network.contracts.sessionKeyRegistry,
      },
      usdfc: {
        ...chainTemplate.contracts.usdfc,
        address: network.contracts.usdfc,
      },
    },
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
    account,
    chain,
    source: 'lifeinvader',
    transport,
    withCDN: false,
  })
  return await synapse.storage.getUploadCosts({
    dataSize,
    isNewDataSet: true,
    pieceCount: 1n,
    withCDN: false,
  })
}

/**
 * Quote one new, non-CDN Filecoin storage data set for a prepared CAR.
 * The transport is read-only, request-capped, deadline-bound, and tied to the
 * exact wallet account and chain observed before and after the Synapse read.
 */
export async function quoteFilecoinStorage(
  provider: Eip1193Provider,
  carByteLength: number,
  options: FilecoinStorageQuoteOptions,
): Promise<FilecoinStorageQuote> {
  assertDataSize(carByteLength)
  const timeoutMs = options.timeoutMs ?? FILECOIN_STORAGE_QUOTE_TIMEOUT_MS
  if (!validTimeout(timeoutMs)) {
    throw quoteError('the quote timeout is invalid.')
  }
  const network = getFilecoinStorageNetwork(options.expectedChainId)
  if (!network) {
    throw quoteError(
      `chain ${options.expectedChainId.toString()} is unsupported.`,
    )
  }
  let expectedAccount: Address
  try {
    expectedAccount = getAddress(options.expectedAccount)
  } catch (cause) {
    throw quoteError('the expected wallet account is invalid.', { cause })
  }

  let contextChanged = false
  const handleContextChange = () => {
    contextChanged = true
  }
  const addProviderListener = provider.on?.bind(provider)
  const removeProviderListener = provider.removeListener?.bind(provider)
  if (addProviderListener && removeProviderListener) {
    addProviderListener('accountsChanged', handleContextChange)
    addProviderListener('chainChanged', handleContextChange)
    addProviderListener('disconnect', handleContextChange)
  }

  const deadline = Date.now() + timeoutMs
  let requestCount = 0
  const assertContextStable = () => {
    if (contextChanged) {
      throw quoteError('the wallet context changed during the quote.')
    }
  }
  const read = async (request: ProviderRequest) => {
    assertContextStable()
    if (!QUOTE_RPC_METHODS.has(request.method)) {
      throw quoteError(
        `the quote adapter requested forbidden RPC method ${request.method.slice(0, 80)}.`,
      )
    }
    requestCount += 1
    if (requestCount > MAX_FILECOIN_STORAGE_QUOTE_RPC_REQUESTS) {
      throw quoteError('the quote exceeded its wallet-read budget.')
    }
    const result = await requestProviderBeforeDeadline(
      provider,
      request,
      deadline,
      () => quoteError('the wallet read timed out.'),
      options.signal,
      () => quoteError('the quote was cancelled.'),
    )
    assertContextStable()
    return result
  }
  const readContext = async () => {
    const chainId = parseChainId(await read({ method: 'eth_chainId' }))
    const account = parseAccounts(await read({ method: 'eth_accounts' }))[0]
    if (chainId !== network.chainId) {
      throw quoteError(
        `the wallet moved from expected chain ${network.chainId.toString()} to chain ${chainId.toString()}.`,
      )
    }
    if (account?.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw quoteError('the selected wallet account changed.')
    }
  }

  try {
    await readContext()
    const costs = validateCosts(
      await beforeDeadline(
        () =>
          (options.readCosts ?? readSynapseCosts)({
            account: expectedAccount,
            chainId: network.chainId,
            dataSize: BigInt(carByteLength),
            request: read,
          }),
        deadline,
        () => quoteError('the Synapse cost read timed out.'),
        options.signal,
        () => quoteError('the quote was cancelled.'),
      ),
    )
    await readContext()
    return {
      account: expectedAccount,
      chainId: network.chainId,
      copies: 1,
      dataSize: BigInt(carByteLength),
      depositNeeded: costs.depositNeeded,
      fees: costs.fees,
      lockups: costs.lockups,
      needsServiceApproval: costs.needsFwssMaxApproval,
      rates: costs.rates,
      ready: costs.ready,
      tokenDecimals: 18,
      tokenSymbol: 'USDFC',
      withCDN: false,
    }
  } finally {
    if (addProviderListener && removeProviderListener) {
      removeProviderListener('accountsChanged', handleContextChange)
      removeProviderListener('chainChanged', handleContextChange)
      removeProviderListener('disconnect', handleContextChange)
    }
  }
}
