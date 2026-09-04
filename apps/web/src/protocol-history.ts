import { keccak256, type Hash, type Hex } from 'viem'
import {
  beforeDeadline,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import { DEFAULT_FINALITY_DEPTH } from './event-indexer'
import { PROTOCOL_ADDRESS, PROTOCOL_CODE_HASH } from './protocol'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const MAX_CODE_BYTES = 24_576
export const DEFAULT_PROTOCOL_HISTORY_CODE_PROBES = 64
export const MAX_PROTOCOL_HISTORY_CODE_PROBES = 64

const HISTORICAL_STATE_UNAVAILABLE_PATTERNS = [
  /\bmissing trie node\b/i,
  /\b(?:historical|archive|pruned) (?:state|data|history)\b.*\b(?:unavailable|not available|unsupported|required)\b/i,
  /\barchive node\b.*\brequired\b/i,
  /\b(?:state|data)\b.*\b(?:for|at)\b.*\bblock\b.*\b(?:unavailable|not available|pruned)\b/i,
  /\b(?:state|data)\b.*\b(?:unavailable|not available|pruned)\b.*\b(?:for|at)\b.*\bblock\b/i,
  /\bno (?:state|data)\b.*\bavailable\b.*\b(?:for|at)\b.*\bblock\b/i,
  /\brequested block\b.*\b(?:pruned|too old)\b/i,
] as const

export type ProtocolBlockFingerprint = Readonly<{
  blockHash: Hash
  blockNumber: bigint
}>

export type ProtocolHistoryBoundary = Readonly<{
  chainId: bigint
  codeProbes: number
  confirmedThrough?: ProtocolBlockFingerprint
  deployment?: ProtocolBlockFingerprint
  head: ProtocolBlockFingerprint
  kind: 'confirmed' | 'pending-confirmation'
  preceding?: ProtocolBlockFingerprint
  startBlock: bigint
}>

export type DiscoverProtocolHistoryOptions = {
  finalityDepth?: bigint
  maxCodeProbes?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export type AuthenticateProtocolHistoryAnchorOptions = Pick<
  DiscoverProtocolHistoryOptions,
  'signal' | 'timeoutMs'
>

export type ProtocolHistoryBoundaryResolver = (
  provider: Eip1193Provider,
  chainId: bigint,
  options?: DiscoverProtocolHistoryOptions,
) => Promise<ProtocolHistoryBoundary>

export class ProtocolHistoryUnavailableError extends Error {
  constructor(blockNumber: bigint, cause: unknown) {
    super(
      `The connected RPC could not read Lifeinvader code at historical block ${blockNumber.toString()}.`,
      { cause },
    )
    this.name = 'ProtocolHistoryUnavailableError'
  }
}

class ProtocolHistoryTimeoutError extends Error {
  constructor() {
    super('Protocol history discovery timed out.')
    this.name = 'ProtocolHistoryTimeoutError'
  }
}

export function isProtocolHistoryUnavailableError(
  error: unknown,
): error is ProtocolHistoryUnavailableError {
  return error instanceof ProtocolHistoryUnavailableError
}

function isHistoricalStateUnavailableRpcError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : undefined
  return (
    message !== undefined &&
    HISTORICAL_STATE_UNAVAILABLE_PATTERNS.some((pattern) =>
      pattern.test(message),
    )
  )
}

type DiscoveryContext = {
  contextChanged: boolean
  deadline: number
  provider: Eip1193Provider
  signal: AbortSignal
}

const resolvedBoundaries = new WeakMap<
  Eip1193Provider,
  Map<string, ProtocolHistoryBoundary>
>()

function invalidRpc(field: string) {
  return new Error(`The wallet returned an invalid ${field}.`)
}

function assertQuantity(
  value: unknown,
  field: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_EVM_QUANTITY) {
    throw new Error(`Invalid ${field}.`)
  }
}

function parseQuantity(value: unknown, field: string) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw invalidRpc(field)
  }
  return BigInt(value)
}

function parseHash(value: unknown, field: string): Hash {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw invalidRpc(field)
  }
  return value.toLowerCase() as Hash
}

function parseCode(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    value.length > MAX_CODE_BYTES * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw invalidRpc('protocol code')
  }
  return value.toLowerCase() as Hex
}

function toQuantity(value: bigint) {
  return `0x${value.toString(16)}`
}

function parseBlock(
  value: unknown,
  expectedNumber: bigint,
): ProtocolBlockFingerprint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRpc('protocol history block')
  }
  const block = value as Record<string, unknown>
  const blockNumber = parseQuantity(
    block.number,
    'protocol history block number',
  )
  if (blockNumber !== expectedNumber) {
    throw invalidRpc('protocol history block number')
  }
  return Object.freeze({
    blockHash: parseHash(block.hash, 'protocol history block hash'),
    blockNumber,
  })
}

function discoveryCancelled(contextChanged: boolean) {
  return new Error(
    contextChanged
      ? 'The wallet chain changed during protocol history discovery.'
      : 'Protocol history discovery was cancelled.',
  )
}

function assertContextActive(context: DiscoveryContext) {
  if (context.contextChanged || context.signal.aborted) {
    throw discoveryCancelled(context.contextChanged)
  }
}

async function requestInContext(
  context: DiscoveryContext,
  request: ProviderRequest,
) {
  assertContextActive(context)
  const value = await beforeDeadline(
    () => context.provider.request(request),
    context.deadline,
    () => new ProtocolHistoryTimeoutError(),
    context.signal,
    () => discoveryCancelled(context.contextChanged),
  )
  assertContextActive(context)
  return value
}

async function assertSelectedChain(
  context: DiscoveryContext,
  expectedChainId: bigint,
) {
  const chainId = parseChainId(
    await requestInContext(context, { method: 'eth_chainId' }),
  )
  if (chainId !== expectedChainId) {
    throw new Error('The protocol history belongs to another wallet chain.')
  }
}

async function readHead(context: DiscoveryContext) {
  return parseQuantity(
    await requestInContext(context, { method: 'eth_blockNumber' }),
    'protocol history head',
  )
}

async function readBlock(context: DiscoveryContext, blockNumber: bigint) {
  return parseBlock(
    await requestInContext(context, {
      method: 'eth_getBlockByNumber',
      params: [toQuantity(blockNumber), false],
    }),
    blockNumber,
  )
}

function classifyCode(code: Hex, blockNumber: bigint) {
  if (code === '0x') return 'empty' as const
  if (keccak256(code) === PROTOCOL_CODE_HASH) return 'protocol' as const
  throw new Error(
    `The predetermined Lifeinvader address contains unexpected code at block ${blockNumber.toString()}.`,
  )
}

function sameBlock(
  first: ProtocolBlockFingerprint,
  second: ProtocolBlockFingerprint,
) {
  return (
    first.blockNumber === second.blockNumber &&
    first.blockHash === second.blockHash
  )
}

function normalizeFingerprint(
  value: unknown,
  field: string,
): ProtocolBlockFingerprint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${field}.`)
  }
  const fingerprint = value as Record<string, unknown>
  assertQuantity(fingerprint.blockNumber, `${field} block number`)
  return {
    blockHash: parseHash(fingerprint.blockHash, `${field} block hash`),
    blockNumber: fingerprint.blockNumber,
  }
}

function freezeBoundary(
  boundary: Omit<ProtocolHistoryBoundary, 'codeProbes'>,
  codeProbes: number,
): ProtocolHistoryBoundary {
  return Object.freeze({ ...boundary, codeProbes })
}

export async function discoverProtocolHistoryBoundary(
  provider: Eip1193Provider,
  chainId: bigint,
  {
    finalityDepth = DEFAULT_FINALITY_DEPTH,
    maxCodeProbes = DEFAULT_PROTOCOL_HISTORY_CODE_PROBES,
    signal,
    timeoutMs = WALLET_READ_TIMEOUT_MS,
  }: DiscoverProtocolHistoryOptions = {},
): Promise<ProtocolHistoryBoundary> {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('Invalid protocol history provider.')
  }
  assertQuantity(chainId, 'protocol history chain identifier')
  assertQuantity(finalityDepth, 'protocol history finality depth')
  if (
    !Number.isSafeInteger(maxCodeProbes) ||
    maxCodeProbes < 1 ||
    maxCodeProbes > MAX_PROTOCOL_HISTORY_CODE_PROBES
  ) {
    throw new Error('Invalid protocol history code probe limit.')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid protocol history timeout.')
  }
  if (signal?.aborted) throw discoveryCancelled(false)

  const interruption = new AbortController()
  let contextChanged = false
  const interruptContext = () => {
    contextChanged = true
    interruption.abort()
  }
  const interruptRequest = () => interruption.abort()
  provider.on?.('chainChanged', interruptContext)
  provider.on?.('disconnect', interruptContext)
  signal?.addEventListener('abort', interruptRequest, { once: true })
  const context: DiscoveryContext = {
    contextChanged,
    deadline: Date.now() + timeoutMs,
    provider,
    signal: interruption.signal,
  }
  const refreshContext = () => {
    context.contextChanged = contextChanged
    assertContextActive(context)
    if (signal?.aborted) throw discoveryCancelled(false)
  }

  let codeProbes = 0
  const codeByBlock = new Map<bigint, Hex>()
  const readCode = async (blockNumber: bigint, refresh = false) => {
    const cached = refresh ? undefined : codeByBlock.get(blockNumber)
    if (cached !== undefined) return cached
    if (codeProbes >= maxCodeProbes) {
      throw new Error(
        `Protocol history discovery exceeded ${maxCodeProbes.toString()} code probes.`,
      )
    }
    codeProbes += 1
    let value: unknown
    try {
      value = await requestInContext(context, {
        method: 'eth_getCode',
        params: [PROTOCOL_ADDRESS, toQuantity(blockNumber)],
      })
    } catch (error) {
      refreshContext()
      if (error instanceof ProtocolHistoryTimeoutError) throw error
      if (!isHistoricalStateUnavailableRpcError(error)) throw error
      throw new ProtocolHistoryUnavailableError(blockNumber, error)
    }
    const code = parseCode(value)
    codeByBlock.set(blockNumber, code)
    return code
  }

  try {
    refreshContext()
    await assertSelectedChain(context, chainId)
    const headNumber = await readHead(context)
    const head = await readBlock(context, headNumber)
    if (classifyCode(await readCode(headNumber), headNumber) !== 'protocol') {
      throw new Error(
        'Verified Lifeinvader v1 is not deployed at the selected head.',
      )
    }

    const confirmedNumber =
      headNumber >= finalityDepth ? headNumber - finalityDepth : undefined
    const confirmedThrough =
      confirmedNumber === undefined
        ? undefined
        : confirmedNumber === headNumber
          ? head
          : await readBlock(context, confirmedNumber)

    let boundary: Omit<ProtocolHistoryBoundary, 'codeProbes'>
    if (confirmedNumber === undefined) {
      boundary = {
        chainId,
        head,
        kind: 'pending-confirmation',
        startBlock: 0n,
      }
    } else {
      const confirmedCode = classifyCode(
        await readCode(confirmedNumber),
        confirmedNumber,
      )
      if (confirmedCode === 'empty') {
        if (
          classifyCode(
            await readCode(confirmedNumber, true),
            confirmedNumber,
          ) !== 'empty' ||
          classifyCode(await readCode(headNumber, true), headNumber) !==
            'protocol'
        ) {
          throw new Error(
            'The Lifeinvader deployment boundary changed during discovery.',
          )
        }
        boundary = {
          chainId,
          confirmedThrough,
          head,
          kind: 'pending-confirmation',
          preceding: confirmedThrough,
          startBlock: confirmedNumber + 1n,
        }
      } else {
        let low = 0n
        let high = confirmedNumber
        while (low < high) {
          const middle = low + (high - low) / 2n
          const code = classifyCode(await readCode(middle), middle)
          if (code === 'empty') low = middle + 1n
          else high = middle
        }
        if (classifyCode(await readCode(low, true), low) !== 'protocol') {
          throw new Error(
            'The Lifeinvader deployment boundary changed during discovery.',
          )
        }
        const deployment = await readBlock(context, low)
        let preceding: ProtocolBlockFingerprint | undefined
        if (low > 0n) {
          const precedingNumber = low - 1n
          if (
            classifyCode(
              await readCode(precedingNumber, true),
              precedingNumber,
            ) !== 'empty'
          ) {
            throw new Error(
              'The Lifeinvader deployment boundary changed during discovery.',
            )
          }
          preceding = await readBlock(context, precedingNumber)
        }
        boundary = {
          chainId,
          confirmedThrough,
          deployment,
          head,
          kind: 'confirmed',
          preceding,
          startBlock: low,
        }
      }
    }

    const finalHeadNumber = await readHead(context)
    if (finalHeadNumber < headNumber) {
      throw new Error(
        'The wallet head moved behind the protocol history anchor.',
      )
    }
    const finalHead = await readBlock(context, headNumber)
    if (!sameBlock(head, finalHead)) {
      throw new Error(
        'The protocol history anchor changed during discovery. Retry after the chain stabilizes.',
      )
    }
    await assertSelectedChain(context, chainId)
    refreshContext()
    return freezeBoundary(boundary, codeProbes)
  } catch (error) {
    refreshContext()
    throw error
  } finally {
    interruption.abort()
    signal?.removeEventListener('abort', interruptRequest)
    provider.removeListener?.('chainChanged', interruptContext)
    provider.removeListener?.('disconnect', interruptContext)
  }
}

export async function protocolHistoryAnchorIsCanonical(
  provider: Eip1193Provider,
  chainId: bigint,
  anchorValue: ProtocolBlockFingerprint,
  {
    signal,
    timeoutMs = WALLET_READ_TIMEOUT_MS,
  }: AuthenticateProtocolHistoryAnchorOptions = {},
) {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('Invalid protocol history provider.')
  }
  assertQuantity(chainId, 'protocol history chain identifier')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid protocol history timeout.')
  }
  if (signal?.aborted) throw discoveryCancelled(false)
  const anchor = normalizeFingerprint(anchorValue, 'protocol history anchor')
  const deadline = Date.now() + timeoutMs
  const request = (requestValue: ProviderRequest) =>
    beforeDeadline(
      () => provider.request(requestValue),
      deadline,
      () => new Error('Protocol history anchor authentication timed out.'),
      signal,
      () => discoveryCancelled(false),
    )
  const firstChainId = parseChainId(await request({ method: 'eth_chainId' }))
  if (firstChainId !== chainId) {
    throw new Error('The protocol history belongs to another wallet chain.')
  }
  const anchorResponse = await request({
    method: 'eth_getBlockByNumber',
    params: [toQuantity(anchor.blockNumber), false],
  })
  const currentAnchor =
    anchorResponse === null
      ? undefined
      : parseBlock(anchorResponse, anchor.blockNumber)
  const finalChainId = parseChainId(await request({ method: 'eth_chainId' }))
  if (finalChainId !== chainId) {
    throw new Error('The protocol history belongs to another wallet chain.')
  }
  return currentAnchor !== undefined && sameBlock(currentAnchor, anchor)
}

export async function resolveProtocolHistoryBoundary(
  provider: Eip1193Provider,
  chainId: bigint,
  options: DiscoverProtocolHistoryOptions = {},
) {
  const finalityDepth = options.finalityDepth ?? DEFAULT_FINALITY_DEPTH
  const timeoutMs = options.timeoutMs ?? WALLET_READ_TIMEOUT_MS
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('Invalid protocol history provider.')
  }
  assertQuantity(chainId, 'protocol history chain identifier')
  assertQuantity(finalityDepth, 'protocol history finality depth')
  if (
    options.maxCodeProbes !== undefined &&
    (!Number.isSafeInteger(options.maxCodeProbes) ||
      options.maxCodeProbes < 1 ||
      options.maxCodeProbes > MAX_PROTOCOL_HISTORY_CODE_PROBES)
  ) {
    throw new Error('Invalid protocol history code probe limit.')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid protocol history timeout.')
  }
  if (options.signal?.aborted) throw discoveryCancelled(false)
  const key = `${chainId.toString()}:${finalityDepth.toString()}`
  const providerCache = resolvedBoundaries.get(provider)
  const cached = providerCache?.get(key)
  if (cached) {
    if (
      cached.kind === 'confirmed' &&
      (await protocolHistoryAnchorIsCanonical(provider, chainId, cached.head, {
        signal: options.signal,
        timeoutMs,
      }))
    ) {
      return cached
    }
    providerCache?.delete(key)
  }
  const boundary = await discoverProtocolHistoryBoundary(provider, chainId, {
    ...options,
    finalityDepth,
  })
  let currentProviderCache = resolvedBoundaries.get(provider)
  if (!currentProviderCache) {
    currentProviderCache = new Map()
    resolvedBoundaries.set(provider, currentProviderCache)
  }
  if (boundary.kind === 'confirmed') {
    currentProviderCache.set(key, boundary)
  }
  return boundary
}
