import {
  openEventCache,
  type EventCachePosition,
  type OpenEventCacheOptions,
} from './event-cache'
import {
  createEventCursor,
  syncEventLogs,
  type EventCheckpoint,
  type EventCursor,
  type EventLogFilter,
  type IndexedEventLog,
} from './event-indexer'
import {
  decodePostLikeSet,
  decodePublishedRepost,
  POST_LIKE_SET_FILTER,
  PUBLISHED_REPOST_FILTER,
  type PostLikeSet,
  type PublishedRepost,
} from './protocol-events'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { inspectProtocol } from './protocol'
import {
  beforeDeadline,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

export const POST_REACTION_EVENT_PAGE_SIZE = 200
export const POST_REACTION_EVENT_START_BLOCK = 0n

type ReactionEventStreamSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  head: bigint
  indexedThrough?: bigint
  safeHead?: bigint
  scannedRanges: number
}

export type PostReactionStreamSnapshot = {
  likes: ReactionEventStreamSnapshot & {
    recentSignals: readonly PostLikeSet[]
  }
  projectionAnchor?: PostReactionProjectionAnchor
  reposts: ReactionEventStreamSnapshot & {
    recentReposts: readonly PublishedRepost[]
  }
}

export type PostReactionProjectionAnchor = {
  chainId: bigint
  head: bigint
  likes: EventCachePosition
  reposts: EventCachePosition
  safeHead?: bigint
}

export type PostReactionStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizePostReactionStreamOptions = {
  signal?: AbortSignal
  storage?: PostReactionStreamStorageOptions
}

export type PostReactionStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  options?: SynchronizePostReactionStreamOptions,
) => Promise<PostReactionStreamSnapshot>

type EventDecoder<Event> = (log: IndexedEventLog) => Event | undefined

type StreamDefinition<Event> = {
  decode: EventDecoder<Event>
  filter: EventLogFilter
  label: string
}

type SynchronizedStream<Event> = ReactionEventStreamSnapshot & {
  checkpoint?: EventCheckpoint
  events: readonly Event[]
  nextBlock: bigint
  position: EventCachePosition
}

function cancelledError() {
  return new Error('Post reaction synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
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
      () => new Error('Post reaction context read timed out.'),
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
    throw new Error('The post reactions belong to a different wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid post reaction head.')
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
    throw new Error('The post reactions belong to a different wallet chain.')
  }
  return parseHead(headValue)
}

async function assertCanonicalCheckpoint(
  provider: Eip1193Provider,
  checkpoint: EventCheckpoint,
  signal: AbortSignal,
  label: string,
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
    throw new Error(`The wallet returned invalid ${label} checkpoint data.`)
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
      `The confirmed ${label} checkpoint changed. Retry the bounded range.`,
    )
  }
}

function decodeEvents<Event>(
  logs: readonly IndexedEventLog[],
  definition: StreamDefinition<Event>,
) {
  return logs.map((log) => {
    const event = definition.decode(log)
    if (!event) {
      throw new Error(`The ${definition.label} cache contained another event.`)
    }
    return event
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

function assertSharedProjectionCheckpoint(
  likes: SynchronizedStream<PostLikeSet>,
  reposts: SynchronizedStream<PublishedRepost>,
  safeHead: bigint | undefined,
) {
  if (safeHead === undefined) return
  const likeCheckpoint = likes.position.cursor.checkpoints.at(-1)
  const repostCheckpoint = reposts.position.cursor.checkpoints.at(-1)
  if (
    !likeCheckpoint ||
    !repostCheckpoint ||
    likeCheckpoint.blockNumber !== safeHead ||
    repostCheckpoint.blockNumber !== safeHead ||
    likeCheckpoint.blockHash !== repostCheckpoint.blockHash
  ) {
    throw new Error(
      'The post reaction streams do not share one confirmed safe-head block.',
    )
  }
}

async function synchronizeStream<Event>(
  provider: Eip1193Provider,
  chainId: bigint,
  definition: StreamDefinition<Event>,
  signal: AbortSignal,
  storage?: PostReactionStreamStorageOptions,
): Promise<SynchronizedStream<Event>> {
  const seed = createEventCursor({
    chainId,
    filter: definition.filter,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: POST_REACTION_EVENT_START_BLOCK,
  })
  const cache = await openEventCache({ ...storage, filter: definition.filter })
  try {
    if (signal.aborted) throw cancelledError()
    let before = await cache.readLatest(seed, POST_REACTION_EVENT_PAGE_SIZE)
    let cacheReset = before.reset
    try {
      decodeEvents(before.logs, definition)
    } catch {
      await cache.clear(seed)
      before = await cache.readLatest(seed, POST_REACTION_EVENT_PAGE_SIZE)
      cacheReset = true
    }
    const result = await syncEventLogs(
      provider,
      definition.filter,
      before.cursor,
      { maxRanges: 1, signal },
    )
    if (signal.aborted) throw cancelledError()
    decodeEvents(result.logs, definition)
    await cache.apply(before, result)
    if (signal.aborted) throw cancelledError()
    const after = await cache.readLatest(seed, POST_REACTION_EVENT_PAGE_SIZE)
    if (
      after.generation !== before.generation ||
      after.revision !== before.revision + 1n ||
      !sameCursor(after.cursor, result.cursor)
    ) {
      throw new Error(
        `The ${definition.label} cache changed after synchronization. Retry the bounded range.`,
      )
    }
    let events: readonly Event[]
    try {
      events = decodeEvents(after.logs, definition)
    } catch (error) {
      await cache.clear(seed)
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
        signal,
        definition.label,
      )
    }
    const finalHead = await readSelectedHead(provider, chainId, signal)
    if (
      indexedThrough !== undefined &&
      (finalHead < indexedThrough ||
        finalHead - indexedThrough < POST_FEED_CONFIRMATION_DEPTH)
    ) {
      throw new Error(
        `The wallet head moved behind the confirmed ${definition.label}. Retry after the chain stabilizes.`,
      )
    }
    if (finalCheckpoint) {
      await assertCanonicalCheckpoint(
        provider,
        finalCheckpoint,
        signal,
        definition.label,
      )
    }
    const safeHead =
      finalHead >= POST_FEED_CONFIRMATION_DEPTH
        ? finalHead - POST_FEED_CONFIRMATION_DEPTH
        : undefined
    return {
      cacheReset: cacheReset || after.reset,
      caughtUp: safeHead === undefined || after.cursor.nextBlock > safeHead,
      checkpoint: finalCheckpoint,
      events,
      head: finalHead,
      indexedThrough,
      nextBlock: after.cursor.nextBlock,
      position: {
        cursor: after.cursor,
        generation: after.generation,
        revision: after.revision,
      },
      safeHead,
      scannedRanges: result.scannedRanges,
    }
  } finally {
    cache.close()
  }
}

const LIKE_STREAM = {
  decode: decodePostLikeSet,
  filter: POST_LIKE_SET_FILTER,
  label: 'post-like stream',
} as const satisfies StreamDefinition<PostLikeSet>

const REPOST_STREAM = {
  decode: decodePublishedRepost,
  filter: PUBLISHED_REPOST_FILTER,
  label: 'repost stream',
} as const satisfies StreamDefinition<PublishedRepost>

async function verifyCombinedSnapshot(
  provider: Eip1193Provider,
  chainId: bigint,
  likes: SynchronizedStream<PostLikeSet>,
  reposts: SynchronizedStream<PublishedRepost>,
  signal: AbortSignal,
) {
  const streams = [
    {
      checkpoint: likes.checkpoint,
      indexedThrough: likes.indexedThrough,
      label: LIKE_STREAM.label,
    },
    {
      checkpoint: reposts.checkpoint,
      indexedThrough: reposts.indexedThrough,
      label: REPOST_STREAM.label,
    },
  ]
  const verifyCheckpoints = () =>
    Promise.all(
      streams.map(({ checkpoint, label }) =>
        checkpoint
          ? assertCanonicalCheckpoint(provider, checkpoint, signal, label)
          : Promise.resolve(),
      ),
    )
  await verifyCheckpoints()
  const head = await readSelectedHead(provider, chainId, signal)
  for (const { indexedThrough, label } of streams) {
    if (
      indexedThrough !== undefined &&
      (head < indexedThrough ||
        head - indexedThrough < POST_FEED_CONFIRMATION_DEPTH)
    ) {
      throw new Error(
        `The wallet head moved behind the confirmed ${label}. Retry after the chain stabilizes.`,
      )
    }
  }
  await verifyCheckpoints()
  await assertSelectedChain(provider, chainId, signal)
  return {
    head,
    safeHead:
      head >= POST_FEED_CONFIRMATION_DEPTH
        ? head - POST_FEED_CONFIRMATION_DEPTH
        : undefined,
  }
}

export const synchronizePostReactionStream: PostReactionStreamSynchronizer =
  async (provider, chainId, options = {}) => {
    assertActive(options.signal)
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
          'The wallet chain changed during post reaction verification.',
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
          'Verified Lifeinvader v1 is required before this chain can provide post reactions.',
        )
      }
      const likes = await synchronizeStream(
        provider,
        chainId,
        LIKE_STREAM,
        interruption.signal,
        options.storage,
      )
      assertContextActive()
      const reposts = await synchronizeStream(
        provider,
        chainId,
        REPOST_STREAM,
        interruption.signal,
        options.storage,
      )
      assertContextActive()
      const shared = await verifyCombinedSnapshot(
        provider,
        chainId,
        likes,
        reposts,
        interruption.signal,
      )
      assertContextActive()
      const likesCaughtUp =
        shared.safeHead === undefined || likes.nextBlock > shared.safeHead
      const repostsCaughtUp =
        shared.safeHead === undefined || reposts.nextBlock > shared.safeHead
      if (likesCaughtUp && repostsCaughtUp) {
        assertSharedProjectionCheckpoint(likes, reposts, shared.safeHead)
      }
      return {
        likes: {
          cacheReset: likes.cacheReset,
          caughtUp: likesCaughtUp,
          head: shared.head,
          indexedThrough: likes.indexedThrough,
          recentSignals: likes.events,
          safeHead: shared.safeHead,
          scannedRanges: likes.scannedRanges,
        },
        projectionAnchor:
          likesCaughtUp && repostsCaughtUp
            ? {
                chainId,
                head: shared.head,
                likes: likes.position,
                reposts: reposts.position,
                safeHead: shared.safeHead,
              }
            : undefined,
        reposts: {
          cacheReset: reposts.cacheReset,
          caughtUp: repostsCaughtUp,
          head: shared.head,
          indexedThrough: reposts.indexedThrough,
          recentReposts: reposts.events,
          safeHead: shared.safeHead,
          scannedRanges: reposts.scannedRanges,
        },
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
