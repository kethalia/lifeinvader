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
  type IndexedEventLog,
} from './event-indexer'
import {
  decodeProfileSet,
  PROFILE_SET_FILTER,
  type ProfileSet,
} from './protocol-events'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import { inspectProtocol } from './protocol'
import {
  parseChainId,
  requestProviderBeforeDeadline,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  isProtocolHistoryUnavailableError,
  protocolHistoryAnchorIsCanonical,
  resolveProtocolHistoryBoundary,
  type ProtocolBlockFingerprint,
  type ProtocolHistoryBoundaryResolver,
} from './protocol-history'

export const PROFILE_EVENT_PAGE_SIZE = 200
export const PROFILE_EVENT_START_BLOCK = 0n
const MAX_PROTOCOL_HISTORY_SYNC_RETRIES = 1

export type ProfileProjectionAnchor = {
  readonly chainId: bigint
  readonly profiles: EventCachePosition
  readonly head: bigint
  readonly safeHead?: bigint
}

export type ProfileStreamSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  head: bigint
  indexedThrough?: bigint
  projectionAnchor?: ProfileProjectionAnchor
  recentProfiles: readonly ProfileSet[]
  safeHead?: bigint
  scannedRanges: number
  startBlock: bigint
}

export type ProfileStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizeProfileStreamOptions = {
  resolveHistoryBoundary?: ProtocolHistoryBoundaryResolver
  signal?: AbortSignal
  storage?: ProfileStreamStorageOptions
}

export type ProfileStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  options?: SynchronizeProfileStreamOptions,
) => Promise<ProfileStreamSnapshot>

export type ProfileStreamCacheResetter = (
  chainId: bigint,
  startBlock: bigint,
) => Promise<void>

type IssuedProfileProjectionAnchor = {
  chainId: bigint
  checkpoint?: EventCheckpoint
  head: bigint
  provider: Eip1193Provider
}

const issuedProjectionAnchors = new WeakMap<
  ProfileProjectionAnchor,
  IssuedProfileProjectionAnchor
>()

function cancelledError() {
  return new Error('Profile synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function copyCursor(cursor: EventCursor): EventCursor {
  return {
    ...cursor,
    checkpoints: cursor.checkpoints.map((checkpoint) => ({ ...checkpoint })),
  }
}

function issueProjectionAnchor(
  provider: Eip1193Provider,
  chainId: bigint,
  profiles: EventCachePosition,
  head: bigint,
  safeHead: bigint | undefined,
) {
  const checkpoints = profiles.cursor.checkpoints.map((checkpoint) =>
    Object.freeze({ ...checkpoint }),
  )
  const cursor = Object.freeze({
    ...copyCursor(profiles.cursor),
    checkpoints: Object.freeze(checkpoints),
  }) as EventCursor
  const position = Object.freeze({
    cursor,
    generation: profiles.generation,
    revision: profiles.revision,
  }) as EventCachePosition
  const anchor = Object.freeze({
    chainId,
    profiles: position,
    head,
    safeHead,
  }) satisfies ProfileProjectionAnchor
  const checkpoint = cursor.checkpoints.at(-1)
  issuedProjectionAnchors.set(anchor, {
    chainId,
    checkpoint: checkpoint ? { ...checkpoint } : undefined,
    head,
    provider,
  })
  return anchor
}

export function assertIssuedProfileProjectionAnchor(
  value: unknown,
): asserts value is ProfileProjectionAnchor {
  if (
    typeof value !== 'object' ||
    value === null ||
    !issuedProjectionAnchors.has(value as ProfileProjectionAnchor)
  ) {
    throw new Error(
      'The profile projection anchor was not issued by this page.',
    )
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
    () => new Error('Profile context read timed out.'),
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
    throw new Error('The profiles belong to a different wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid profile head.')
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
    throw new Error('The profiles belong to a different wallet chain.')
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
    throw new Error('The wallet returned invalid profile checkpoint data.')
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
      'The confirmed profile checkpoint changed. Retry the bounded range.',
    )
  }
}

export async function authenticateIssuedProfileProjectionAnchor(
  anchor: ProfileProjectionAnchor,
  authenticateCache: () => Promise<void>,
  signal?: AbortSignal,
) {
  assertIssuedProfileProjectionAnchor(anchor)
  if (typeof authenticateCache !== 'function') {
    throw new Error('The profile cache authenticator is invalid.')
  }
  assertActive(signal)
  const issued = issuedProjectionAnchors.get(anchor)!
  const interruption = new AbortController()
  let contextChanged = false
  const interruptContext = () => {
    contextChanged = true
    interruption.abort()
  }
  const interruptRequest = () => interruption.abort()
  issued.provider.on?.('chainChanged', interruptContext)
  issued.provider.on?.('disconnect', interruptContext)
  signal?.addEventListener('abort', interruptRequest, { once: true })
  const assertContextActive = () => {
    assertActive(signal)
    if (contextChanged) {
      throw new Error(
        'The wallet chain changed during profile anchor authentication.',
      )
    }
  }
  try {
    await assertSelectedChain(
      issued.provider,
      issued.chainId,
      interruption.signal,
    )
    assertContextActive()
    if (issued.checkpoint) {
      await assertCanonicalCheckpoint(
        issued.provider,
        issued.checkpoint,
        interruption.signal,
      )
      assertContextActive()
    }
    const currentHead = await readSelectedHead(
      issued.provider,
      issued.chainId,
      interruption.signal,
    )
    assertContextActive()
    if (currentHead < issued.head) {
      throw new Error(
        'The wallet head moved behind the profile projection anchor.',
      )
    }
    await authenticateCache()
    assertContextActive()
    if (issued.checkpoint) {
      await assertCanonicalCheckpoint(
        issued.provider,
        issued.checkpoint,
        interruption.signal,
      )
      assertContextActive()
    }
    await assertSelectedChain(
      issued.provider,
      issued.chainId,
      interruption.signal,
    )
    assertContextActive()
  } catch (error) {
    assertContextActive()
    throw error
  } finally {
    interruption.abort()
    signal?.removeEventListener('abort', interruptRequest)
    issued.provider.removeListener?.('chainChanged', interruptContext)
    issued.provider.removeListener?.('disconnect', interruptContext)
  }
}

function decodeProfileLogs(logs: readonly IndexedEventLog[]) {
  return logs.map((log) => {
    const profile = decodeProfileSet(log)
    if (!profile) {
      throw new Error('The profile cache contained another event.')
    }
    return profile
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

export async function resetProfileStreamCache(
  chainId: bigint,
  storage: ProfileStreamStorageOptions = {},
  startBlock = PROFILE_EVENT_START_BLOCK,
) {
  const seed = createEventCursor({
    chainId,
    filter: PROFILE_SET_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock,
  })
  const cache = await openEventCache({ ...storage, filter: PROFILE_SET_FILTER })
  try {
    await cache.clear(seed)
  } finally {
    cache.close()
  }
}

export const synchronizeProfileStream: ProfileStreamSynchronizer = async (
  provider,
  chainId,
  options = {},
) => {
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
      throw new Error('The wallet chain changed during profile verification.')
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
        'Verified Lifeinvader v1 is required before this chain can provide profiles.',
      )
    }
    let historyRetries = 0
    while (true) {
      let historyAnchor: ProtocolBlockFingerprint | undefined
      let startBlock = PROFILE_EVENT_START_BLOCK
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
        filter: PROFILE_SET_FILTER,
        finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
        startBlock,
      })
      const cache = await openEventCache({
        ...options.storage,
        filter: PROFILE_SET_FILTER,
      })
      try {
        assertContextActive()
        let before = await cache.readLatest(seed, PROFILE_EVENT_PAGE_SIZE)
        assertContextActive()
        let cacheReset = before.reset
        try {
          decodeProfileLogs(before.logs)
        } catch {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          before = await cache.readLatest(seed, PROFILE_EVENT_PAGE_SIZE)
          assertContextActive()
          cacheReset = true
        }
        const result = await syncEventLogs(
          provider,
          PROFILE_SET_FILTER,
          before.cursor,
          { maxRanges: 1, signal: interruption.signal },
        )
        assertContextActive()
        decodeProfileLogs(result.logs)
        // The discovered head commits to the ancestry that established
        // startBlock. Do not persist a range if that ancestry was replaced.
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
          if (historyRetries >= MAX_PROTOCOL_HISTORY_SYNC_RETRIES) {
            throw new Error(
              'The protocol history anchor kept changing during profile synchronization. Retry after the chain stabilizes.',
            )
          }
          historyRetries += 1
          continue
        }
        assertContextActive()
        await cache.apply(before, result)
        assertContextActive()
        const after = await cache.readLatest(seed, PROFILE_EVENT_PAGE_SIZE)
        assertContextActive()
        if (
          after.generation !== before.generation ||
          after.revision !== before.revision + 1n ||
          !sameCursor(after.cursor, result.cursor)
        ) {
          throw new Error(
            'The profile cache changed after synchronization. Retry the bounded range.',
          )
        }
        let recentProfiles: readonly ProfileSet[]
        try {
          recentProfiles = decodeProfileLogs(after.logs)
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
            'The wallet head moved behind the confirmed profiles. Retry after the chain stabilizes.',
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
            'The profile stream did not anchor at the confirmed safe head.',
          )
        }
        const position = {
          cursor: after.cursor,
          generation: after.generation,
          revision: after.revision,
        }
        return {
          cacheReset: cacheReset || after.reset,
          caughtUp,
          head: finalHead,
          indexedThrough,
          projectionAnchor: caughtUp
            ? issueProjectionAnchor(
                provider,
                chainId,
                position,
                finalHead,
                safeHead,
              )
            : undefined,
          recentProfiles,
          safeHead,
          scannedRanges: result.scannedRanges,
          startBlock,
        }
      } finally {
        cache.close()
      }
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
