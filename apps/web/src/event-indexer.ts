import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { type Eip1193Provider, type ProviderRequest } from './ethereum'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const MAX_CHECKPOINTS = 64
const MAX_TOPIC_ALTERNATIVES = 32
const MAX_LOG_DATA_BYTES = 8_192
const HARD_MAX_BLOCK_RANGE = 10_000
const HARD_MAX_LOGS_PER_RANGE = 2_000
const HARD_MAX_LOG_BLOCKS_PER_RANGE = 128
const HARD_MAX_RANGES_PER_SYNC = 16
const HARD_MAX_REORG_CHECKS = 16
const HARD_MAX_LOGS_PER_SYNC = 5_000
export const DEFAULT_BLOCK_RANGE = 2_000
export const DEFAULT_FINALITY_DEPTH = 12n
export const DEFAULT_LOGS_PER_RANGE = 2_000
export const DEFAULT_LOG_BLOCKS_PER_RANGE = 32
export const DEFAULT_RANGES_PER_SYNC = 4
export type EventTopicFilter = Hex | readonly Hex[] | null
export type EventLogFilter = {
  address: Address
  topics?: readonly EventTopicFilter[]
}
export type EventCheckpoint = {
  blockHash: Hash
  blockNumber: bigint
}
export type EventCursor = {
  chainId: bigint
  checkpoints: readonly EventCheckpoint[]
  finalityDepth: bigint
  filterId: Hash
  nextBlock: bigint
  rangeSize: number
  startBlock: bigint
}
export type IndexedEventLog = {
  address: Address
  blockHash: Hash
  blockNumber: bigint
  data: Hex
  logIndex: number
  topics: readonly Hex[]
  transactionHash: Hash
  transactionIndex: number
}
export type EventSyncOptions = {
  maxLogBlocksPerRange?: number
  maxLogsPerRange?: number
  maxRangeSize?: number
  maxRanges?: number
  maxReorgChecks?: number
  signal?: AbortSignal
  timeoutMs?: number
}
export type CreateEventCursorOptions = {
  chainId: bigint
  filter: EventLogFilter
  finalityDepth?: bigint
  rangeSize?: number
  startBlock: bigint
}
export type EventSyncResult = {
  caughtUp: boolean
  cursor: EventCursor
  head: bigint
  logs: readonly IndexedEventLog[]
  rollbackTo?: bigint
  safeHead?: bigint
  scannedRanges: number
}
export type NormalizedEventLogFilter = {
  address: Address
  id: Hash
  topics: readonly EventTopicFilter[]
}
type BlockFingerprint = {
  hash: Hash
  number: bigint
}
type RpcRequest = (request: ProviderRequest) => Promise<unknown>

function cancelledError() {
  return new Error('Event synchronization was cancelled.')
}
async function requestBeforeDeadline(
  provider: Eip1193Provider,
  request: ProviderRequest,
  deadline: number,
  signal?: AbortSignal,
) {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new Error('Event synchronization timed out.')
  let timeout: ReturnType<typeof setTimeout> | undefined
  let handleAbort: (() => void) | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Event synchronization timed out.')),
      remainingMs,
    )
  })
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        handleAbort = () => reject(cancelledError())
        signal.addEventListener('abort', handleAbort, { once: true })
      })
    : undefined
  try {
    if (signal?.aborted) throw cancelledError()
    const pending = provider.request(request)
    return await Promise.race(
      aborted ? [pending, timedOut, aborted] : [pending, timedOut],
    )
  } finally {
    clearTimeout(timeout)
    if (handleAbort) signal?.removeEventListener('abort', handleAbort)
  }
}
function invalidRpc(field: string) {
  return new Error(`The RPC returned an invalid ${field}.`)
}
function parseQuantity(value: unknown, field: string): bigint {
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
  if (
    typeof value !== 'string' ||
    value.length !== 66 ||
    !/^0x[0-9a-f]{64}$/i.test(value)
  ) {
    throw invalidRpc(field)
  }
  return value.toLowerCase() as Hash
}
function parseData(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    value.length > MAX_LOG_DATA_BYTES * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw invalidRpc('log data')
  }
  return value.toLowerCase() as Hex
}
function parseIndex(value: unknown, field: string): number {
  const parsed = parseQuantity(value, field)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidRpc(field)
  return Number(parsed)
}
function parsePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
) {
  const parsed = value ?? fallback
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${field}.`)
  }
  return parsed
}
function assertQuantity(
  value: unknown,
  field: string,
): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_EVM_QUANTITY) {
    throw new Error(`Invalid ${field}.`)
  }
}
function parseTopic(value: unknown): Hex {
  return parseHash(value, 'log topic') as Hex
}
export function normalizeEventLogFilter(
  value: unknown,
): NormalizedEventLogFilter {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid event filter.')
  }
  const filter = value as Record<string, unknown>
  if (
    typeof filter.address !== 'string' ||
    filter.address.length !== 42 ||
    !isAddress(filter.address)
  ) {
    throw new Error('Invalid event address.')
  }
  const address = getAddress(filter.address)
  const sourceTopics = filter.topics ?? []
  if (!Array.isArray(sourceTopics) || sourceTopics.length > 4) {
    throw new Error('Invalid event topic filter.')
  }
  const topics = sourceTopics.map((topic) => {
    if (topic === null) return null
    if (!Array.isArray(topic)) return parseTopic(topic)
    if (topic.length < 1 || topic.length > MAX_TOPIC_ALTERNATIVES) {
      throw new Error('Invalid event topic alternatives.')
    }
    return [...new Set(topic.map(parseTopic))].toSorted()
  })
  const serialized = JSON.stringify([address.toLowerCase(), topics])
  return { address, id: keccak256(stringToHex(serialized)), topics }
}
function normalizeCheckpoint(value: unknown): EventCheckpoint {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid event cursor checkpoint.')
  }
  const checkpoint = value as Record<string, unknown>
  assertQuantity(checkpoint.blockNumber, 'event checkpoint block number')
  return {
    blockHash: parseHash(checkpoint.blockHash, 'event checkpoint block hash'),
    blockNumber: checkpoint.blockNumber,
  }
}
export function validateEventCursor(value: unknown): EventCursor {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid event cursor.')
  }
  const cursor = value as Record<string, unknown>
  assertQuantity(cursor.chainId, 'event cursor chain identifier')
  assertQuantity(cursor.finalityDepth, 'event cursor finality depth')
  assertQuantity(cursor.startBlock, 'event cursor start block')
  assertQuantity(cursor.nextBlock, 'event cursor next block')
  const filterId = parseHash(cursor.filterId, 'event cursor filter identifier')
  const rangeSize = cursor.rangeSize
  if (
    typeof rangeSize !== 'number' ||
    !Number.isSafeInteger(rangeSize) ||
    rangeSize < 1 ||
    rangeSize > HARD_MAX_BLOCK_RANGE
  ) {
    throw new Error('Invalid event cursor range size.')
  }
  if (
    !Array.isArray(cursor.checkpoints) ||
    cursor.checkpoints.length > MAX_CHECKPOINTS
  ) {
    throw new Error('Invalid event cursor checkpoints.')
  }
  const checkpoints = cursor.checkpoints.map(normalizeCheckpoint)
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]!.blockNumber < cursor.startBlock) {
      throw new Error('Invalid event cursor checkpoint block number.')
    }
    if (
      index > 0 &&
      checkpoints[index - 1]!.blockNumber >= checkpoints[index]!.blockNumber
    ) {
      throw new Error('Invalid event cursor checkpoint order.')
    }
  }
  const lastCheckpoint = checkpoints.at(-1)
  const expectedNext = lastCheckpoint
    ? lastCheckpoint.blockNumber + 1n
    : cursor.startBlock
  if (cursor.nextBlock !== expectedNext) {
    throw new Error('Invalid event cursor next block.')
  }
  return {
    chainId: cursor.chainId,
    checkpoints,
    finalityDepth: cursor.finalityDepth,
    filterId,
    nextBlock: cursor.nextBlock,
    rangeSize,
    startBlock: cursor.startBlock,
  }
}
function normalizeCursor(
  cursor: EventCursor,
  filter: NormalizedEventLogFilter,
) {
  const normalized = validateEventCursor(cursor)
  if (normalized.filterId !== filter.id) {
    throw new Error('The event cursor belongs to a different filter.')
  }
  return normalized
}
function toQuantity(value: bigint) {
  return `0x${value.toString(16)}`
}
function parseBlock(value: unknown, expectedNumber: bigint) {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRpc('block')
  }
  const hash = 'hash' in value ? value.hash : undefined
  const number = 'number' in value ? value.number : undefined
  const block = {
    hash: parseHash(hash, 'block hash'),
    number: parseQuantity(number, 'block number'),
  }
  if (block.number !== expectedNumber) throw invalidRpc('block number')
  return block
}
async function readBlock(
  request: RpcRequest,
  blockNumber: bigint,
): Promise<BlockFingerprint | undefined> {
  const value = await request({
    method: 'eth_getBlockByNumber',
    params: [toQuantity(blockNumber), false],
  })
  return parseBlock(value, blockNumber)
}
function topicsMatch(
  actual: readonly Hex[],
  expected: NormalizedEventLogFilter,
) {
  return expected.topics.every((topic, index) => {
    if (topic === null) return true
    const actualTopic = actual[index]
    if (!actualTopic) return false
    return Array.isArray(topic)
      ? topic.includes(actualTopic)
      : topic === actualTopic
  })
}
export function indexedEventLogMatchesFilter(
  log: IndexedEventLog,
  filter: NormalizedEventLogFilter,
) {
  return (
    log.address.toLowerCase() === filter.address.toLowerCase() &&
    topicsMatch(log.topics, filter)
  )
}
function parseLog(
  value: unknown,
  filter: NormalizedEventLogFilter,
  fromBlock: bigint,
  toBlock: bigint,
): IndexedEventLog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRpc('event log')
  }
  const entry = value as Record<string, unknown>
  if (entry.removed !== false) throw invalidRpc('event log removal state')
  if (
    typeof entry.address !== 'string' ||
    entry.address.length !== 42 ||
    !isAddress(entry.address)
  ) {
    throw invalidRpc('event log address')
  }
  const address = getAddress(entry.address)
  if (address.toLowerCase() !== filter.address.toLowerCase()) {
    throw invalidRpc('event log address')
  }
  if (!Array.isArray(entry.topics) || entry.topics.length > 4) {
    throw invalidRpc('event log topics')
  }
  const topics = entry.topics.map(parseTopic)
  if (!topicsMatch(topics, filter)) throw invalidRpc('event log topics')
  const blockNumber = parseQuantity(entry.blockNumber, 'event block number')
  if (blockNumber < fromBlock || blockNumber > toBlock) {
    throw invalidRpc('event block number')
  }
  return {
    address,
    blockHash: parseHash(entry.blockHash, 'event block hash'),
    blockNumber,
    data: parseData(entry.data),
    logIndex: parseIndex(entry.logIndex, 'event log index'),
    topics,
    transactionHash: parseHash(entry.transactionHash, 'event transaction hash'),
    transactionIndex: parseIndex(
      entry.transactionIndex,
      'event transaction index',
    ),
  }
}
function compareLogs(first: IndexedEventLog, second: IndexedEventLog) {
  if (first.blockNumber !== second.blockNumber) {
    return first.blockNumber < second.blockNumber ? -1 : 1
  }
  if (first.transactionIndex !== second.transactionIndex) {
    return first.transactionIndex - second.transactionIndex
  }
  return first.logIndex - second.logIndex
}
function parseLogs(
  value: readonly unknown[],
  filter: NormalizedEventLogFilter,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const uniqueLogs = new Map<string, IndexedEventLog>()
  const blockHashes = new Map<bigint, Hash>()
  for (const rawLog of value) {
    const log = parseLog(rawLog, filter, fromBlock, toBlock)
    const key = `${log.blockNumber}:${log.logIndex}`
    if (uniqueLogs.has(key)) throw invalidRpc('duplicate event log')
    const knownBlockHash = blockHashes.get(log.blockNumber)
    if (knownBlockHash && knownBlockHash !== log.blockHash) {
      throw invalidRpc('event block hash')
    }
    blockHashes.set(log.blockNumber, log.blockHash)
    uniqueLogs.set(key, log)
  }
  return [...uniqueLogs.values()].toSorted(compareLogs)
}
function validateNormalizedIndex(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid indexed event ${field}.`)
  }
  return value
}
export function validateIndexedEventLog(value: unknown): IndexedEventLog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid indexed event log.')
  }
  const log = value as Record<string, unknown>
  if (
    typeof log.address !== 'string' ||
    log.address.length !== 42 ||
    !isAddress(log.address)
  ) {
    throw new Error('Invalid indexed event address.')
  }
  if (!Array.isArray(log.topics) || log.topics.length > 4) {
    throw new Error('Invalid indexed event topics.')
  }
  assertQuantity(log.blockNumber, 'indexed event block number')
  return {
    address: getAddress(log.address),
    blockHash: parseHash(log.blockHash, 'indexed event block hash'),
    blockNumber: log.blockNumber,
    data: parseData(log.data),
    logIndex: validateNormalizedIndex(log.logIndex, 'log index'),
    topics: log.topics.map(parseTopic),
    transactionHash: parseHash(
      log.transactionHash,
      'indexed event transaction hash',
    ),
    transactionIndex: validateNormalizedIndex(
      log.transactionIndex,
      'transaction index',
    ),
  }
}
function getLogBlockFingerprints(logs: readonly IndexedEventLog[]) {
  const fingerprints: EventCheckpoint[] = []
  for (const log of logs) {
    if (fingerprints.at(-1)?.blockNumber === log.blockNumber) continue
    fingerprints.push({
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
    })
  }
  return fingerprints
}
function isRangeLimitError(error: unknown) {
  if (!(error instanceof Error)) return false
  const message = error.message.slice(0, 512).toLowerCase()
  return /too many (?:logs|results)|(?:block )?range.{0,40}(?:wide|large|limit|exceed)|(?:wide|large|limit|exceed).{0,40}(?:block )?range|limit.{0,40}blocks|response size|query returned more than/.test(
    message,
  )
}
function shrinkRange(cursor: EventCursor, span: number) {
  if (span <= 1) {
    throw new Error(
      'A single block returned too many events for this filter and RPC.',
    )
  }
  return { ...cursor, rangeSize: Math.max(1, Math.floor(span / 2)) }
}
function growRange(
  rangeSize: number,
  logCount: number,
  maxLogs: number,
  maxRange: number,
) {
  if (logCount > maxLogs / 2) {
    return Math.min(maxRange, Math.max(1, Math.floor(rangeSize / 2)))
  }
  if (logCount < maxLogs / 4) return Math.min(maxRange, rangeSize * 2)
  return Math.min(maxRange, rangeSize)
}
function earliestRollback(current: bigint | undefined, candidate: bigint) {
  return current === undefined || candidate < current ? candidate : current
}
function unavailableBlock(blockNumber: bigint) {
  return new Error(
    `The RPC could not serve expected block ${blockNumber.toString()}.`,
  )
}
async function reconcileCursor(
  request: RpcRequest,
  cursor: EventCursor,
  maxChecks: number,
) {
  const checkpoints = [...cursor.checkpoints]
  let checks = 0
  let foundCanonical = false
  while (checkpoints.length > 0 && checks < maxChecks) {
    const checkpoint = checkpoints.at(-1)!
    const block = await readBlock(request, checkpoint.blockNumber)
    checks += 1
    if (!block) throw unavailableBlock(checkpoint.blockNumber)
    if (block.hash === checkpoint.blockHash) {
      foundCanonical = true
      break
    }
    checkpoints.pop()
  }
  if (!foundCanonical && checkpoints.length > 0) checkpoints.length = 0
  const lastCheckpoint = checkpoints.at(-1)
  const nextBlock = lastCheckpoint
    ? lastCheckpoint.blockNumber + 1n
    : cursor.startBlock
  return {
    cursor: { ...cursor, checkpoints, nextBlock },
    rollbackTo: nextBlock === cursor.nextBlock ? undefined : nextBlock,
  }
}
export function createEventCursor({
  chainId,
  filter,
  finalityDepth = DEFAULT_FINALITY_DEPTH,
  rangeSize = DEFAULT_BLOCK_RANGE,
  startBlock,
}: CreateEventCursorOptions): EventCursor {
  assertQuantity(chainId, 'event cursor chain identifier')
  assertQuantity(finalityDepth, 'event cursor finality depth')
  assertQuantity(startBlock, 'event cursor start block')
  const normalizedFilter = normalizeEventLogFilter(filter)
  const parsedRangeSize = parsePositiveInteger(
    rangeSize,
    DEFAULT_BLOCK_RANGE,
    HARD_MAX_BLOCK_RANGE,
    'event cursor range size',
  )
  return {
    chainId,
    checkpoints: [],
    finalityDepth,
    filterId: normalizedFilter.id,
    nextBlock: startBlock,
    rangeSize: parsedRangeSize,
    startBlock,
  }
}
export function getEventFilterId(filter: EventLogFilter) {
  return normalizeEventLogFilter(filter).id
}
export async function syncEventLogs(
  provider: Eip1193Provider,
  filter: EventLogFilter,
  inputCursor: EventCursor,
  options: EventSyncOptions = {},
): Promise<EventSyncResult> {
  const normalizedFilter = normalizeEventLogFilter(filter)
  let cursor = normalizeCursor(inputCursor, normalizedFilter)
  const maxLogs = parsePositiveInteger(
    options.maxLogsPerRange,
    DEFAULT_LOGS_PER_RANGE,
    HARD_MAX_LOGS_PER_RANGE,
    'maximum logs per range',
  )
  const maxLogBlocks = parsePositiveInteger(
    options.maxLogBlocksPerRange,
    DEFAULT_LOG_BLOCKS_PER_RANGE,
    HARD_MAX_LOG_BLOCKS_PER_RANGE,
    'maximum log-bearing blocks per range',
  )
  const maxRange = parsePositiveInteger(
    options.maxRangeSize,
    HARD_MAX_BLOCK_RANGE,
    HARD_MAX_BLOCK_RANGE,
    'maximum event block range',
  )
  const maxRanges = parsePositiveInteger(
    options.maxRanges,
    DEFAULT_RANGES_PER_SYNC,
    HARD_MAX_RANGES_PER_SYNC,
    'maximum ranges per sync',
  )
  const maxReorgChecks = parsePositiveInteger(
    options.maxReorgChecks,
    8,
    HARD_MAX_REORG_CHECKS,
    'maximum reorg checks',
  )
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs,
    20_000,
    60_000,
    'event sync timeout',
  )
  const deadline = Date.now() + timeoutMs
  let chainChanged = false
  const requestInterruption = new AbortController()
  const handleChainChanged = () => {
    chainChanged = true
    requestInterruption.abort()
  }
  const handleCancellation = () => requestInterruption.abort()
  provider.on?.('chainChanged', handleChainChanged)
  provider.on?.('disconnect', handleChainChanged)
  options.signal?.addEventListener('abort', handleCancellation, { once: true })
  const assertActive = () => {
    if (options.signal?.aborted) {
      throw new Error('Event synchronization was cancelled.')
    }
    if (chainChanged) {
      throw new Error('The RPC chain changed during event synchronization.')
    }
  }
  const request: RpcRequest = async (rpcRequest) => {
    assertActive()
    try {
      const result = await requestBeforeDeadline(
        provider,
        rpcRequest,
        deadline,
        requestInterruption.signal,
      )
      assertActive()
      return result
    } catch (error) {
      assertActive()
      throw error
    }
  }
  try {
    const [chainValue, headValue] = await Promise.all([
      request({ method: 'eth_chainId' }),
      request({ method: 'eth_blockNumber' }),
    ])
    assertActive()
    if (parseQuantity(chainValue, 'chain identifier') !== cursor.chainId) {
      throw new Error('The event cursor belongs to a different chain.')
    }
    const head = parseQuantity(headValue, 'head block number')
    const safeHead =
      head >= cursor.finalityDepth ? head - cursor.finalityDepth : undefined
    const latestCheckpoint = cursor.checkpoints.at(-1)
    if (
      latestCheckpoint &&
      (safeHead === undefined || latestCheckpoint.blockNumber > safeHead)
    ) {
      throw new Error('The RPC head is behind the event cursor checkpoint.')
    }
    let rollbackTo: bigint | undefined
    const reconciled = await reconcileCursor(request, cursor, maxReorgChecks)
    cursor = reconciled.cursor
    if (reconciled.rollbackTo !== undefined) {
      rollbackTo = earliestRollback(rollbackTo, reconciled.rollbackTo)
    }
    let logs: IndexedEventLog[] = []
    let scannedRanges = 0
    for (let attempt = 0; attempt < maxRanges; attempt += 1) {
      assertActive()
      if (logs.length >= HARD_MAX_LOGS_PER_SYNC) break
      if (logs.length > 0 && logs.length + maxLogs > HARD_MAX_LOGS_PER_SYNC)
        break
      if (safeHead === undefined || cursor.nextBlock > safeHead) break
      const fromBlock = cursor.nextBlock
      const remaining = safeHead - fromBlock + 1n
      const span = Math.min(cursor.rangeSize, maxRange, Number(remaining))
      const toBlock = fromBlock + BigInt(span - 1)
      const beforeBlock = await readBlock(request, toBlock)
      if (!beforeBlock) throw unavailableBlock(toBlock)
      let rawLogs: unknown
      try {
        rawLogs = await request({
          method: 'eth_getLogs',
          params: [
            {
              address: normalizedFilter.address,
              fromBlock: toQuantity(fromBlock),
              toBlock: toQuantity(toBlock),
              topics: normalizedFilter.topics.map((topic) =>
                Array.isArray(topic) ? [...topic] : topic,
              ),
            },
          ],
        })
      } catch (error) {
        if (!isRangeLimitError(error)) throw error
        cursor = shrinkRange(cursor, span)
        continue
      }
      if (!Array.isArray(rawLogs)) throw invalidRpc('event log list')
      const logCount = rawLogs.length
      if (logCount > maxLogs) {
        cursor = shrinkRange(cursor, span)
        continue
      }
      const nextLogs = parseLogs(rawLogs, normalizedFilter, fromBlock, toBlock)
      const logBlocks = getLogBlockFingerprints(nextLogs)
      if (logBlocks.length > maxLogBlocks) {
        cursor = shrinkRange(cursor, span)
        continue
      }
      const canonicalLogBlocks = new Map<bigint, Hash>()
      for (const expectedBlock of logBlocks) {
        if (expectedBlock.blockNumber === toBlock) continue
        const block = await readBlock(request, expectedBlock.blockNumber)
        if (!block) throw unavailableBlock(expectedBlock.blockNumber)
        canonicalLogBlocks.set(block.number, block.hash)
      }
      const previousCheckpoint = cursor.checkpoints.at(-1)
      const previousBlock = previousCheckpoint
        ? await readBlock(request, previousCheckpoint.blockNumber)
        : undefined
      const afterBlock = await readBlock(request, toBlock)
      assertActive()
      if (previousCheckpoint && !previousBlock) {
        throw unavailableBlock(previousCheckpoint.blockNumber)
      }
      if (!afterBlock) throw unavailableBlock(toBlock)
      canonicalLogBlocks.set(afterBlock.number, afterBlock.hash)
      if (
        beforeBlock.hash !== afterBlock.hash ||
        (previousCheckpoint &&
          previousBlock?.hash !== previousCheckpoint.blockHash)
      ) {
        const nextReconciliation = await reconcileCursor(
          request,
          cursor,
          maxReorgChecks,
        )
        cursor = nextReconciliation.cursor
        if (nextReconciliation.rollbackTo !== undefined) {
          logs = logs.filter(
            (log) => log.blockNumber < nextReconciliation.rollbackTo!,
          )
          rollbackTo = earliestRollback(
            rollbackTo,
            nextReconciliation.rollbackTo,
          )
        }
        continue
      }
      if (
        logBlocks.some(
          (block) =>
            canonicalLogBlocks.get(block.blockNumber) !== block.blockHash,
        )
      ) {
        throw invalidRpc('event block hash')
      }
      logs.push(...nextLogs)
      const checkpoints = [
        ...cursor.checkpoints,
        { blockHash: afterBlock.hash, blockNumber: toBlock },
      ].slice(-MAX_CHECKPOINTS)
      cursor = {
        ...cursor,
        checkpoints,
        nextBlock: toBlock + 1n,
        rangeSize: growRange(cursor.rangeSize, logCount, maxLogs, maxRange),
      }
      scannedRanges += 1
    }
    const finalReconciliation = await reconcileCursor(
      request,
      cursor,
      maxReorgChecks,
    )
    cursor = finalReconciliation.cursor
    if (finalReconciliation.rollbackTo !== undefined) {
      logs = logs.filter(
        (log) => log.blockNumber < finalReconciliation.rollbackTo!,
      )
      rollbackTo = earliestRollback(rollbackTo, finalReconciliation.rollbackTo)
    }
    assertActive()
    return {
      caughtUp: safeHead === undefined || cursor.nextBlock > safeHead,
      cursor,
      head,
      logs,
      rollbackTo,
      safeHead,
      scannedRanges,
    }
  } finally {
    requestInterruption.abort()
    options.signal?.removeEventListener('abort', handleCancellation)
    provider.removeListener?.('chainChanged', handleChainChanged)
    provider.removeListener?.('disconnect', handleChainChanged)
  }
}
