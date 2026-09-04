import type { Hash } from 'viem'
import {
  requestProviderBeforeDeadline,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import type { HttpRpcProvider } from './http-rpc'

export const READ_RPC_VERIFICATION_DEPTH = 12n
export const READ_RPC_VERIFICATION_TIMEOUT_MS = 15_000

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

export type ReadRpcVerification = Readonly<{
  blockHash: Hash
  blockNumber: bigint
  chainId: bigint
  endpointOrigin: string
}>

export type ReadRpcVerificationOptions = {
  confirmationDepth?: bigint
  signal?: AbortSignal
  timeoutMs?: number
}

export type ReadRpcVerifier = (
  walletProvider: Eip1193Provider,
  expectedChainId: bigint,
  readProvider: HttpRpcProvider,
  options?: ReadRpcVerificationOptions,
) => Promise<ReadRpcVerification>

function verificationError(reason: string, options?: ErrorOptions) {
  return new Error(`Cannot use read RPC: ${reason}`, options)
}

function parseQuantity(value: unknown, field: string) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw verificationError(`the ${field} is invalid.`)
  }
  return BigInt(value)
}

function parseBlock(value: unknown, expectedNumber: bigint, source: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw verificationError(`${source} returned invalid block data.`)
  }
  const block = value as Record<string, unknown>
  const numberValue = block.number
  const hashValue = block.hash
  const number = parseQuantity(numberValue, `${source} block number`)
  if (number !== expectedNumber) {
    throw verificationError(`${source} returned an unexpected block.`)
  }
  if (typeof hashValue !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hashValue)) {
    throw verificationError(`${source} returned an invalid block hash.`)
  }
  return hashValue.toLowerCase() as Hash
}

function assertQuantity(value: bigint, field: string) {
  if (value < 0n || value > MAX_EVM_QUANTITY) {
    throw verificationError(`the ${field} is invalid.`)
  }
}

function assertTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw verificationError('the verification timeout is invalid.')
  }
}

function cancelledError() {
  return verificationError('verification was cancelled.')
}

export const verifyReadRpcProvider: ReadRpcVerifier = async (
  walletProvider,
  expectedChainId,
  readProvider,
  options = {},
) => {
  if (!walletProvider || typeof walletProvider.request !== 'function') {
    throw verificationError('the wallet provider is invalid.')
  }
  if (!readProvider || typeof readProvider.request !== 'function') {
    throw verificationError('the endpoint provider is invalid.')
  }
  assertQuantity(expectedChainId, 'expected chain identifier')
  const confirmationDepth =
    options.confirmationDepth ?? READ_RPC_VERIFICATION_DEPTH
  assertQuantity(confirmationDepth, 'confirmation depth')
  const timeoutMs = options.timeoutMs ?? READ_RPC_VERIFICATION_TIMEOUT_MS
  assertTimeout(timeoutMs)
  if (options.signal?.aborted) throw cancelledError()

  const interruption = new AbortController()
  const relayAbort = () => interruption.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', relayAbort, { once: true })
  if (options.signal?.aborted) interruption.abort(options.signal.reason)
  const deadline = Date.now() + timeoutMs
  const request = (provider: Eip1193Provider, requestValue: ProviderRequest) =>
    requestProviderBeforeDeadline(
      provider,
      requestValue,
      deadline,
      () => verificationError('verification timed out.'),
      interruption.signal,
      cancelledError,
    )

  const readChainPair = async () => {
    const [walletValue, endpointValue] = await Promise.all([
      request(walletProvider, { method: 'eth_chainId' }),
      request(readProvider, { method: 'eth_chainId' }),
    ])
    return {
      endpointChainId: parseQuantity(
        endpointValue,
        'endpoint chain identifier',
      ),
      walletChainId: parseQuantity(walletValue, 'wallet chain identifier'),
    }
  }

  try {
    const firstChains = await readChainPair()
    if (firstChains.walletChainId !== expectedChainId) {
      throw verificationError('the wallet chain changed during verification.')
    }
    if (firstChains.endpointChainId !== expectedChainId) {
      throw verificationError(
        `the endpoint reports chain ${firstChains.endpointChainId.toString()}, but the wallet reports chain ${expectedChainId.toString()}.`,
      )
    }

    const [walletHeadValue, endpointHeadValue] = await Promise.all([
      request(walletProvider, { method: 'eth_blockNumber' }),
      request(readProvider, { method: 'eth_blockNumber' }),
    ])
    const walletHead = parseQuantity(walletHeadValue, 'wallet block number')
    const endpointHead = parseQuantity(
      endpointHeadValue,
      'endpoint block number',
    )
    const commonHead = walletHead < endpointHead ? walletHead : endpointHead
    const blockNumber =
      commonHead > confirmationDepth ? commonHead - confirmationDepth : 0n
    const blockTag = `0x${blockNumber.toString(16)}`
    const [walletBlockValue, endpointBlockValue] = await Promise.all([
      request(walletProvider, {
        method: 'eth_getBlockByNumber',
        params: [blockTag, false],
      }),
      request(readProvider, {
        method: 'eth_getBlockByNumber',
        params: [blockTag, false],
      }),
    ])
    const walletBlockHash = parseBlock(walletBlockValue, blockNumber, 'wallet')
    const endpointBlockHash = parseBlock(
      endpointBlockValue,
      blockNumber,
      'endpoint',
    )
    if (walletBlockHash !== endpointBlockHash) {
      throw verificationError(
        `the endpoint does not match wallet history at block ${blockNumber.toString()}.`,
      )
    }

    const finalChains = await readChainPair()
    if (
      finalChains.walletChainId !== expectedChainId ||
      finalChains.endpointChainId !== expectedChainId
    ) {
      throw verificationError('the chain changed during verification.')
    }

    return Object.freeze({
      blockHash: walletBlockHash,
      blockNumber,
      chainId: expectedChainId,
      endpointOrigin: readProvider.endpoint.origin,
    })
  } finally {
    interruption.abort()
    options.signal?.removeEventListener('abort', relayAbort)
  }
}
