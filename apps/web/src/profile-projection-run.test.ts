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
  openProfileProjectionRun,
  type OpenProfileProjectionRunOptions,
} from './profile-projection-run'
import {
  PROFILE_EVENT_START_BLOCK,
  synchronizeProfileStream,
} from './profile-stream'
import { PROFILE_SET_FILTER } from './protocol-events'
import {
  PROFILE_SET_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000cccc' as Address
const PROFILE_DATA_PARAMETERS = [
  { type: 'string' },
  { type: 'string' },
  { type: 'bytes' },
] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH
const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

type TestStorage = Required<
  Pick<OpenProfileProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenProfileProjectionRunOptions, 'keyRange'>

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

function profileLog(
  blockNumber: bigint,
  options: {
    account?: Address
    avatarCid?: Hex
    bio?: string
    displayName?: string
    logIndex?: number
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const account = options.account ?? ACCOUNT_A
  const avatarCid = options.avatarCid ?? '0x01701220'
  const bio = options.bio ?? `bio at block ${blockNumber.toString()}`
  const displayName = options.displayName ?? 'Tracey'
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber,
    data: encodeAbiParameters(PROFILE_DATA_PARAMETERS, [
      displayName,
      bio,
      avatarCid,
    ]),
    logIndex,
    topics: [PROFILE_SET_TOPIC, padHex(account, { size: 32 })],
    transactionHash: hash(
      `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
    ),
    transactionIndex,
  }
}

function seedCursor(chainId = 1n) {
  return createEventCursor({
    chainId,
    filter: PROFILE_SET_FILTER,
    finalityDepth: FINALITY_DEPTH,
    startBlock: PROFILE_EVENT_START_BLOCK,
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
    databaseName: `profile-projection-${crypto.randomUUID()}`,
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
        throw new Error('A caught-up profile stream must not request logs.')
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    },
  }
  return { control, provider }
}

async function populateProfiles(
  storageOptions: TestStorage,
  logs: readonly IndexedEventLog[],
) {
  const seed = seedCursor()
  const cache = await openEventCache({
    ...storageOptions,
    filter: PROFILE_SET_FILTER,
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
  await populateProfiles(storageOptions, logs)
  const { control, provider } = anchorProvider()
  const synchronized = await synchronizeProfileStream(provider, 1n, {
    storage: storageOptions,
  })
  if (!synchronized.projectionAnchor) {
    throw new Error('The test stream did not issue a projection anchor.')
  }
  return {
    anchor: synchronized.projectionAnchor,
    control,
    provider,
    storage: storageOptions,
  }
}

describe('profile projection run', () => {
  it('publishes latest selected profiles only after bounded local work', async () => {
    const prepared = await prepareProjection([
      profileLog(1n, { displayName: 'Old A' }),
      profileLog(2n, { account: ACCOUNT_B, displayName: 'Current B' }),
      profileLog(3n, { displayName: 'Current A' }),
    ])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_B, ACCOUNT_A],
      { ...prepared.storage, pageSize: 1 },
    )

    expect(run.snapshot).toEqual({
      chainId: 1n,
      profilesRetained: 0n,
      head: HEAD,
      logsProcessed: 0n,
      pagesScanned: 0n,
      phase: 'profiles',
      safeHead: SAFE_HEAD,
      startBlock: PROFILE_EVENT_START_BLOCK,
    })
    expect(run.trackedAccounts).toEqual([
      getAddress(ACCOUNT_A),
      getAddress(ACCOUNT_B),
    ])
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
    expect(() => run.progress).toThrow(/not complete/i)
    expect(() => run.projectionSnapshot).toThrow(/not complete/i)
    expect(() => run.baseline).toThrow(/not complete/i)
    expect(() => run.resumeState).toThrow(/not complete/i)

    await run.advance()
    expect(run.snapshot).toMatchObject({
      profilesRetained: 1n,
      logsProcessed: 1n,
      pagesScanned: 1n,
      phase: 'profiles',
    })
    await run.advance()
    await run.advance()
    expect(run.snapshot).toMatchObject({
      profilesRetained: 2n,
      logsProcessed: 3n,
      pagesScanned: 3n,
      phase: 'authenticate',
    })
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)

    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.getProfile(ACCOUNT_A)).toMatchObject({
      account: getAddress(ACCOUNT_A),
      blockNumber: 3n,
      displayName: 'Current A',
    })
    expect(run.getProfile(ACCOUNT_B)).toMatchObject({
      account: getAddress(ACCOUNT_B),
      blockNumber: 2n,
      displayName: 'Current B',
    })
    expect(run.progress).toEqual({
      blockHash: blockHash(3n),
      blockNumber: 3n,
      logIndex: 0,
    })
    expect(run.projectionSnapshot).toMatchObject({
      accounts: [getAddress(ACCOUNT_A), getAddress(ACCOUNT_B)],
      confirmedThrough: {
        blockHash: blockHash(SAFE_HEAD),
        blockNumber: SAFE_HEAD,
      },
      last: {
        blockHash: blockHash(3n),
        blockNumber: 3n,
        logIndex: 0,
      },
      profiles: [
        { account: getAddress(ACCOUNT_A), displayName: 'Current A' },
        { account: getAddress(ACCOUNT_B), displayName: 'Current B' },
      ],
    })
    expect(run.baseline.logCount).toBe(3)
    expect(run.resumeState).toMatchObject({
      baseline: { logCount: 3 },
      binding: { digest: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
      projection: { profiles: expect.any(Array) },
    })
    await expect(run.advance()).resolves.toEqual(run.snapshot)
    run.close()
    expect(run.getProfile(ACCOUNT_A)?.displayName).toBe('Current A')
  })

  it('validates every global event while retaining only selected accounts', async () => {
    const prepared = await prepareProjection([
      profileLog(1n, { account: ACCOUNT_C }),
      profileLog(2n, { displayName: 'Selected A' }),
    ])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )

    await run.advance()
    expect(run.snapshot).toMatchObject({
      profilesRetained: 1n,
      logsProcessed: 2n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.getProfile(ACCOUNT_A)?.displayName).toBe('Selected A')
    expect(run.progress?.blockNumber).toBe(2n)
    expect(() => run.getProfile(ACCOUNT_C)).toThrow(/untracked account/i)
  })

  it('handles an authenticated empty history without inventing profiles', async () => {
    const prepared = await prepareProjection([])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )

    await run.advance()
    expect(run.snapshot).toMatchObject({
      profilesRetained: 0n,
      logsProcessed: 0n,
      pagesScanned: 1n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.getProfile(ACCOUNT_A)).toBeUndefined()
    expect(run.progress).toBeUndefined()
    expect(run.projectionSnapshot.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
  })

  it('fails closed when the cache moved beyond the stream anchor', async () => {
    const prepared = await prepareProjection([profileLog(1n)])
    const cache = await openEventCache({
      ...prepared.storage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      const seed = seedCursor()
      const current = await cache.readLatest(seed)
      await cache.apply(current, syncResult(current.cursor, []))
    } finally {
      cache.close()
    }
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )

    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
  })

  it('discards partial state when a continuation is invalidated', async () => {
    const prepared = await prepareProjection([
      profileLog(1n),
      profileLog(2n, { account: ACCOUNT_B }),
    ])
    const run = await openProfileProjectionRun(prepared.anchor, [ACCOUNT_A], {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    expect(run.snapshot.profilesRetained).toBe(1n)

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/changed during/i)
    expect(run.snapshot).toMatchObject({
      profilesRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
  })

  it('reauthenticates the completed baseline before publication', async () => {
    const prepared = await prepareProjection([profileLog(1n)])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
  })

  it('rejects an anchor whose confirmed block left the provider chain', async () => {
    const prepared = await prepareProjection([profileLog(1n)])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )
    await run.advance()
    prepared.control.safeHeadHash = hash('replacement safe head')

    await expect(run.advance()).rejects.toThrow(/checkpoint changed/i)
    expect(run.snapshot).toMatchObject({
      profilesRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
  })

  it('brackets provider authentication with exact cache proofs', async () => {
    const prepared = await prepareProjection([profileLog(1n)])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
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
      filter: PROFILE_SET_FILTER,
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }
    release.resolve()

    await expect(authenticating).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
  })

  it('cancels provider authentication when the local run closes', async () => {
    const prepared = await prepareProjection([profileLog(1n)])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
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
      profilesRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
  })

  it('retains an all-empty event as the latest public clear snapshot', async () => {
    const prepared = await prepareProjection([
      profileLog(1n, { displayName: 'Before clear' }),
      profileLog(2n, { avatarCid: '0x', bio: '', displayName: '' }),
    ])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )
    await run.advance()
    await run.advance()

    expect(run.getProfile(ACCOUNT_A)).toMatchObject({
      avatarCid: '0x',
      bio: '',
      blockNumber: 2n,
      displayName: '',
    })
    expect(run.snapshot.profilesRetained).toBe(1n)
  })

  it('rejects malformed, non-caught-up, and cross-chain anchors', async () => {
    const prepared = await prepareProjection([])
    expect(Object.isFrozen(prepared.anchor)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.profiles)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.profiles.cursor)).toBe(true)
    await expect(
      openProfileProjectionRun(
        { ...prepared.anchor },
        [ACCOUNT_A],
        prepared.storage,
      ),
    ).rejects.toThrow(/not issued by this page/i)
    await expect(
      openProfileProjectionRun(
        { ...prepared.anchor, safeHead: SAFE_HEAD - 1n },
        [ACCOUNT_A],
        prepared.storage,
      ),
    ).rejects.toThrow(/safe head/i)
    await expect(
      openProfileProjectionRun(
        {
          ...prepared.anchor,
          profiles: {
            ...prepared.anchor.profiles,
            cursor: seedCursor(2n),
          },
        },
        [ACCOUNT_A],
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openProfileProjectionRun(
        {
          ...prepared.anchor,
          profiles: {
            ...prepared.anchor.profiles,
            cursor: {
              ...prepared.anchor.profiles.cursor,
              checkpoints: [],
              nextBlock: PROFILE_EVENT_START_BLOCK,
            },
          },
        },
        [ACCOUNT_A],
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openProfileProjectionRun(
        undefined as never,
        [ACCOUNT_A],
        prepared.storage,
      ),
    ).rejects.toThrow(/projection run anchor/i)
    await expect(
      openProfileProjectionRun(prepared.anchor, [], prepared.storage),
    ).rejects.toThrow(/tracked accounts/i)
    await expect(
      openProfileProjectionRun(prepared.anchor, [ACCOUNT_A], {
        ...prepared.storage,
        pageSize: 201,
      }),
    ).rejects.toThrow(/page size/i)
  })

  it('returns defensive completed data and a reusable baseline', async () => {
    const prepared = await prepareProjection([
      profileLog(1n, { bio: 'Original bio', displayName: 'Original name' }),
    ])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )
    await run.advance()
    await run.advance()

    const profile = run.getProfile(ACCOUNT_A)!
    profile.displayName = 'mutated'
    const projectionSnapshot = run.projectionSnapshot
    projectionSnapshot.profiles[0]!.bio = 'mutated'
    const progress = run.progress!
    progress.logIndex = 99
    const baseline = run.baseline
    baseline.cursor.checkpoints[0]!.blockNumber = 99n
    baseline.last!.logIndex = 99
    const resume = run.resumeState
    resume.baseline.logCount = 99
    resume.binding.proof = hash('mutated binding')
    resume.projection.profiles[0]!.bio = 'mutated resume'
    expect(run.getProfile(ACCOUNT_A)).toMatchObject({
      bio: 'Original bio',
      displayName: 'Original name',
    })
    expect(run.projectionSnapshot.profiles[0]?.bio).toBe('Original bio')
    expect(run.progress?.logIndex).toBe(0)
    expect(run.baseline.cursor.checkpoints[0]!.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.last).toEqual({ blockNumber: 1n, logIndex: 0 })
    expect(run.resumeState.baseline.logCount).toBe(1)
    expect(run.resumeState.binding.proof).not.toBe(hash('mutated binding'))
    expect(run.resumeState.projection.profiles[0]?.bio).toBe('Original bio')

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      await expect(
        cache.scan(seedCursor(), { baseline: run.baseline }),
      ).resolves.toMatchObject({ complete: true, logs: [], reset: false })
    } finally {
      cache.close()
    }
  })

  it('authenticates a saved projection and scans only appended events', async () => {
    const prepared = await prepareProjection([
      profileLog(1n, { displayName: 'Old A' }),
      profileLog(2n, { account: ACCOUNT_B, displayName: 'Current B' }),
      profileLog(3n, { displayName: 'Current A' }),
    ])
    const first = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A, ACCOUNT_B],
      prepared.storage,
    )
    await first.advance()
    await first.advance()
    const resume = first.resumeState

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PROFILE_SET_FILTER,
    })
    try {
      const seed = seedCursor()
      const current = await cache.readLatest(seed)
      const safeHead = 7n
      const cursor = {
        ...current.cursor,
        checkpoints: [
          ...current.cursor.checkpoints,
          { blockHash: blockHash(safeHead), blockNumber: safeHead },
        ],
        nextBlock: safeHead + 1n,
      } satisfies EventCursor
      await cache.apply(current, {
        caughtUp: true,
        cursor,
        head: 19n,
        logs: [profileLog(6n, { displayName: 'Delta A' })],
        safeHead,
        scannedRanges: 1,
      })
    } finally {
      cache.close()
    }
    prepared.control.head = 19n
    const synchronized = await synchronizeProfileStream(prepared.provider, 1n, {
      storage: prepared.storage,
    })
    if (!synchronized.projectionAnchor) {
      throw new Error('The updated stream did not issue a projection anchor.')
    }

    const resumed = await openProfileProjectionRun(
      synchronized.projectionAnchor,
      [ACCOUNT_A, ACCOUNT_B],
      { ...prepared.storage, pageSize: 1, resume },
    )
    expect(resumed.snapshot).toMatchObject({
      logsProcessed: 0n,
      pagesScanned: 0n,
      profilesRetained: 2n,
      phase: 'profiles',
      safeHead: 7n,
    })
    expect(() => resumed.getProfile(ACCOUNT_A)).toThrow(/not complete/i)

    await resumed.advance()
    expect(resumed.snapshot).toMatchObject({
      logsProcessed: 1n,
      pagesScanned: 1n,
      profilesRetained: 2n,
      phase: 'authenticate',
    })
    await resumed.advance()

    expect(resumed.getProfile(ACCOUNT_A)).toMatchObject({
      blockNumber: 6n,
      displayName: 'Delta A',
    })
    expect(resumed.getProfile(ACCOUNT_B)?.displayName).toBe('Current B')
    expect(resumed.baseline.logCount).toBe(4)
    expect(resumed.projectionSnapshot.confirmedThrough).toEqual({
      blockHash: blockHash(7n),
      blockNumber: 7n,
    })
    expect(resumed.resumeState.binding.digest).not.toBe(resume.binding.digest)
  })

  it('rejects edited or mismatched saved projections before publication', async () => {
    const prepared = await prepareProjection([profileLog(1n)])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A],
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    const resume = run.resumeState
    const editedProjection = {
      ...resume.projection,
      profiles: resume.projection.profiles.map((profile) => ({
        ...profile,
        displayName: 'Edited',
      })),
    }

    await expect(
      openProfileProjectionRun(prepared.anchor, [ACCOUNT_A], {
        ...prepared.storage,
        resume: { ...resume, projection: editedProjection },
      }),
    ).rejects.toThrow(/resume projection digest/i)
    await expect(
      openProfileProjectionRun(prepared.anchor, [ACCOUNT_A], {
        ...prepared.storage,
        resume: {
          ...resume,
          binding: { ...resume.binding, proof: hash('edited proof') },
        },
      }),
    ).rejects.toThrow(/derived state binding changed or is corrupt/i)
    await expect(
      openProfileProjectionRun(prepared.anchor, [ACCOUNT_B], {
        ...prepared.storage,
        resume,
      }),
    ).rejects.toThrow(/resume accounts/i)
  })

  it('rejects overlapping advances and discards state when closed', async () => {
    const prepared = await prepareProjection([
      profileLog(1n),
      profileLog(2n, { account: ACCOUNT_B }),
    ])
    const run = await openProfileProjectionRun(
      prepared.anchor,
      [ACCOUNT_A, ACCOUNT_B],
      { ...prepared.storage, pageSize: 1 },
    )

    const advancing = run.advance()
    await expect(run.advance()).rejects.toThrow(/already advancing/i)
    await expect(advancing).resolves.toMatchObject({ phase: 'profiles' })
    run.close()

    expect(run.snapshot).toMatchObject({
      profilesRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.getProfile(ACCOUNT_A)).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/run is closed/i)
  })
})
