import { encodeFunctionData, toHex } from 'viem'
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
  decodePublishedGroup,
  GROUP_CREATED_FILTER,
  type PublishedGroup,
} from './protocol-events'
import { inspectProtocol, PROTOCOL_ADDRESS } from './protocol'
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

export const GROUP_DIRECTORY_PAGE_SIZE = 100
export const GROUP_DIRECTORY_START_BLOCK = 0n

const NEXT_GROUP_ID_ABI = [
  {
    type: 'function',
    name: 'nextGroupId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const NEXT_GROUP_ID_CALL = encodeFunctionData({
  abi: NEXT_GROUP_ID_ABI,
  functionName: 'nextGroupId',
})

export type GroupDirectorySnapshot = {
  cacheReset: boolean
  caughtUp: boolean
  groups: readonly PublishedGroup[]
  head: bigint
  indexedThrough?: bigint
  safeHead?: bigint
  scannedRanges: number
  startBlock: bigint
}

export type GroupDirectoryStorageOptions = Pick<
  OpenEventCacheOptions,
  'databaseName' | 'factory' | 'keyRange'
>

export type SynchronizeGroupDirectoryOptions = {
  resolveHistoryBoundary?: ProtocolHistoryBoundaryResolver
  signal?: AbortSignal
  storage?: GroupDirectoryStorageOptions
}

export type GroupDirectorySynchronizer = (
  provider: Eip1193Provider,
  chainId: bigint,
  options?: SynchronizeGroupDirectoryOptions,
) => Promise<GroupDirectorySnapshot>

function cancelledError() {
  return new Error('Group-directory synchronization was cancelled.')
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
      () => new Error('Group-directory context read timed out.'),
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
    throw new Error('The group directory belongs to another wallet chain.')
  }
}

function parseHead(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid group-directory head.')
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
    throw new Error('The group directory belongs to another wallet chain.')
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
      'The wallet returned invalid group-directory checkpoint data.',
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
      'The confirmed group-directory checkpoint changed. Retry the bounded range.',
    )
  }
}

async function readNextGroupId(
  provider: Eip1193Provider,
  blockNumber: bigint,
  signal: AbortSignal,
) {
  const value = await requestInContext(
    provider,
    {
      method: 'eth_call',
      params: [
        { data: NEXT_GROUP_ID_CALL, to: PROTOCOL_ADDRESS },
        toHex(blockNumber),
      ],
    },
    signal,
  )
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error(
      'The wallet returned an invalid confirmed group-directory count.',
    )
  }
  const nextGroupId = BigInt(value)
  if (nextGroupId < 1n) {
    throw new Error(
      'The wallet returned an invalid confirmed group-directory count.',
    )
  }
  return nextGroupId
}

function decodeGroupLogs(logs: readonly IndexedEventLog[]) {
  return logs.map((log) => {
    const group = decodePublishedGroup(log)
    if (!group) {
      throw new Error(
        'The group-directory cache contained another event family.',
      )
    }
    return group
  })
}

function assertRecentGroupSequence(
  groups: readonly PublishedGroup[],
  logCount: number,
) {
  if (groups.length > logCount) {
    throw new Error('The group directory has an invalid event count.')
  }
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index]!.groupId !== BigInt(logCount - index)) {
      throw new Error(
        'The group directory has a non-contiguous identifier sequence.',
      )
    }
  }
}

function assertFreshGroupSequence(
  groups: readonly PublishedGroup[],
  logCount: number,
) {
  if (groups.length > logCount) {
    throw new Error('The group directory has an invalid event count.')
  }
  const retainedCount = logCount - groups.length
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index]!.groupId !== BigInt(retainedCount + index + 1)) {
      throw new Error(
        'The group directory has a non-contiguous identifier sequence.',
      )
    }
  }
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

export async function resetGroupDirectoryCache(
  chainId: bigint,
  storage: GroupDirectoryStorageOptions = {},
  startBlock = GROUP_DIRECTORY_START_BLOCK,
) {
  const seed = createEventCursor({
    chainId,
    filter: GROUP_CREATED_FILTER,
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock,
  })
  const cache = await openEventCache({
    ...storage,
    filter: GROUP_CREATED_FILTER,
  })
  try {
    await cache.clear(seed)
  } finally {
    cache.close()
  }
}

export const synchronizeGroupDirectory: GroupDirectorySynchronizer = async (
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
      throw new Error(
        'The wallet chain changed during group-directory verification.',
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
        'Verified Lifeinvader v1 is required before this chain can provide a group directory.',
      )
    }
    let historyAnchor: ProtocolBlockFingerprint | undefined
    let historyBoundaryKind: 'confirmed' | 'pending-confirmation' | undefined
    let startBlock = GROUP_DIRECTORY_START_BLOCK
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
    const seed = createEventCursor({
      chainId,
      filter: GROUP_CREATED_FILTER,
      finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
      startBlock,
    })
    const cache = await openEventCache({
      ...options.storage,
      filter: GROUP_CREATED_FILTER,
    })
    try {
      assertContextActive()
      let before = await cache.readLatest(seed, GROUP_DIRECTORY_PAGE_SIZE)
      assertContextActive()
      let cacheReset = before.reset
      try {
        assertRecentGroupSequence(decodeGroupLogs(before.logs), before.logCount)
      } catch {
        assertContextActive()
        await cache.clear(seed)
        assertContextActive()
        before = await cache.readLatest(seed, GROUP_DIRECTORY_PAGE_SIZE)
        assertContextActive()
        cacheReset = true
      }
      const result = await syncEventLogs(
        provider,
        GROUP_CREATED_FILTER,
        before.cursor,
        { maxRanges: 1, signal: interruption.signal },
      )
      assertContextActive()
      const freshGroups = decodeGroupLogs(result.logs)
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
          'The protocol history anchor changed during group-directory synchronization. Retry after the chain stabilizes.',
        )
      }
      assertContextActive()
      await cache.apply(before, result)
      assertContextActive()
      const after = await cache.readLatest(seed, GROUP_DIRECTORY_PAGE_SIZE)
      assertContextActive()
      if (
        after.generation !== before.generation ||
        after.revision !== before.revision + 1n ||
        !sameCursor(after.cursor, result.cursor)
      ) {
        throw new Error(
          'The group-directory cache changed after synchronization. Retry the bounded range.',
        )
      }
      let decodedPage: readonly PublishedGroup[]
      try {
        decodedPage = decodeGroupLogs(after.logs)
        assertFreshGroupSequence(freshGroups, after.logCount)
        assertRecentGroupSequence(decodedPage, after.logCount)
      } catch (error) {
        assertContextActive()
        await cache.clear(seed)
        assertContextActive()
        throw error
      }
      const groups = decodedPage.slice(0, GROUP_DIRECTORY_PAGE_SIZE)
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
          'The wallet head moved behind the confirmed groups. Retry after the chain stabilizes.',
        )
      }
      const safeHead =
        finalHead >= POST_FEED_CONFIRMATION_DEPTH
          ? finalHead - POST_FEED_CONFIRMATION_DEPTH
          : undefined
      const deploymentStillPending =
        historyBoundaryKind === 'pending-confirmation' &&
        (safeHead === undefined || after.cursor.startBlock > safeHead)
      const caughtUp =
        !deploymentStillPending &&
        (safeHead === undefined || after.cursor.nextBlock > safeHead)
      const confirmedNextGroupId =
        caughtUp && safeHead !== undefined
          ? await readNextGroupId(provider, safeHead, interruption.signal)
          : 1n
      assertContextActive()
      if (
        caughtUp &&
        safeHead !== undefined &&
        finalCheckpoint?.blockNumber !== safeHead
      ) {
        throw new Error(
          'The group-directory stream did not anchor at the confirmed safe head.',
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
      if (caughtUp && confirmedNextGroupId !== BigInt(after.logCount) + 1n) {
        await cache.clear(seed)
        assertContextActive()
        throw new Error(
          'The RPC returned an incomplete confirmed group directory. Its local cache was reset.',
        )
      }
      return {
        cacheReset: cacheReset || after.reset,
        caughtUp,
        groups,
        head: finalHead,
        indexedThrough,
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
