import {
  parseChainId,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import { DEFAULT_FINALITY_DEPTH } from './event-indexer'
import type { Hash } from 'viem'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const DEFAULT_POLL_INTERVAL_MS = 12_000
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const MAX_CONFIRMATION_POLLS = 240

export const POST_FEED_CONFIRMATION_DEPTH = DEFAULT_FINALITY_DEPTH

export type PostFeedConfirmationOptions = {
  pollIntervalMs?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export type IncludedPost = {
  blockNumber: bigint
  chainId: bigint
  hash: Hash
  provider: Eip1193Provider
}

export type PostFeedConfirmationWaiter = (
  provider: Eip1193Provider,
  chainId: bigint,
  includedBlock: bigint,
  options?: PostFeedConfirmationOptions,
) => Promise<void>

function cancelledError() {
  return new Error('Post confirmation monitoring was cancelled.')
}

function parseBlockNumber(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid block number.')
  }
  return BigInt(value)
}

function parseMilliseconds(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
) {
  const parsed = value ?? fallback
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid post confirmation ${field}.`)
  }
  return parsed
}

function assertQuantity(value: bigint, field: string) {
  if (value < 0n || value > MAX_EVM_QUANTITY) {
    throw new Error(`Invalid post confirmation ${field}.`)
  }
}

async function requestBeforeDeadline(
  provider: Eip1193Provider,
  request: ProviderRequest,
  deadline: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw cancelledError()
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error(
      'Post confirmation monitoring timed out. Check the feed again.',
    )
  }
  let handleAbort: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(cancelledError())
    signal.addEventListener('abort', handleAbort, { once: true })
  })
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new Error(
            'Post confirmation monitoring timed out. Check the feed again.',
          ),
        ),
      remainingMs,
    )
  })
  try {
    return await Promise.race([provider.request(request), timedOut, aborted])
  } finally {
    clearTimeout(timeout)
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
  }
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelledError())
      return
    }
    const timeout = setTimeout(finish, milliseconds)
    function finish() {
      signal.removeEventListener('abort', cancel)
      resolve()
    }
    function cancel() {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      reject(cancelledError())
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export const waitForPostFeedConfirmation: PostFeedConfirmationWaiter = async (
  provider,
  chainId,
  includedBlock,
  options = {},
) => {
  assertQuantity(chainId, 'chain identifier')
  assertQuantity(includedBlock, 'block number')
  if (includedBlock > MAX_EVM_QUANTITY - POST_FEED_CONFIRMATION_DEPTH) {
    throw new Error('Invalid post confirmation block number.')
  }
  const pollIntervalMs = parseMilliseconds(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    60_000,
    'poll interval',
  )
  const timeoutMs = parseMilliseconds(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'timeout',
  )
  const deadline = Date.now() + timeoutMs
  const interruption = new AbortController()
  let contextChanged = false
  const interruptContext = () => {
    contextChanged = true
    interruption.abort()
  }
  const interruptRequest = () => interruption.abort()
  provider.on?.('chainChanged', interruptContext)
  provider.on?.('disconnect', interruptContext)
  options.signal?.addEventListener('abort', interruptRequest, { once: true })
  const assertActive = () => {
    if (options.signal?.aborted) throw cancelledError()
    if (contextChanged) {
      throw new Error('The wallet chain changed while awaiting confirmation.')
    }
  }
  try {
    for (let attempt = 0; attempt < MAX_CONFIRMATION_POLLS; attempt += 1) {
      assertActive()
      const [chainValue, headValue] = await Promise.all([
        requestBeforeDeadline(
          provider,
          { method: 'eth_chainId' },
          deadline,
          interruption.signal,
        ),
        requestBeforeDeadline(
          provider,
          { method: 'eth_blockNumber' },
          deadline,
          interruption.signal,
        ),
      ])
      assertActive()
      if (parseChainId(chainValue) !== chainId) {
        throw new Error('The wallet chain changed while awaiting confirmation.')
      }
      const head = parseBlockNumber(headValue)
      if (head >= includedBlock + POST_FEED_CONFIRMATION_DEPTH) return
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      await wait(Math.min(pollIntervalMs, remainingMs), interruption.signal)
    }
    throw new Error(
      'Post confirmation monitoring timed out. Check the feed again.',
    )
  } catch (error) {
    assertActive()
    throw error
  } finally {
    interruption.abort()
    options.signal?.removeEventListener('abort', interruptRequest)
    provider.removeListener?.('chainChanged', interruptContext)
    provider.removeListener?.('disconnect', interruptContext)
  }
}
