import { getAddress, type Address } from 'viem'
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
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import {
  decodeFollowSet,
  getFollowersFilter,
  getFollowingFilter,
  type FollowSet,
} from './protocol-events'
import { inspectProtocol } from './protocol'
import {
  parseChainId,
  requestProviderBeforeDeadline,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import type { FollowDirection } from './follow-projection'
import {
  isProtocolHistoryUnavailableError,
  protocolHistoryAnchorIsCanonical,
  resolveProtocolHistoryBoundary,
  type ProtocolBlockFingerprint,
  type ProtocolHistoryBoundaryResolver,
} from './protocol-history'

export const FOLLOW_EVENT_PAGE_SIZE = 200
export const FOLLOW_EVENT_START_BLOCK = 0n
const MAX_PROTOCOL_HISTORY_SYNC_RETRIES = 1
export type { FollowDirection } from './follow-projection'

export type FollowProjectionAnchor = {
  readonly account: Address
  readonly chainId: bigint
  readonly direction: FollowDirection
  readonly head: bigint
  readonly follows: EventCachePosition
  readonly safeHead?: bigint
}

export type FollowStreamSnapshot = {
  account: Address
  cacheReset: boolean
  caughtUp: boolean
  direction: FollowDirection
  head: bigint
  indexedThrough?: bigint
  projectionAnchor?: FollowProjectionAnchor
  recentSignals: readonly FollowSet[]
  safeHead?: bigint
  scannedRanges: number
  startBlock: bigint
}

export type FollowStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizeFollowStreamOptions = {
  resolveHistoryBoundary?: ProtocolHistoryBoundaryResolver
  signal?: AbortSignal
  storage?: FollowStreamStorageOptions
}

export type FollowStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  account: Address,
  direction: FollowDirection,
  options?: SynchronizeFollowStreamOptions,
) => Promise<FollowStreamSnapshot>

type IssuedFollowProjectionAnchor = {
  account: Address
  chainId: bigint
  checkpoint?: EventCheckpoint
  direction: FollowDirection
  head: bigint
  provider: Eip1193Provider
}

const issuedProjectionAnchors = new WeakMap<
  FollowProjectionAnchor,
  IssuedFollowProjectionAnchor
>()

function cancelledError() {
  return new Error('Follow synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function getScope(accountValue: Address, direction: FollowDirection) {
  let account: Address
  try {
    account = getAddress(accountValue)
  } catch {
    throw new Error('The selected follow account is invalid.')
  }
  if (direction !== 'followers' && direction !== 'following') {
    throw new Error('The selected follow direction is invalid.')
  }
  return {
    account,
    direction,
    filter:
      direction === 'followers'
        ? getFollowersFilter(account)
        : getFollowingFilter(account),
  }
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
  account: Address,
  direction: FollowDirection,
  follows: EventCachePosition,
  head: bigint,
  safeHead: bigint | undefined,
) {
  const checkpoints = follows.cursor.checkpoints.map((checkpoint) =>
    Object.freeze({ ...checkpoint }),
  )
  const cursor = Object.freeze({
    ...copyCursor(follows.cursor),
    checkpoints: Object.freeze(checkpoints),
  }) as EventCursor
  const position = Object.freeze({
    cursor,
    generation: follows.generation,
    revision: follows.revision,
  }) as EventCachePosition
  const anchor = Object.freeze({
    account,
    chainId,
    direction,
    head,
    follows: position,
    safeHead,
  }) satisfies FollowProjectionAnchor
  const checkpoint = cursor.checkpoints.at(-1)
  issuedProjectionAnchors.set(anchor, {
    account,
    chainId,
    checkpoint: checkpoint ? { ...checkpoint } : undefined,
    direction,
    head,
    provider,
  })
  return anchor
}

export function assertIssuedFollowProjectionAnchor(
  value: unknown,
): asserts value is FollowProjectionAnchor {
  if (
    typeof value !== 'object' ||
    value === null ||
    !issuedProjectionAnchors.has(value as FollowProjectionAnchor)
  ) {
    throw new Error('The follow projection anchor was not issued by this page.')
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
    () => new Error('Follow context read timed out.'),
    signal,
    cancelledError,
  )
  if (signal.aborted) throw cancelledError()
  return value
}

async function authenticateCacheInContext(
  authenticateCache: () => Promise<void>,
  signal: AbortSignal,
) {
  if (signal.aborted) throw cancelledError()
  let handleAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(cancelledError())
    signal.addEventListener('abort', handleAbort, { once: true })
  })
  try {
    await Promise.race([Promise.resolve().then(authenticateCache), interrupted])
    if (signal.aborted) throw cancelledError()
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
    throw new Error('The follow stream belongs to another wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid follow head.')
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
    throw new Error('The follow stream belongs to another wallet chain.')
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
    throw new Error('The wallet returned invalid follow checkpoint data.')
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
      'The confirmed follow checkpoint changed. Retry the bounded range.',
    )
  }
}

export async function authenticateIssuedFollowProjectionAnchor(
  anchor: FollowProjectionAnchor,
  authenticateCache: () => Promise<void>,
  signal?: AbortSignal,
) {
  assertIssuedFollowProjectionAnchor(anchor)
  if (typeof authenticateCache !== 'function') {
    throw new Error('The follow cache authenticator is invalid.')
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
        'The wallet chain changed during follow anchor authentication.',
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
        'The wallet head moved behind the follow projection anchor.',
      )
    }
    await authenticateCacheInContext(authenticateCache, interruption.signal)
    assertContextActive()
    if (issued.checkpoint) {
      await assertCanonicalCheckpoint(
        issued.provider,
        issued.checkpoint,
        interruption.signal,
      )
      assertContextActive()
    }
    const finalHead = await readSelectedHead(
      issued.provider,
      issued.chainId,
      interruption.signal,
    )
    assertContextActive()
    if (finalHead < issued.head) {
      throw new Error(
        'The wallet head moved behind the follow projection anchor.',
      )
    }
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

function decodeFollowLogs(
  logs: readonly IndexedEventLog[],
  account: Address,
  direction: FollowDirection,
) {
  return logs.map((log) => {
    const follow = decodeFollowSet(log)
    if (!follow) {
      throw new Error('The follow cache contained another event family.')
    }
    const scopedAccount =
      direction === 'followers' ? follow.followed : follow.follower
    if (scopedAccount.toLowerCase() !== account.toLowerCase()) {
      throw new Error('The follow cache contained another account.')
    }
    return follow
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

export async function resetFollowStreamCache(
  chainId: bigint,
  accountValue: Address,
  direction: FollowDirection,
  storage: FollowStreamStorageOptions = {},
  startBlock = FOLLOW_EVENT_START_BLOCK,
) {
  const { filter } = getScope(accountValue, direction)
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

export const synchronizeFollowStream: FollowStreamSynchronizer = async (
  provider,
  chainId,
  accountValue,
  directionValue,
  options = {},
) => {
  assertActive(options.signal)
  const { account, direction, filter } = getScope(accountValue, directionValue)
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
      throw new Error('The wallet chain changed during follow verification.')
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
        'Verified Lifeinvader v1 is required before this chain can provide public follows.',
      )
    }
    let historyRetries = 0
    while (true) {
      let historyAnchor: ProtocolBlockFingerprint | undefined
      let startBlock = FOLLOW_EVENT_START_BLOCK
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
        let before = await cache.readLatest(seed, FOLLOW_EVENT_PAGE_SIZE)
        assertContextActive()
        let cacheReset = before.reset
        try {
          decodeFollowLogs(before.logs, account, direction)
        } catch {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          before = await cache.readLatest(seed, FOLLOW_EVENT_PAGE_SIZE)
          assertContextActive()
          cacheReset = true
        }
        const result = await syncEventLogs(provider, filter, before.cursor, {
          maxRanges: 1,
          signal: interruption.signal,
        })
        assertContextActive()
        decodeFollowLogs(result.logs, account, direction)
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
              'The protocol history anchor kept changing during follow synchronization. Retry after the chain stabilizes.',
            )
          }
          historyRetries += 1
          continue
        }
        assertContextActive()
        await cache.apply(before, result)
        assertContextActive()
        const after = await cache.readLatest(seed, FOLLOW_EVENT_PAGE_SIZE)
        assertContextActive()
        if (
          after.generation !== before.generation ||
          after.revision !== before.revision + 1n ||
          !sameCursor(after.cursor, result.cursor)
        ) {
          throw new Error(
            'The follow cache changed after synchronization. Retry the bounded range.',
          )
        }
        let decodedPage: readonly FollowSet[]
        try {
          decodedPage = decodeFollowLogs(after.logs, account, direction)
        } catch (error) {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          throw error
        }
        const recentSignals = decodedPage.slice(0, FOLLOW_EVENT_PAGE_SIZE)
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
            'The wallet head moved behind the confirmed follows. Retry after the chain stabilizes.',
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
            'The follow stream did not anchor at the confirmed safe head.',
          )
        }
        const position = {
          cursor: after.cursor,
          generation: after.generation,
          revision: after.revision,
        }
        return {
          account,
          cacheReset: cacheReset || after.reset,
          caughtUp,
          direction,
          head: finalHead,
          indexedThrough,
          projectionAnchor: caughtUp
            ? issueProjectionAnchor(
                provider,
                chainId,
                account,
                direction,
                position,
                finalHead,
                safeHead,
              )
            : undefined,
          recentSignals,
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
