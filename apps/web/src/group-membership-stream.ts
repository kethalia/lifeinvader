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
  decodeGroupMembershipSet,
  getGroupMembershipFilter,
  type GroupMembershipSet,
} from './protocol-events'
import { inspectProtocol } from './protocol'
import {
  beforeDeadline,
  parseChainId,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

export const GROUP_MEMBERSHIP_EVENT_PAGE_SIZE = 200
export const GROUP_MEMBERSHIP_EVENT_START_BLOCK = 0n

export type GroupMembershipProjectionAnchor = {
  readonly chainId: bigint
  readonly groupId: bigint
  readonly head: bigint
  readonly memberships: EventCachePosition
  readonly safeHead?: bigint
}

export type GroupMembershipStreamSnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  groupId: bigint
  head: bigint
  indexedThrough?: bigint
  projectionAnchor?: GroupMembershipProjectionAnchor
  recentSignals: readonly GroupMembershipSet[]
  safeHead?: bigint
  scannedRanges: number
}

export type GroupMembershipStreamStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizeGroupMembershipStreamOptions = {
  signal?: AbortSignal
  storage?: GroupMembershipStreamStorageOptions
}

export type GroupMembershipStreamSynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  groupId: bigint,
  options?: SynchronizeGroupMembershipStreamOptions,
) => Promise<GroupMembershipStreamSnapshot>

type IssuedGroupMembershipProjectionAnchor = {
  chainId: bigint
  checkpoint?: EventCheckpoint
  groupId: bigint
  head: bigint
  provider: Eip1193Provider
}

const issuedProjectionAnchors = new WeakMap<
  GroupMembershipProjectionAnchor,
  IssuedGroupMembershipProjectionAnchor
>()

function cancelledError() {
  return new Error('Group-membership synchronization was cancelled.')
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function getGroup(groupId: bigint) {
  return { filter: getGroupMembershipFilter(groupId), groupId }
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
  groupId: bigint,
  memberships: EventCachePosition,
  head: bigint,
  safeHead: bigint | undefined,
) {
  const checkpoints = memberships.cursor.checkpoints.map((checkpoint) =>
    Object.freeze({ ...checkpoint }),
  )
  const cursor = Object.freeze({
    ...copyCursor(memberships.cursor),
    checkpoints: Object.freeze(checkpoints),
  }) as EventCursor
  const position = Object.freeze({
    cursor,
    generation: memberships.generation,
    revision: memberships.revision,
  }) as EventCachePosition
  const anchor = Object.freeze({
    chainId,
    groupId,
    head,
    memberships: position,
    safeHead,
  }) satisfies GroupMembershipProjectionAnchor
  const checkpoint = cursor.checkpoints.at(-1)
  issuedProjectionAnchors.set(anchor, {
    chainId,
    checkpoint: checkpoint ? { ...checkpoint } : undefined,
    groupId,
    head,
    provider,
  })
  return anchor
}

export function assertIssuedGroupMembershipProjectionAnchor(
  value: unknown,
): asserts value is GroupMembershipProjectionAnchor {
  if (
    typeof value !== 'object' ||
    value === null ||
    !issuedProjectionAnchors.has(value as GroupMembershipProjectionAnchor)
  ) {
    throw new Error(
      'The group-membership projection anchor was not issued by this page.',
    )
  }
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
      () => new Error('Group-membership context read timed out.'),
    )
    if (signal.aborted) throw cancelledError()
    return value
  } finally {
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
  }
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
    throw new Error('The public group belongs to another wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid group-membership head.')
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
      'The wallet returned invalid group-membership checkpoint data.',
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
      'The confirmed group-membership checkpoint changed. Retry the bounded range.',
    )
  }
}

export async function authenticateIssuedGroupMembershipProjectionAnchor(
  anchor: GroupMembershipProjectionAnchor,
  authenticateCache: () => Promise<void>,
  signal?: AbortSignal,
) {
  assertIssuedGroupMembershipProjectionAnchor(anchor)
  if (typeof authenticateCache !== 'function') {
    throw new Error('The group-membership cache authenticator is invalid.')
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
        'The wallet chain changed during group-membership anchor authentication.',
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
        'The wallet head moved behind the group-membership projection anchor.',
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
        'The wallet head moved behind the group-membership projection anchor.',
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

function decodeMembershipLogs(
  logs: readonly IndexedEventLog[],
  groupId: bigint,
) {
  return logs.map((log) => {
    const membership = decodeGroupMembershipSet(log)
    if (!membership) {
      throw new Error(
        'The group-membership cache contained another event family.',
      )
    }
    if (membership.groupId !== groupId) {
      throw new Error('The group-membership cache contained another group.')
    }
    return membership
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

export async function resetGroupMembershipStreamCache(
  chainId: bigint,
  groupId: bigint,
  storage: GroupMembershipStreamStorageOptions = {},
) {
  const { filter } = getGroup(groupId)
  const seed = createEventCursor({
    chainId,
    filter,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
  })
  const cache = await openEventCache({ ...storage, filter })
  try {
    await cache.clear(seed)
  } finally {
    cache.close()
  }
}

export const synchronizeGroupMembershipStream: GroupMembershipStreamSynchronizer =
  async (provider, chainId, selectedGroupId, options = {}) => {
    assertActive(options.signal)
    const { filter, groupId } = getGroup(selectedGroupId)
    const seed = createEventCursor({
      chainId,
      filter,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
    })
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
          'The wallet chain changed during group-membership verification.',
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
          'Verified Lifeinvader v1 is required before this chain can provide public group membership.',
        )
      }
      const cache = await openEventCache({ ...options.storage, filter })
      try {
        assertContextActive()
        let before = await cache.readLatest(
          seed,
          GROUP_MEMBERSHIP_EVENT_PAGE_SIZE,
        )
        assertContextActive()
        let cacheReset = before.reset
        try {
          decodeMembershipLogs(before.logs, groupId)
        } catch {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          before = await cache.readLatest(
            seed,
            GROUP_MEMBERSHIP_EVENT_PAGE_SIZE,
          )
          assertContextActive()
          cacheReset = true
        }
        const result = await syncEventLogs(provider, filter, before.cursor, {
          maxRanges: 1,
          signal: interruption.signal,
        })
        assertContextActive()
        decodeMembershipLogs(result.logs, groupId)
        await cache.apply(before, result)
        assertContextActive()
        const after = await cache.readLatest(
          seed,
          GROUP_MEMBERSHIP_EVENT_PAGE_SIZE,
        )
        assertContextActive()
        if (
          after.generation !== before.generation ||
          after.revision !== before.revision + 1n ||
          !sameCursor(after.cursor, result.cursor)
        ) {
          throw new Error(
            'The group-membership cache changed after synchronization. Retry the bounded range.',
          )
        }
        let decodedPage: readonly GroupMembershipSet[]
        try {
          decodedPage = decodeMembershipLogs(after.logs, groupId)
        } catch (error) {
          assertContextActive()
          await cache.clear(seed)
          assertContextActive()
          throw error
        }
        const recentSignals = decodedPage.slice(
          0,
          GROUP_MEMBERSHIP_EVENT_PAGE_SIZE,
        )
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
            'The wallet head moved behind the confirmed group memberships. Retry after the chain stabilizes.',
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
          safeHead === undefined || after.cursor.nextBlock > safeHead
        if (
          caughtUp &&
          safeHead !== undefined &&
          finalCheckpoint?.blockNumber !== safeHead
        ) {
          throw new Error(
            'The group-membership stream did not anchor at the confirmed safe head.',
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
          groupId,
          head: finalHead,
          indexedThrough,
          projectionAnchor: caughtUp
            ? issueProjectionAnchor(
                provider,
                chainId,
                groupId,
                position,
                finalHead,
                safeHead,
              )
            : undefined,
          recentSignals,
          safeHead,
          scannedRanges: result.scannedRanges,
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
