import {
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import {
  beforeDeadline,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'

const MAX_EVM_QUANTITY = (1n << 256n) - 1n
const MAX_CHECKPOINTS = 64
const MAX_TOPIC_ALTERNATIVES = 32
const MAX_LOG_DATA_BYTES = 16_384
const HARD_MAX_BLOCK_RANGE = 10_000
const HARD_MAX_LOGS_PER_RANGE = 2_000
const HARD_MAX_RANGES_PER_SYNC = 16
const HARD_MAX_REORG_CHECKS = 16
const HARD_MAX_LOGS_PER_SYNC = 10_000
export const DEFAULT_BLOCK_RANGE = 2_000
export const DEFAULT_FINALITY_DEPTH = 12n
export const DEFAULT_LOGS_PER_RANGE = 2_000
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
  finalityDepth?: bigint
  maxLogsPerRange?: number
  maxRangeSize?: number
  maxRanges?: number
  maxReorgChecks?: number
  signal?: AbortSignal
  timeoutMs?: number
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
type NormalizedFilter = {
  address: Address
  id: Hash
  topics: readonly EventTopicFilter[]
}
type BlockFingerprint = {
  hash: Hash
  number: bigint
}
type RpcRequest = (request: ProviderRequest) => Promise<unknown>

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
function assertQuantity(value: bigint, field: string) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_EVM_QUANTITY) {
    throw new Error(`Invalid ${field}.`)
  }
}
function parseTopic(value: unknown): Hex {
  return parseHash(value, 'log topic') as Hex
}
function normalizeFilter(filter: EventLogFilter): NormalizedFilter {
  if (typeof filter !== 'object' || filter === null) {
    throw new Error('Invalid event filter.')
  }
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
function normalizeCheckpoint(value: EventCheckpoint): EventCheckpoint {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid event cursor checkpoint.')
  }
  assertQuantity(value.blockNumber, 'event checkpoint block number')
  return {
    blockHash: parseHash(value.blockHash, 'event checkpoint block hash'),
    blockNumber: value.blockNumber,
  }
}
function normalizeCursor(
  cursor: EventCursor,
  filter: NormalizedFilter,
): EventCursor {
  if (typeof cursor !== 'object' || cursor === null) {
    throw new Error('Invalid event cursor.')
  }
  assertQuantity(cursor.chainId, 'event cursor chain identifier')
  assertQuantity(cursor.startBlock, 'event cursor start block')
  assertQuantity(cursor.nextBlock, 'event cursor next block')
  const filterId = parseHash(cursor.filterId, 'event cursor filter identifier')
  if (filterId !== filter.id) {
    throw new Error('The event cursor belongs to a different filter.')
  }
  if (
    !Number.isSafeInteger(cursor.rangeSize) ||
    cursor.rangeSize < 1 ||
    cursor.rangeSize > HARD_MAX_BLOCK_RANGE
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
  return { ...cursor, checkpoints, filterId }
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
function topicsMatch(actual: readonly Hex[], expected: NormalizedFilter) {
  return expected.topics.every((topic, index) => {
    if (topic === null) return true
    const actualTopic = actual[index]
    if (!actualTopic) return false
    return Array.isArray(topic)
      ? topic.includes(actualTopic)
      : topic === actualTopic
  })
}
function parseLog(
  value: unknown,
  filter: NormalizedFilter,
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
  filter: NormalizedFilter,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const uniqueLogs = new Map<string, IndexedEventLog>()
  for (const rawLog of value) {
    const log = parseLog(rawLog, filter, fromBlock, toBlock)
    const key = `${log.blockNumber}:${log.logIndex}`
    if (uniqueLogs.has(key)) throw invalidRpc('duplicate event log')
    uniqueLogs.set(key, log)
  }
  return [...uniqueLogs.values()].toSorted(compareLogs)
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
    if (block?.hash === checkpoint.blockHash) {
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
export function createEventCursor(
  chainId: bigint,
  filter: EventLogFilter,
  startBlock: bigint,
  rangeSize = DEFAULT_BLOCK_RANGE,
): EventCursor {
  assertQuantity(chainId, 'event cursor chain identifier')
  assertQuantity(startBlock, 'event cursor start block')
  const normalizedFilter = normalizeFilter(filter)
  const parsedRangeSize = parsePositiveInteger(
    rangeSize,
    DEFAULT_BLOCK_RANGE,
    HARD_MAX_BLOCK_RANGE,
    'event cursor range size',
  )
  return {
    chainId,
    checkpoints: [],
    filterId: normalizedFilter.id,
    nextBlock: startBlock,
    rangeSize: parsedRangeSize,
    startBlock,
  }
}
export function getEventFilterId(filter: EventLogFilter) {
  return normalizeFilter(filter).id
}
export async function syncEventLogs(
  provider: Eip1193Provider,
  filter: EventLogFilter,
  inputCursor: EventCursor,
  options: EventSyncOptions = {},
): Promise<EventSyncResult> {
  const normalizedFilter = normalizeFilter(filter)
  let cursor = normalizeCursor(inputCursor, normalizedFilter)
  const finalityDepth = options.finalityDepth ?? DEFAULT_FINALITY_DEPTH
  assertQuantity(finalityDepth, 'event finality depth')
  const maxLogs = parsePositiveInteger(
    options.maxLogsPerRange,
    DEFAULT_LOGS_PER_RANGE,
    HARD_MAX_LOGS_PER_RANGE,
    'maximum logs per range',
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
  const handleChainChanged = () => {
    chainChanged = true
  }
  provider.on?.('chainChanged', handleChainChanged)
  provider.on?.('disconnect', handleChainChanged)
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
    return beforeDeadline(
      () => provider.request(rpcRequest),
      deadline,
      () => new Error('Event synchronization timed out.'),
    )
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
    const safeHead = head >= finalityDepth ? head - finalityDepth : undefined
    const reconciled = await reconcileCursor(request, cursor, maxReorgChecks)
    cursor = reconciled.cursor
    let rollbackTo = reconciled.rollbackTo
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
      if (!beforeBlock) break
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
      const previousCheckpoint = cursor.checkpoints.at(-1)
      const previousBlock = previousCheckpoint
        ? await readBlock(request, previousCheckpoint.blockNumber)
        : undefined
      const afterBlock = await readBlock(request, toBlock)
      assertActive()
      if (
        !afterBlock ||
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
        nextLogs.some(
          (log) =>
            log.blockNumber === toBlock && log.blockHash !== afterBlock.hash,
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
    provider.removeListener?.('chainChanged', handleChainChanged)
    provider.removeListener?.('disconnect', handleChainChanged)
  }
}
