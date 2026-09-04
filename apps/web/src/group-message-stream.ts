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
  decodePublishedGroupMessage,
  getGroupMessageFilter,
  type PublishedGroupMessage,
} from './protocol-events'
import { inspectProtocol } from './protocol'
import {
  isProtocolHistoryUnavailableError,
  protocolHistoryAnchorIsCanonical,
  resolveProtocolHistoryBoundary,
  type ProtocolBlockFingerprint,
  type ProtocolHistoryBoundaryResolver,
} from './protocol-history'
import {
  beforeDeadline,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

export const GROUP_MESSAGE_PAGE_SIZE = 100
export const GROUP_MESSAGE_START_BLOCK = 0n

export type GroupMessageHistoryBoundaryKind =
  'confirmed' | 'genesis-fallback' | 'pending-confirmation'

export type GroupMessageStreamSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  groupId: bigint
  head: bigint
  historyBoundaryKind: GroupMessageHistoryBoundaryKind
  indexedThrough?: bigint
  recentMessages: readonly PublishedGroupMessage[]
  safeHead?: bigint
  scannedRanges: number
  startBlock: bigint
}

export type GroupMessageStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizeGroupMessageStreamOptions = {
  resolveHistoryBoundary?: ProtocolHistoryBoundaryResolver
  signal?: AbortSignal
  storage?: GroupMessageStreamStorageOptions
}

export type GroupMessageStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  groupId: bigint,
  options?: SynchronizeGroupMessageStreamOptions,
) => Promise<GroupMessageStreamSnapshot>

function cancelledError() {
  return new Error('Group-message synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function getGroup(groupId: bigint) {
  return { filter: getGroupMessageFilter(groupId), groupId }
}

async function requestInContext(
  provider: Eip1193Provider,
  request: ProviderRequest,
  signal: AbortSignal,
) {
  if (signal.aborted) throw cancelledError()
  let handleAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(cancelledError())
    signal.addEventListener('abort', handleAbort, { once: true })
  })
  try {
    const value = await beforeDeadline(
      () => Promise.race([provider.request(request), interrupted]),
      Date.now() + WALLET_READ_TIMEOUT_MS,
      () => new Error('Group-message context read timed out.'),
    )
    if (signal.aborted) throw cancelledError()
    return value
  } finally {
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
  }
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
    throw new Error('The public group belongs to another wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid group-message head.')
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
    throw new Error('The public group belongs to another wallet chain.')
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
      'The wallet returned invalid group-message checkpoint data.',
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
      'The confirmed group-message checkpoint changed. Retry the bounded range.',
    )
  }
}

function decodeMessageLogs(logs: readonly IndexedEventLog[], groupId: bigint) {
  return logs.map((log) => {
    const message = decodePublishedGroupMessage(log)
    if (!message) {
      throw new Error('The group-message cache contained another event family.')
    }
    if (message.groupId !== groupId) {
      throw new Error('The group-message cache contained another group.')
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

export async function resetGroupMessageStreamCache(
  chainId: bigint,
  groupId: bigint,
  storage: GroupMessageStreamStorageOptions = {},
  startBlock = GROUP_MESSAGE_START_BLOCK,
) {
  const { filter } = getGroup(groupId)
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

export const synchronizeGroupMessageStream: GroupMessageStreamSynchronizer =
  async (provider, chainId, selectedGroupId, options = {}) => {
    assertActive(options.signal)
    const { filter, groupId } = getGroup(selectedGroupId)
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
          'The wallet chain changed during group-message verification.',
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
      let historyBoundaryKind: GroupMessageHistoryBoundaryKind =
        'genesis-fallback'
      let startBlock = GROUP_MESSAGE_START_BLOCK
      try {
        const boundary = await (
          options.resolveHistoryBoundary ?? resolveProtocolHistoryBoundary
        )(provider, chainId, {
          finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
          signal: interruption.signal,
        })
        assertContextActive()
        historyAnchor = boundary.head
        historyBoundaryKind = boundary.kind
        startBlock = boundary.startBlock
      } catch (error) {
        assertContextActive()
        if (!isProtocolHistoryUnavailableError(error)) throw error
      }
      if (historyBoundaryKind === 'pending-confirmation') {
        if (
          !historyAnchor ||
          !(await protocolHistoryAnchorIsCanonical(
            provider,
            chainId,
            historyAnchor,
            { signal: interruption.signal },
          ))
        ) {
          assertContextActive()
          throw new Error(
            'The protocol history anchor changed during group-message synchronization. Retry after the chain stabilizes.',
          )
        }
        assertContextActive()
        const finalHead = await readSelectedHead(
          provider,
          chainId,
          interruption.signal,
        )
        assertContextActive()
        if (finalHead < historyAnchor.blockNumber) {
          throw new Error(
            'The wallet head moved behind the group-message history anchor.',
          )
        }
        await assertSelectedChain(provider, chainId, interruption.signal)
        assertContextActive()
        return {
          cacheReset: false,
          caughtUp: false,
          groupId,
          head: finalHead,
          historyBoundaryKind,
          indexedThrough: undefined,
          recentMessages: [],
          safeHead:
            finalHead >= POST_FEED_CONFIRMATION_DEPTH
              ? finalHead - POST_FEED_CONFIRMATION_DEPTH
              : undefined,
          scannedRanges: 0,
          startBlock,
        }
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
        let before = await cache.readLatest(seed, GROUP_MESSAGE_PAGE_SIZE)
        assertContextActive()
        let cacheReset = before.reset
        try {
          decodeMessageLogs(before.logs, groupId)
        } catch {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          before = await cache.readLatest(seed, GROUP_MESSAGE_PAGE_SIZE)
          assertContextActive()
          cacheReset = true
        }
        const result = await syncEventLogs(provider, filter, before.cursor, {
          maxRanges: 1,
          signal: interruption.signal,
        })
        assertContextActive()
        decodeMessageLogs(result.logs, groupId)
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
            'The protocol history anchor changed during group-message synchronization. Retry after the chain stabilizes.',
          )
        }
        assertContextActive()
        await cache.apply(before, result)
        assertContextActive()
        const after = await cache.readLatest(seed, GROUP_MESSAGE_PAGE_SIZE)
        assertContextActive()
        if (
          after.generation !== before.generation ||
          after.revision !== before.revision + 1n ||
          !sameCursor(after.cursor, result.cursor)
        ) {
          throw new Error(
            'The group-message cache changed after synchronization. Retry the bounded range.',
          )
        }
        let decodedPage: readonly PublishedGroupMessage[]
        try {
          decodedPage = decodeMessageLogs(after.logs, groupId)
        } catch (error) {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          throw error
        }
        const recentMessages = decodedPage.slice(0, GROUP_MESSAGE_PAGE_SIZE)
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
            'The wallet head moved behind the confirmed group messages. Retry after the chain stabilizes.',
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
        const caughtUp =
          safeHead !== undefined && after.cursor.nextBlock > safeHead
        if (
          caughtUp &&
          safeHead !== undefined &&
          finalCheckpoint?.blockNumber !== safeHead
        ) {
          throw new Error(
            'The group-message stream did not anchor at the confirmed safe head.',
          )
        }
        return {
          cacheReset: cacheReset || after.reset,
          caughtUp,
          groupId,
          head: finalHead,
          historyBoundaryKind,
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
