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
  openFollowProjectionRun,
  type OpenFollowProjectionRunOptions,
} from './follow-projection-run'
import type { FollowDirection } from './follow-projection'
import {
  FOLLOW_EVENT_START_BLOCK,
  synchronizeFollowStream,
} from './follow-stream'
import { getFollowersFilter, getFollowingFilter } from './protocol-events'
import {
  FOLLOW_SET_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000cccc' as Address
const SELECTED = '0x000000000000000000000000000000000000fafa' as Address
const OTHER_SELECTED = '0x000000000000000000000000000000000000fbfb' as Address
const FOLLOW_DATA_PARAMETERS = [{ type: 'bool' }] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH
const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

type TestStorage = Required<
  Pick<OpenFollowProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenFollowProjectionRunOptions, 'keyRange'>

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

function followLog(
  counterpart: Address,
  following: boolean,
  blockNumber: bigint,
  options: {
    direction?: FollowDirection
    logIndex?: number
    selected?: Address
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const direction = options.direction ?? 'following'
  const selected = options.selected ?? SELECTED
  const follower = direction === 'following' ? selected : counterpart
  const followed = direction === 'following' ? counterpart : selected
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber,
    data: encodeAbiParameters(FOLLOW_DATA_PARAMETERS, [following]),
    logIndex,
    topics: [
      FOLLOW_SET_TOPIC,
      padHex(follower, { size: 32 }),
      padHex(followed, { size: 32 }),
    ],
    transactionHash: hash(
      `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
    ),
    transactionIndex,
  }
}

function getFilter(account: Address, direction: FollowDirection) {
  return direction === 'followers'
    ? getFollowersFilter(account)
    : getFollowingFilter(account)
}

function seedCursor(
  account = SELECTED,
  direction: FollowDirection = 'following',
  chainId = 1n,
) {
  return createEventCursor({
    chainId,
    filter: getFilter(account, direction),
    finalityDepth: FINALITY_DEPTH,
    startBlock: FOLLOW_EVENT_START_BLOCK,
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
    databaseName: `follow-projection-${crypto.randomUUID()}`,
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
        throw new Error('A caught-up follow stream must not request logs.')
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    },
  }
  return { control, provider }
}

async function populateFollows(
  storageOptions: TestStorage,
  logs: readonly IndexedEventLog[],
  account = SELECTED,
  direction: FollowDirection = 'following',
) {
  const seed = seedCursor(account, direction)
  const cache = await openEventCache({
    ...storageOptions,
    filter: getFilter(account, direction),
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

async function prepareProjection(
  logs: readonly IndexedEventLog[],
  direction: FollowDirection = 'following',
) {
  const storageOptions = storage()
  await populateFollows(storageOptions, logs, SELECTED, direction)
  const { control, provider } = anchorProvider()
  const synchronized = await synchronizeFollowStream(
    provider,
    1n,
    SELECTED,
    direction,
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

describe('follow projection run', () => {
  it('publishes latest public follow only after bounded local work', async () => {
    const prepared = await prepareProjection([
      followLog(ACCOUNT_A, true, 1n),
      followLog(ACCOUNT_B, true, 2n),
      followLog(ACCOUNT_A, false, 3n),
      followLog(ACCOUNT_C, true, 4n),
    ])
    const run = await openFollowProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    expect(run.snapshot).toEqual({
      account: getAddress(SELECTED),
      chainId: 1n,
      direction: 'following',
      head: HEAD,
      logsProcessed: 0n,
      relationshipsRetained: 0n,
      pagesScanned: 0n,
      phase: 'follows',
      safeHead: SAFE_HEAD,
    })
    expect(run.account).toBe(getAddress(SELECTED))
    expect(run.direction).toBe('following')
    expect(() => run.readRelationships()).toThrow(/not complete/i)
    expect(() => run.getRelationship(ACCOUNT_A)).toThrow(/not complete/i)
    expect(() => run.hasRelationship(ACCOUNT_A)).toThrow(/not complete/i)
    expect(() => run.progress).toThrow(/not complete/i)
    expect(() => run.baseline).toThrow(/not complete/i)

    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 1n,
      relationshipsRetained: 1n,
      pagesScanned: 1n,
      phase: 'follows',
    })
    await run.advance()
    await run.advance()
    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 4n,
      relationshipsRetained: 2n,
      pagesScanned: 4n,
      phase: 'authenticate',
    })
    expect(() => run.readRelationships()).toThrow(/not complete/i)

    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.hasRelationship(ACCOUNT_A)).toBe(false)
    expect(run.getRelationship(ACCOUNT_A)).toBeUndefined()
    expect(
      run.readRelationships().relationships.map(({ followed }) => followed),
    ).toEqual([getAddress(ACCOUNT_B), getAddress(ACCOUNT_C)])
    expect(run.getRelationship(ACCOUNT_C)).toMatchObject({
      blockNumber: 4n,
      followed: getAddress(ACCOUNT_C),
      follower: getAddress(SELECTED),
      following: true,
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
      relationshipCount: 2n,
      signalCount: 4n,
    })
    expect(run.baseline.logCount).toBe(4)
    await expect(run.advance()).resolves.toEqual(run.snapshot)
    run.close()
    expect(run.readRelationships().relationships).toHaveLength(2)
  })

  it('projects an incoming account scope independently', async () => {
    const prepared = await prepareProjection(
      [
        followLog(ACCOUNT_A, true, 1n, { direction: 'followers' }),
        followLog(ACCOUNT_B, true, 2n, { direction: 'followers' }),
        followLog(ACCOUNT_A, false, 3n, { direction: 'followers' }),
      ],
      'followers',
    )
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)

    await run.advance()
    await run.advance()

    expect(run.snapshot).toMatchObject({
      account: getAddress(SELECTED),
      direction: 'followers',
      logsProcessed: 3n,
      relationshipsRetained: 1n,
      phase: 'complete',
    })
    expect(run.hasRelationship(ACCOUNT_A)).toBe(false)
    expect(run.getRelationship(ACCOUNT_B)).toMatchObject({
      followed: getAddress(SELECTED),
      follower: getAddress(ACCOUNT_B),
      following: true,
    })
  })

  it('keeps complete blocks intact while honoring the requested page budget', async () => {
    const prepared = await prepareProjection([
      followLog(ACCOUNT_A, true, 1n),
      followLog(ACCOUNT_B, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
      followLog(ACCOUNT_A, false, 2n),
    ])
    const run = await openFollowProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 2n,
      relationshipsRetained: 2n,
      pagesScanned: 1n,
      phase: 'follows',
    })
    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 3n,
      relationshipsRetained: 1n,
      pagesScanned: 2n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.readRelationships().relationships[0]?.followed).toBe(
      getAddress(ACCOUNT_B),
    )
  })

  it('handles an authenticated empty history without inventing relationships', async () => {
    const prepared = await prepareProjection([])
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)

    await run.advance()
    expect(run.snapshot).toMatchObject({
      logsProcessed: 0n,
      relationshipsRetained: 0n,
      pagesScanned: 1n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.readRelationships().relationships).toEqual([])
    expect(run.progress.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
  })

  it('fails closed when the cache moved beyond the stream anchor', async () => {
    const prepared = await prepareProjection([followLog(ACCOUNT_A, true, 1n)])
    const cache = await openEventCache({
      ...prepared.storage,
      filter: getFilter(SELECTED, 'following'),
    })
    try {
      const current = await cache.readLatest(seedCursor())
      await cache.apply(current, syncResult(current.cursor, []))
    } finally {
      cache.close()
    }
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)

    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
    expect(run.snapshot).toMatchObject({
      relationshipsRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readRelationships()).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
  })

  it('discards partial state when a continuation is invalidated', async () => {
    const prepared = await prepareProjection([
      followLog(ACCOUNT_A, true, 1n),
      followLog(ACCOUNT_B, true, 2n),
    ])
    const run = await openFollowProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    expect(run.snapshot.relationshipsRetained).toBe(1n)

    const cache = await openEventCache({
      ...prepared.storage,
      filter: getFilter(SELECTED, 'following'),
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/changed during/i)
    expect(run.snapshot).toMatchObject({
      relationshipsRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readRelationships()).toThrow(/not complete/i)
  })

  it('reauthenticates the completed baseline before publication', async () => {
    const prepared = await prepareProjection([followLog(ACCOUNT_A, true, 1n)])
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')

    const cache = await openEventCache({
      ...prepared.storage,
      filter: getFilter(SELECTED, 'following'),
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.readRelationships()).toThrow(/not complete/i)
  })

  it('rejects an anchor whose confirmed block left the provider chain', async () => {
    const prepared = await prepareProjection([followLog(ACCOUNT_A, true, 1n)])
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)
    await run.advance()
    prepared.control.safeHeadHash = hash('replacement safe head')

    await expect(run.advance()).rejects.toThrow(/checkpoint changed/i)
    expect(run.snapshot).toMatchObject({
      relationshipsRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readRelationships()).toThrow(/not complete/i)
  })

  it('brackets provider authentication with exact cache proofs', async () => {
    const prepared = await prepareProjection([followLog(ACCOUNT_A, true, 1n)])
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)
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
      filter: getFilter(SELECTED, 'following'),
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }
    release.resolve()

    await expect(authenticating).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.readRelationships()).toThrow(/not complete/i)
  })

  it('cancels provider authentication when the local run closes', async () => {
    const prepared = await prepareProjection([followLog(ACCOUNT_A, true, 1n)])
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)
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
      relationshipsRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.readRelationships()).toThrow(/not complete/i)
  })

  it('rejects malformed, copied, cross-scope, and invalid-page inputs', async () => {
    const prepared = await prepareProjection([])
    expect(Object.isFrozen(prepared.anchor)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.follows)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.follows.cursor)).toBe(true)
    await expect(
      openFollowProjectionRun({ ...prepared.anchor }, prepared.storage),
    ).rejects.toThrow(/not issued by this page/i)
    await expect(
      openFollowProjectionRun(
        { ...prepared.anchor, safeHead: SAFE_HEAD - 1n },
        prepared.storage,
      ),
    ).rejects.toThrow(/safe head/i)
    await expect(
      openFollowProjectionRun(
        { ...prepared.anchor, account: OTHER_SELECTED },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openFollowProjectionRun(
        { ...prepared.anchor, direction: 'followers' },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openFollowProjectionRun(
        {
          ...prepared.anchor,
          follows: {
            ...prepared.anchor.follows,
            cursor: seedCursor(SELECTED, 'following', 2n),
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openFollowProjectionRun(
        {
          ...prepared.anchor,
          follows: {
            ...prepared.anchor.follows,
            cursor: {
              ...prepared.anchor.follows.cursor,
              checkpoints: [],
              nextBlock: FOLLOW_EVENT_START_BLOCK,
            },
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openFollowProjectionRun(undefined as never, prepared.storage),
    ).rejects.toThrow(/projection run anchor/i)
    await expect(
      openFollowProjectionRun(prepared.anchor, {
        ...prepared.storage,
        pageSize: 201,
      }),
    ).rejects.toThrow(/page size/i)
    await expect(
      openFollowProjectionRun(prepared.anchor, null as unknown as never),
    ).rejects.toThrow(/options/i)
  })

  it('returns defensive completed data and a reusable exact-scope baseline', async () => {
    const prepared = await prepareProjection([followLog(ACCOUNT_A, true, 1n)])
    const run = await openFollowProjectionRun(prepared.anchor, prepared.storage)
    await run.advance()
    await run.advance()

    const relationships = run.readRelationships().relationships
    relationships[0]!.following = false
    const relationship = run.getRelationship(ACCOUNT_A)!
    relationship.following = false
    const progress = run.progress
    progress.confirmedThrough!.blockNumber = 99n
    const baseline = run.baseline
    baseline.cursor.checkpoints[0]!.blockNumber = 99n
    baseline.last!.logIndex = 99
    expect(run.getRelationship(ACCOUNT_A)?.following).toBe(true)
    expect(run.progress.confirmedThrough?.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.cursor.checkpoints[0]!.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.last).toEqual({ blockNumber: 1n, logIndex: 0 })

    const cache = await openEventCache({
      ...prepared.storage,
      filter: getFilter(SELECTED, 'following'),
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
      followLog(ACCOUNT_A, true, 1n),
      followLog(ACCOUNT_B, true, 2n),
    ])
    const run = await openFollowProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    const advancing = run.advance()
    await expect(run.advance()).rejects.toThrow(/already advancing/i)
    await expect(advancing).resolves.toMatchObject({ phase: 'follows' })
    run.close()

    expect(run.snapshot).toMatchObject({
      relationshipsRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.readRelationships()).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/run is closed/i)
  })
})
