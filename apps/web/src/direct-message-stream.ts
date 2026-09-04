import { getAddress, type Address, type Hash } from 'viem'
import { openEventCache, type OpenEventCacheOptions } from './event-cache'
import {
  createEventCursor,
  syncEventLogs,
  type EventCheckpoint,
  type EventCursor,
  type IndexedEventLog,
} from './event-indexer'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import {
  decodePublishedDirectMessage,
  getDirectMessageConversationFilter,
  type PublishedDirectMessage,
} from './protocol-events'
import { getDirectConversationId, inspectProtocol } from './protocol'
import {
  isProtocolHistoryUnavailableError,
  protocolHistoryAnchorIsCanonical,
  resolveProtocolHistoryBoundary,
  type ProtocolBlockFingerprint,
  type ProtocolHistoryBoundaryResolver,
} from './protocol-history'
import {
  parseChainId,
  requestProviderBeforeDeadline,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

export const DIRECT_MESSAGE_PAGE_SIZE = 100
export const DIRECT_MESSAGE_START_BLOCK = 0n

export type DirectMessageStreamSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  conversationId: Hash
  head: bigint
  indexedThrough?: bigint
  recentMessages: readonly PublishedDirectMessage[]
  safeHead?: bigint
  scannedRanges: number
  startBlock: bigint
}

export type DirectMessageStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizeDirectMessageStreamOptions = {
  resolveHistoryBoundary?: ProtocolHistoryBoundaryResolver
  signal?: AbortSignal
  storage?: DirectMessageStreamStorageOptions
}

export type DirectMessageStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  firstAccount: Address,
  secondAccount: Address,
  options?: SynchronizeDirectMessageStreamOptions,
) => Promise<DirectMessageStreamSnapshot>

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function cancelledError() {
  return new Error('Direct-message synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function getConversation(firstAccount: Address, secondAccount: Address) {
  const conversationId = getDirectConversationId(firstAccount, secondAccount)
  const first = getAddress(firstAccount)
  const second = getAddress(secondAccount)
  if (
    first.toLowerCase() === ZERO_ADDRESS ||
    second.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error('A public conversation requires two nonzero accounts.')
  }
  return {
    conversationId,
    filter: getDirectMessageConversationFilter(first, second),
    first,
    second,
  }
}

async function requestInContext(
  provider: Eip1193Provider,
  request: ProviderRequest,
  signal: AbortSignal,
) {
  const value = await requestProviderBeforeDeadline(
    provider,
    request,
    Date.now() + WALLET_READ_TIMEOUT_MS,
    () => new Error('Direct-message context read timed out.'),
    signal,
    cancelledError,
  )
  if (signal.aborted) throw cancelledError()
  return value
}

async function assertSelectedChain(
  provider: Eip1193Provider,
  chainId: bigint,
  signal: AbortSignal,
) {
  const value = await requestInContext(
    provider,
    { method: 'eth_chainId' },
    signal,
  )
  if (parseChainId(value) !== chainId) {
    throw new Error('The public conversation belongs to another wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid direct-message head.')
  }
  return BigInt(value)
}

async function readSelectedHead(
  provider: Eip1193Provider,
  chainId: bigint,
  signal: AbortSignal,
) {
  const [chainValue, headValue] = await Promise.all([
    requestInContext(provider, { method: 'eth_chainId' }, signal),
    requestInContext(provider, { method: 'eth_blockNumber' }, signal),
  ])
  if (parseChainId(chainValue) !== chainId) {
    throw new Error('The public conversation belongs to another wallet chain.')
  }
  return parseHead(headValue)
}

async function assertCanonicalCheckpoint(
  provider: Eip1193Provider,
  checkpoint: EventCheckpoint,
  signal: AbortSignal,
) {
  const value = await requestInContext(
    provider,
    {
      method: 'eth_getBlockByNumber',
      params: [`0x${checkpoint.blockNumber.toString(16)}`, false],
    },
    signal,
  )
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'The wallet returned invalid direct-message checkpoint data.',
    )
  }
  const block = value as Record<string, unknown>
  const hash = block.hash
  if (
    parseHead(block.number) !== checkpoint.blockNumber ||
    typeof hash !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(hash) ||
    hash.toLowerCase() !== checkpoint.blockHash
  ) {
    throw new Error(
      'The confirmed direct-message checkpoint changed. Retry the bounded range.',
    )
  }
}

function decodeMessageLogs(
  logs: readonly IndexedEventLog[],
  conversationId: Hash,
  first: Address,
  second: Address,
) {
  const normalizedFirst = first.toLowerCase()
  const normalizedSecond = second.toLowerCase()
  return logs.map((log) => {
    const message = decodePublishedDirectMessage(log)
    if (!message) {
      throw new Error(
        'The direct-message cache contained another event family.',
      )
    }
    const sender = message.sender.toLowerCase()
    const recipient = message.recipient.toLowerCase()
    const hasExpectedParticipants =
      (sender === normalizedFirst && recipient === normalizedSecond) ||
      (sender === normalizedSecond && recipient === normalizedFirst)
    if (
      message.conversationId.toLowerCase() !== conversationId.toLowerCase() ||
      !hasExpectedParticipants
    ) {
      throw new Error(
        'The direct-message cache contained another conversation.',
      )
    }
    return message
  })
}

function sameCursor(first: EventCursor, second: EventCursor) {
  return (
    first.chainId === second.chainId &&
    first.finalityDepth === second.finalityDepth &&
    first.filterId === second.filterId &&
    first.nextBlock === second.nextBlock &&
    first.rangeSize === second.rangeSize &&
    first.startBlock === second.startBlock &&
    first.checkpoints.length === second.checkpoints.length &&
    first.checkpoints.every(
      (checkpoint, index) =>
        checkpoint.blockHash === second.checkpoints[index]?.blockHash &&
        checkpoint.blockNumber === second.checkpoints[index]?.blockNumber,
    )
  )
}

export async function resetDirectMessageStreamCache(
  chainId: bigint,
  firstAccount: Address,
  secondAccount: Address,
  storage: DirectMessageStreamStorageOptions = {},
  startBlock = DIRECT_MESSAGE_START_BLOCK,
) {
  const { filter } = getConversation(firstAccount, secondAccount)
  const seed = createEventCursor({
    chainId,
    filter,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock,
  })
  const cache = await openEventCache({ ...storage, filter })
  try {
    await cache.clear(seed)
  } finally {
    cache.close()
  }
}

export const synchronizeDirectMessageStream: DirectMessageStreamSynchronizer =
  async (provider, chainId, firstAccount, secondAccount, options = {}) => {
    assertActive(options.signal)
    const { conversationId, filter, first, second } = getConversation(
      firstAccount,
      secondAccount,
    )
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
    const assertContextActive = () => {
      assertActive(options.signal)
      if (contextChanged) {
        throw new Error(
          'The wallet chain changed during direct-message verification.',
        )
      }
    }
    try {
      await assertSelectedChain(provider, chainId, interruption.signal)
      assertContextActive()
      const inspection = await inspectProtocol(
        provider,
        WALLET_READ_TIMEOUT_MS,
        interruption.signal,
      )
      assertContextActive()
      await assertSelectedChain(provider, chainId, interruption.signal)
      assertContextActive()
      if (inspection.kind !== 'ready') {
        throw new Error(
          'Verified Lifeinvader v1 is required before this chain can provide public messages.',
        )
      }
      let historyAnchor: ProtocolBlockFingerprint | undefined
      let startBlock = DIRECT_MESSAGE_START_BLOCK
      try {
        const boundary = await (
          options.resolveHistoryBoundary ?? resolveProtocolHistoryBoundary
        )(provider, chainId, {
          finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
          signal: interruption.signal,
        })
        assertContextActive()
        historyAnchor = boundary.head
        startBlock = boundary.startBlock
      } catch (error) {
        assertContextActive()
        if (!isProtocolHistoryUnavailableError(error)) throw error
      }
      const seed = createEventCursor({
        chainId,
        filter,
        finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
        startBlock,
      })
      const cache = await openEventCache({ ...options.storage, filter })
      try {
        assertContextActive()
        let before = await cache.readLatest(seed, DIRECT_MESSAGE_PAGE_SIZE)
        assertContextActive()
        let cacheReset = before.reset
        try {
          decodeMessageLogs(before.logs, conversationId, first, second)
        } catch {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          before = await cache.readLatest(seed, DIRECT_MESSAGE_PAGE_SIZE)
          assertContextActive()
          cacheReset = true
        }
        const result = await syncEventLogs(provider, filter, before.cursor, {
          maxRanges: 1,
          signal: interruption.signal,
        })
        assertContextActive()
        decodeMessageLogs(result.logs, conversationId, first, second)
        // The discovered head commits to the ancestry that established
        // startBlock. Never persist a range if that ancestry was replaced.
        if (
          historyAnchor &&
          !(await protocolHistoryAnchorIsCanonical(
            provider,
            chainId,
            historyAnchor,
            { signal: interruption.signal },
          ))
        ) {
          assertContextActive()
          throw new Error(
            'The protocol history anchor changed during direct-message synchronization. Retry after the chain stabilizes.',
          )
        }
        assertContextActive()
        await cache.apply(before, result)
        assertContextActive()
        const after = await cache.readLatest(seed, DIRECT_MESSAGE_PAGE_SIZE)
        assertContextActive()
        if (
          after.generation !== before.generation ||
          after.revision !== before.revision + 1n ||
          !sameCursor(after.cursor, result.cursor)
        ) {
          throw new Error(
            'The direct-message cache changed after synchronization. Retry the bounded range.',
          )
        }
        let recentMessages: readonly PublishedDirectMessage[]
        try {
          recentMessages = decodeMessageLogs(
            after.logs,
            conversationId,
            first,
            second,
          )
        } catch (error) {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          throw error
        }
        const indexedThrough =
          after.cursor.nextBlock > after.cursor.startBlock
            ? after.cursor.nextBlock - 1n
            : undefined
        const finalCheckpoint = after.cursor.checkpoints.at(-1)
        if (finalCheckpoint) {
          await assertCanonicalCheckpoint(
            provider,
            finalCheckpoint,
            interruption.signal,
          )
          assertContextActive()
        }
        const finalHead = await readSelectedHead(
          provider,
          chainId,
          interruption.signal,
        )
        assertContextActive()
        if (
          indexedThrough !== undefined &&
          (finalHead < indexedThrough ||
            finalHead - indexedThrough < POST_FEED_CONFIRMATION_DEPTH)
        ) {
          throw new Error(
            'The wallet head moved behind the confirmed direct messages. Retry after the chain stabilizes.',
          )
        }
        if (finalCheckpoint) {
          await assertCanonicalCheckpoint(
            provider,
            finalCheckpoint,
            interruption.signal,
          )
          assertContextActive()
        }
        await assertSelectedChain(provider, chainId, interruption.signal)
        assertContextActive()
        const safeHead =
          finalHead >= POST_FEED_CONFIRMATION_DEPTH
            ? finalHead - POST_FEED_CONFIRMATION_DEPTH
            : undefined
        const deploymentStillPending =
          safeHead !== undefined && after.cursor.startBlock > safeHead
        const caughtUp =
          safeHead === undefined ||
          (!deploymentStillPending && after.cursor.nextBlock > safeHead)
        if (
          caughtUp &&
          safeHead !== undefined &&
          finalCheckpoint?.blockNumber !== safeHead
        ) {
          throw new Error(
            'The direct-message stream did not anchor at the confirmed safe head.',
          )
        }
        return {
          cacheReset: cacheReset || after.reset,
          caughtUp,
          conversationId,
          head: finalHead,
          indexedThrough,
          recentMessages,
          safeHead,
          scannedRanges: result.scannedRanges,
          startBlock,
        }
      } finally {
        cache.close()
      }
    } catch (error) {
      assertContextActive()
      throw error
    } finally {
      interruption.abort()
      options.signal?.removeEventListener('abort', interruptRequest)
      provider.removeListener?.('chainChanged', interruptContext)
      provider.removeListener?.('disconnect', interruptContext)
    }
  }
