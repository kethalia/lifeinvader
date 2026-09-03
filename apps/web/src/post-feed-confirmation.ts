import {
  parseChainId,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import { DEFAULT_FINALITY_DEPTH } from './event-indexer'
import { assertExpectedPost, type ExpectedPost } from './protocol'
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
  blockHash: Hash
  blockNumber: bigint
  chainId: bigint
  expectedPost: ExpectedPost
  hash: Hash
  provider: Eip1193Provider
}

export type PostInclusion = Pick<
  IncludedPost,
  'blockHash' | 'blockNumber' | 'expectedPost' | 'hash'
>

export type PostFeedConfirmationWaiter = (
  provider: Eip1193Provider,
  chainId: bigint,
  inclusion: PostInclusion,
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

function parseHash(value: unknown, field: string): Hash {
  if (
    typeof value !== 'string' ||
    value.length !== 66 ||
    !/^0x[0-9a-f]{64}$/i.test(value)
  ) {
    throw new Error(`The wallet returned an invalid ${field}.`)
  }
  return value.toLowerCase() as Hash
}

function parseReceiptInclusion(value: unknown, expectedHash: Hash) {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The wallet returned an invalid post receipt.')
  }
  const receipt = value as Record<string, unknown>
  const transactionHash = parseHash(
    receipt.transactionHash,
    'receipt transaction hash',
  )
  if (transactionHash !== expectedHash) {
    throw new Error('The wallet returned a receipt for a different post.')
  }
  if (receipt.status === '0x0') {
    throw new Error('The post transaction is reverted in canonical history.')
  }
  if (receipt.status !== '0x1') {
    throw new Error('The wallet returned an invalid post receipt status.')
  }
  return {
    blockHash: parseHash(receipt.blockHash, 'receipt block hash'),
    blockNumber: parseBlockNumber(receipt.blockNumber),
    logs: receipt.logs,
  }
}

function parseCanonicalBlock(value: unknown, expectedNumber: bigint) {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The wallet returned invalid canonical block data.')
  }
  const block = value as Record<string, unknown>
  const blockNumber = parseBlockNumber(block.number)
  if (blockNumber !== expectedNumber) {
    throw new Error('The wallet returned an unexpected canonical block.')
  }
  return {
    blockHash: parseHash(block.hash, 'canonical block hash'),
    blockNumber,
  }
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
  inclusion,
  options = {},
) => {
  assertQuantity(chainId, 'chain identifier')
  assertQuantity(inclusion.blockNumber, 'block number')
  if (inclusion.blockNumber > MAX_EVM_QUANTITY - POST_FEED_CONFIRMATION_DEPTH) {
    throw new Error('Invalid post confirmation block number.')
  }
  const transactionHash = parseHash(inclusion.hash, 'transaction hash')
  let candidate = {
    blockHash: parseHash(inclusion.blockHash, 'receipt block hash'),
    blockNumber: inclusion.blockNumber,
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
      if (head >= candidate.blockNumber + POST_FEED_CONFIRMATION_DEPTH) {
        const receiptValue = await requestBeforeDeadline(
          provider,
          {
            method: 'eth_getTransactionReceipt',
            params: [transactionHash],
          },
          deadline,
          interruption.signal,
        )
        assertActive()
        const currentInclusion = parseReceiptInclusion(
          receiptValue,
          transactionHash,
        )
        if (currentInclusion) {
          if (
            currentInclusion.blockNumber >
            MAX_EVM_QUANTITY - POST_FEED_CONFIRMATION_DEPTH
          ) {
            throw new Error('Invalid post confirmation block number.')
          }
          candidate = currentInclusion
          if (head >= candidate.blockNumber + POST_FEED_CONFIRMATION_DEPTH) {
            const blockValue = await requestBeforeDeadline(
              provider,
              {
                method: 'eth_getBlockByNumber',
                params: [`0x${candidate.blockNumber.toString(16)}`, false],
              },
              deadline,
              interruption.signal,
            )
            assertActive()
            const canonicalBlock = parseCanonicalBlock(
              blockValue,
              candidate.blockNumber,
            )
            if (canonicalBlock?.blockHash === candidate.blockHash) {
              const [finalChainValue, finalHeadValue] = await Promise.all([
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
              if (parseChainId(finalChainValue) !== chainId) {
                throw new Error(
                  'The wallet chain changed while awaiting confirmation.',
                )
              }
              const finalHead = parseBlockNumber(finalHeadValue)
              if (
                finalHead >=
                candidate.blockNumber + POST_FEED_CONFIRMATION_DEPTH
              ) {
                assertExpectedPost(
                  currentInclusion.logs,
                  inclusion.expectedPost,
                )
                return
              }
            }
          }
        }
      }
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
