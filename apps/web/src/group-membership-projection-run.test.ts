import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { openEventCache, type EventCachePosition } from './event-cache'
import type { Eip1193Provider } from './ethereum'
import {
  createEventCursor,
  type EventCursor,
  type EventSyncResult,
  type IndexedEventLog,
} from './event-indexer'
import {
  openGroupMembershipProjectionRun,
  type OpenGroupMembershipProjectionRunOptions,
} from './group-membership-projection-run'
import {
  GROUP_MEMBERSHIP_EVENT_START_BLOCK,
  synchronizeGroupMembershipStream,
} from './group-membership-stream'
import { getGroupMembershipFilter } from './protocol-events'
import {
  GROUP_MEMBERSHIP_SET_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000cccc' as Address
const GROUP_A = 17n
const GROUP_B = 18n
const MEMBERSHIP_DATA_PARAMETERS = [{ type: 'bool' }] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH
const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

type TestStorage = Required<
  Pick<OpenGroupMembershipProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenGroupMembershipProjectionRunOptions, 'keyRange'>

type AnchorProviderControl = {
  beforeCheckpointReturn?: () => Promise<void>
  chainId: bigint
  head: bigint
  safeHeadHash: Hex
}

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function blockHash(blockNumber: bigint) {
  return hash(`block:${blockNumber.toString()}`)
}

function membershipLog(
  account: Address,
  joined: boolean,
  blockNumber: bigint,
  options: {
    groupId?: bigint
    logIndex?: number
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const groupId = options.groupId ?? GROUP_A
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber,
    data: encodeAbiParameters(MEMBERSHIP_DATA_PARAMETERS, [joined]),
    logIndex,
    topics: [
      GROUP_MEMBERSHIP_SET_TOPIC,
      padHex(toHex(groupId), { size: 32 }),
      padHex(account, { size: 32 }),
    ],
    transactionHash: hash(
      `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
    ),
    transactionIndex,
  }
}

function seedCursor(groupId = GROUP_A, chainId = 1n) {
  return createEventCursor({
    chainId,
    filter: getGroupMembershipFilter(groupId),
    finalityDepth: FINALITY_DEPTH,
    startBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
  })
}

function cursorAtSafeHead(seed: EventCursor) {
  return {
    ...seed,
    checkpoints: [{ blockHash: blockHash(SAFE_HEAD), blockNumber: SAFE_HEAD }],
    nextBlock: SAFE_HEAD + 1n,
  } satisfies EventCursor
}

function syncResult(
  cursor: EventCursor,
  logs: readonly IndexedEventLog[],
): EventSyncResult {
  return {
    caughtUp: true,
    cursor,
    head: HEAD,
    logs,
    safeHead: SAFE_HEAD,
    scannedRanges: 1,
  }
}

function storage(): TestStorage {
  return {
    databaseName: `group-membership-projection-${crypto.randomUUID()}`,
    factory: new IDBFactory(),
    keyRange: IDBKeyRange,
  }
}

function anchorProvider() {
  const control: AnchorProviderControl = {
    chainId: 1n,
    head: HEAD,
    safeHeadHash: blockHash(SAFE_HEAD),
  }
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
      if (method === 'eth_chainId') return toHex(control.chainId)
      if (method === 'eth_blockNumber') return toHex(control.head)
      if (method === 'eth_getBlockByNumber') {
        const [number] = params as [Hex]
        const blockNumber = BigInt(number)
        if (blockNumber === SAFE_HEAD) {
          await control.beforeCheckpointReturn?.()
        }
        return {
          hash:
            blockNumber === SAFE_HEAD
              ? control.safeHeadHash
              : blockHash(blockNumber),
          number,
        }
      }
      if (method === 'eth_getLogs') {
        throw new Error('A caught-up membership stream must not request logs.')
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    },
  }
  return { control, provider }
}

async function populateMemberships(
  storageOptions: TestStorage,
  logs: readonly IndexedEventLog[],
) {
  const seed = seedCursor()
  const cache = await openEventCache({
    ...storageOptions,
    filter: getGroupMembershipFilter(GROUP_A),
  })
  try {
    await cache.apply(
      await cache.readLatest(seed),
      syncResult(cursorAtSafeHead(seed), logs),
    )
    const current = await cache.readLatest(seed)
    return {
      cursor: current.cursor,
      generation: current.generation,
      revision: current.revision,
    } satisfies EventCachePosition
  } finally {
    cache.close()
  }
}

async function prepareProjection(logs: readonly IndexedEventLog[]) {
  const storageOptions = storage()
  await populateMemberships(storageOptions, logs)
  const { control, provider } = anchorProvider()
  const synchronized = await synchronizeGroupMembershipStream(
    provider,
    1n,
    GROUP_A,
    { storage: storageOptions },
  )
  if (!synchronized.projectionAnchor) {
    throw new Error('The test stream did not issue a projection anchor.')
  }
  return {
    anchor: synchronized.projectionAnchor,
    control,
    storage: storageOptions,
  }
}

describe('group membership projection run', () => {
  it('publishes latest public membership only after bounded local work', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_B, true, 2n),
      membershipLog(ACCOUNT_A, false, 3n),
      membershipLog(ACCOUNT_C, true, 4n),
    ])
    const run = await openGroupMembershipProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    expect(run.snapshot).toEqual({
      chainId: 1n,
      groupId: GROUP_A,
      head: HEAD,
      logsProcessed: 0n,
      membersRetained: 0n,
      pagesScanned: 0n,
      phase: 'memberships',
      safeHead: SAFE_HEAD,
    })
    expect(run.groupId).toBe(GROUP_A)
    expect(() => run.readMembers()).toThrow(/not complete/i)
    expect(() => run.getMember(ACCOUNT_A)).toThrow(/not complete/i)
    expect(() => run.isMember(ACCOUNT_A)).toThrow(/not complete/i)
    expect(() => run.progress).toThrow(/not complete/i)
    expect(() => run.baseline).toThrow(/not complete/i)

    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 1n,
      membersRetained: 1n,
      pagesScanned: 1n,
      phase: 'memberships',
    })
    await run.advance()
    await run.advance()
    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 4n,
      membersRetained: 2n,
      pagesScanned: 4n,
      phase: 'authenticate',
    })
    expect(() => run.readMembers()).toThrow(/not complete/i)

    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.isMember(ACCOUNT_A)).toBe(false)
    expect(run.getMember(ACCOUNT_A)).toBeUndefined()
    expect(run.readMembers().members.map(({ account }) => account)).toEqual([
      getAddress(ACCOUNT_B),
      getAddress(ACCOUNT_C),
    ])
    expect(run.getMember(ACCOUNT_C)).toMatchObject({
      account: getAddress(ACCOUNT_C),
      blockNumber: 4n,
      groupId: GROUP_A,
      joined: true,
    })
    expect(run.progress).toEqual({
      confirmedThrough: {
        blockHash: blockHash(SAFE_HEAD),
        blockNumber: SAFE_HEAD,
      },
      last: {
        blockHash: blockHash(4n),
        blockNumber: 4n,
        logIndex: 0,
      },
      memberCount: 2n,
      signalCount: 4n,
    })
    expect(run.baseline.logCount).toBe(4)
    await expect(run.advance()).resolves.toEqual(run.snapshot)
    run.close()
    expect(run.readMembers().members).toHaveLength(2)
  })

  it('keeps complete blocks intact while honoring the requested page budget', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_B, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
      membershipLog(ACCOUNT_A, false, 2n),
    ])
    const run = await openGroupMembershipProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 2n,
      membersRetained: 2n,
      pagesScanned: 1n,
      phase: 'memberships',
    })
    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 3n,
      membersRetained: 1n,
      pagesScanned: 2n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.readMembers().members[0]?.account).toBe(getAddress(ACCOUNT_B))
  })

  it('handles an authenticated empty history without inventing members', async () => {
    const prepared = await prepareProjection([])
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )

    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 0n,
      membersRetained: 0n,
      pagesScanned: 1n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.readMembers().members).toEqual([])
    expect(run.progress.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
  })

  it('fails closed when the cache moved beyond the stream anchor', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
    ])
    const cache = await openEventCache({
      ...prepared.storage,
      filter: getGroupMembershipFilter(GROUP_A),
    })
    try {
      const current = await cache.readLatest(seedCursor())
      await cache.apply(current, syncResult(current.cursor, []))
    } finally {
      cache.close()
    }
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )

    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
    expect(run.snapshot).toMatchObject({
      membersRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readMembers()).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
  })

  it('discards partial state when a continuation is invalidated', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_B, true, 2n),
    ])
    const run = await openGroupMembershipProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    expect(run.snapshot.membersRetained).toBe(1n)

    const cache = await openEventCache({
      ...prepared.storage,
      filter: getGroupMembershipFilter(GROUP_A),
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/changed during/i)
    expect(run.snapshot).toMatchObject({
      membersRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readMembers()).toThrow(/not complete/i)
  })

  it('reauthenticates the completed baseline before publication', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
    ])
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')

    const cache = await openEventCache({
      ...prepared.storage,
      filter: getGroupMembershipFilter(GROUP_A),
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.readMembers()).toThrow(/not complete/i)
  })

  it('rejects an anchor whose confirmed block left the provider chain', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
    ])
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    prepared.control.safeHeadHash = hash('replacement safe head')

    await expect(run.advance()).rejects.toThrow(/checkpoint changed/i)
    expect(run.snapshot).toMatchObject({
      membersRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readMembers()).toThrow(/not complete/i)
  })

  it('brackets provider authentication with exact cache proofs', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
    ])
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    const started = deferred()
    const release = deferred()
    prepared.control.beforeCheckpointReturn = async () => {
      started.resolve()
      await release.promise
    }

    const authenticating = run.advance()
    await started.promise
    const cache = await openEventCache({
      ...prepared.storage,
      filter: getGroupMembershipFilter(GROUP_A),
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }
    release.resolve()

    await expect(authenticating).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.readMembers()).toThrow(/not complete/i)
  })

  it('cancels provider authentication when the local run closes', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
    ])
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    const started = deferred()
    const release = deferred()
    prepared.control.beforeCheckpointReturn = async () => {
      started.resolve()
      await release.promise
    }

    const authenticating = run.advance()
    await started.promise
    run.close()
    release.resolve()

    await expect(authenticating).rejects.toThrow(/cancelled|closed/i)
    expect(run.snapshot).toMatchObject({
      membersRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.readMembers()).toThrow(/not complete/i)
  })

  it('rejects malformed, copied, cross-group, and invalid-page inputs', async () => {
    const prepared = await prepareProjection([])
    expect(Object.isFrozen(prepared.anchor)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.memberships)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.memberships.cursor)).toBe(true)
    await expect(
      openGroupMembershipProjectionRun(
        { ...prepared.anchor },
        prepared.storage,
      ),
    ).rejects.toThrow(/not issued by this page/i)
    await expect(
      openGroupMembershipProjectionRun(
        { ...prepared.anchor, safeHead: SAFE_HEAD - 1n },
        prepared.storage,
      ),
    ).rejects.toThrow(/safe head/i)
    await expect(
      openGroupMembershipProjectionRun(
        { ...prepared.anchor, groupId: GROUP_B },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openGroupMembershipProjectionRun(
        {
          ...prepared.anchor,
          memberships: {
            ...prepared.anchor.memberships,
            cursor: seedCursor(GROUP_A, 2n),
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openGroupMembershipProjectionRun(
        {
          ...prepared.anchor,
          memberships: {
            ...prepared.anchor.memberships,
            cursor: {
              ...prepared.anchor.memberships.cursor,
              checkpoints: [],
              nextBlock: GROUP_MEMBERSHIP_EVENT_START_BLOCK,
            },
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openGroupMembershipProjectionRun(undefined as never, prepared.storage),
    ).rejects.toThrow(/projection run anchor/i)
    await expect(
      openGroupMembershipProjectionRun(prepared.anchor, {
        ...prepared.storage,
        pageSize: 201,
      }),
    ).rejects.toThrow(/page size/i)
    await expect(
      openGroupMembershipProjectionRun(
        prepared.anchor,
        null as unknown as never,
      ),
    ).rejects.toThrow(/options/i)
  })

  it('returns defensive completed data and a reusable exact-group baseline', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
    ])
    const run = await openGroupMembershipProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()

    const members = run.readMembers().members
    members[0]!.joined = false
    const member = run.getMember(ACCOUNT_A)!
    member.joined = false
    const progress = run.progress
    progress.confirmedThrough!.blockNumber = 99n
    const baseline = run.baseline
    baseline.cursor.checkpoints[0]!.blockNumber = 99n
    baseline.last!.logIndex = 99
    expect(run.getMember(ACCOUNT_A)?.joined).toBe(true)
    expect(run.progress.confirmedThrough?.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.cursor.checkpoints[0]!.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.last).toEqual({ blockNumber: 1n, logIndex: 0 })

    const cache = await openEventCache({
      ...prepared.storage,
      filter: getGroupMembershipFilter(GROUP_A),
    })
    try {
      await expect(
        cache.scan(seedCursor(), { baseline: run.baseline }),
      ).resolves.toMatchObject({ complete: true, logs: [], reset: false })
    } finally {
      cache.close()
    }
  })

  it('rejects overlapping advances and discards state when closed', async () => {
    const prepared = await prepareProjection([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_B, true, 2n),
    ])
    const run = await openGroupMembershipProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    const advancing = run.advance()
    await expect(run.advance()).rejects.toThrow(/already advancing/i)
    await expect(advancing).resolves.toMatchObject({ phase: 'memberships' })
    run.close()

    expect(run.snapshot).toMatchObject({
      membersRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.readMembers()).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/run is closed/i)
  })
})
