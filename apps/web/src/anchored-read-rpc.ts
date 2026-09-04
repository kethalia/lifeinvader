import {
  requestProvider,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import type { HttpRpcProvider } from './http-rpc'
import type { ReadRpcVerification } from './read-rpc'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n

function anchorError(reason: string) {
  return new Error(`Cannot use read RPC: ${reason}`)
}

function parseQuantity(value: unknown, field: string) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw anchorError(`the ${field} is invalid.`)
  }
  return BigInt(value)
}

function parseHash(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw anchorError(`the ${field} is invalid.`)
  }
  return value.toLowerCase()
}

function parseBlock(
  value: unknown,
  expectedNumber: bigint,
  source: 'endpoint' | 'wallet',
) {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw anchorError(`${source} returned invalid block data.`)
  }
  const block = value as Record<string, unknown>
  const numberValue = block.number
  const hashValue = block.hash
  const number = parseQuantity(numberValue, `${source} block number`)
  if (number !== expectedNumber) {
    throw anchorError(`${source} returned an unexpected block.`)
  }
  return {
    hash: parseHash(hashValue, `${source} block hash`),
    number,
  }
}

function snapshotRequest(request: ProviderRequest): ProviderRequest {
  const method = request.method
  const params = request.params
  if (params === undefined) return { method }
  if (Array.isArray(params)) return { method, params: [...params] }
  return { method, params: { ...params } }
}

function blockNumberFromRequest(request: ProviderRequest) {
  const params = request.params
  if (!Array.isArray(params) || params.length < 1) {
    throw anchorError('the block request is invalid.')
  }
  return parseQuantity(params[0], 'requested block number')
}

/**
 * Routes bulk reads through a selected endpoint while retaining the wallet as
 * the chain-history trust anchor. Every chain check revalidates the immutable
 * selection checkpoint, every sampled block is compared with the wallet, and
 * the reported head can never advance beyond either provider.
 */
export function createAnchoredReadRpcProvider(
  walletProvider: Eip1193Provider,
  endpointProvider: HttpRpcProvider,
  verification: ReadRpcVerification,
): HttpRpcProvider {
  if (!walletProvider || typeof walletProvider.request !== 'function') {
    throw anchorError('the wallet provider is invalid.')
  }
  if (!endpointProvider || typeof endpointProvider.request !== 'function') {
    throw anchorError('the endpoint provider is invalid.')
  }
  const verifiedChainId = verification.chainId
  const verifiedBlockNumber = verification.blockNumber
  const verifiedBlockHash = verification.blockHash
  const verifiedEndpointOrigin = verification.endpointOrigin
  if (
    typeof verifiedChainId !== 'bigint' ||
    verifiedChainId < 0n ||
    verifiedChainId > MAX_EVM_QUANTITY ||
    typeof verifiedBlockNumber !== 'bigint' ||
    verifiedBlockNumber < 0n ||
    verifiedBlockNumber > MAX_EVM_QUANTITY
  ) {
    throw anchorError('the verified checkpoint is invalid.')
  }
  const anchorHash = parseHash(verifiedBlockHash, 'verified block hash')
  if (verifiedEndpointOrigin !== endpointProvider.endpoint.origin) {
    throw anchorError('the verified endpoint does not match the transport.')
  }

  const chainId = verifiedChainId
  const anchorRequest: ProviderRequest = {
    method: 'eth_getBlockByNumber',
    params: [`0x${verifiedBlockNumber.toString(16)}`, false],
  }
  let closed = false

  const read = async (requestInput: ProviderRequest, signal?: AbortSignal) => {
    if (closed) throw new Error('The anchored read RPC transport was closed.')
    const request = snapshotRequest(requestInput)

    if (request.method === 'eth_chainId') {
      const [walletChainValue, endpointChainValue, walletBlock, endpointBlock] =
        await Promise.all([
          requestProvider(walletProvider, snapshotRequest(request), signal),
          requestProvider(endpointProvider, snapshotRequest(request), signal),
          requestProvider(
            walletProvider,
            snapshotRequest(anchorRequest),
            signal,
          ),
          requestProvider(
            endpointProvider,
            snapshotRequest(anchorRequest),
            signal,
          ),
        ])
      const walletChainId = parseQuantity(
        walletChainValue,
        'wallet chain identifier',
      )
      const endpointChainId = parseQuantity(
        endpointChainValue,
        'endpoint chain identifier',
      )
      if (walletChainId !== chainId || endpointChainId !== chainId) {
        throw anchorError('the selected chain changed after verification.')
      }
      const walletAnchor = parseBlock(
        walletBlock,
        verifiedBlockNumber,
        'wallet',
      )
      const endpointAnchor = parseBlock(
        endpointBlock,
        verifiedBlockNumber,
        'endpoint',
      )
      if (
        walletAnchor?.hash !== anchorHash ||
        endpointAnchor?.hash !== anchorHash
      ) {
        throw anchorError(
          `the verified history anchor at block ${verifiedBlockNumber.toString()} changed. Verify the endpoint again.`,
        )
      }
      return `0x${chainId.toString(16)}`
    }

    if (request.method === 'eth_blockNumber') {
      const [walletValue, endpointValue] = await Promise.all([
        requestProvider(walletProvider, snapshotRequest(request), signal),
        requestProvider(endpointProvider, snapshotRequest(request), signal),
      ])
      const walletHead = parseQuantity(walletValue, 'wallet block number')
      const endpointHead = parseQuantity(endpointValue, 'endpoint block number')
      const sharedHead = walletHead < endpointHead ? walletHead : endpointHead
      return `0x${sharedHead.toString(16)}`
    }

    if (request.method === 'eth_getBlockByNumber') {
      const expectedNumber = blockNumberFromRequest(request)
      const [walletValue, endpointValue] = await Promise.all([
        requestProvider(walletProvider, snapshotRequest(request), signal),
        requestProvider(endpointProvider, snapshotRequest(request), signal),
      ])
      const walletBlock = parseBlock(walletValue, expectedNumber, 'wallet')
      const endpointBlock = parseBlock(
        endpointValue,
        expectedNumber,
        'endpoint',
      )
      if (walletBlock?.hash !== endpointBlock?.hash) {
        throw anchorError(
          `the endpoint does not match wallet history at block ${expectedNumber.toString()}.`,
        )
      }
      return endpointValue
    }

    // Receipt identity belongs to a transaction submitted through the wallet.
    // Keep this low-volume confirmation read on that same trust boundary.
    if (request.method === 'eth_getTransactionReceipt') {
      return requestProvider(walletProvider, request, signal)
    }

    return requestProvider(endpointProvider, request, signal)
  }

  return Object.freeze({
    close() {
      if (closed) return
      closed = true
      endpointProvider.close()
    },
    endpoint: endpointProvider.endpoint,
    on(event: string, listener: (...args: unknown[]) => void) {
      walletProvider.on?.(event, listener)
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      walletProvider.removeListener?.(event, listener)
    },
    request(request: ProviderRequest) {
      return read(request)
    },
    requestWithSignal(request: ProviderRequest, signal: AbortSignal) {
      return read(request, signal)
    },
  })
}
