import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import {
  BrowserEventCache,
  openEventCache,
  type EventCachePosition,
} from './event-cache'
import type { Eip1193Provider } from './ethereum'
import {
  createEventCursor,
  type EventCursor,
  type EventLogFilter,
  type EventSyncResult,
  type IndexedEventLog,
} from './event-indexer'
import {
  openPostReactionProjectionRun,
  type OpenPostReactionProjectionRunOptions,
} from './post-reaction-projection-run'
import {
  getPostReactionProjectionSnapshotDigest,
  PostReactionProjection,
} from './post-reaction-projection'
import {
  POST_REACTION_EVENT_START_BLOCK,
  synchronizePostReactionStream,
} from './post-reaction-stream'
import {
  POST_CONTENT_KIND_TOPIC,
  POST_LIKE_SET_FILTER,
  PUBLISHED_REPOST_FILTER,
} from './protocol-events'
import {
  LIFEINVADER_INIT_CODE,
  LIKE_SET_TOPIC,
  PROTOCOL_ADDRESS,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'
import { ProtocolHistoryUnavailableError } from './protocol-history'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const LIKE_DATA_PARAMETERS = [{ type: 'bool' }] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH
const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

type TestStorage = Required<
  Pick<OpenPostReactionProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenPostReactionProjectionRunOptions, 'keyRange'>

type AnchorProviderControl = {
  head: bigint
  headAfterRead?: bigint
  replaceSafeHeadAfterHeadReads?: {
    hash: Hex
    remaining: number
  }
  safeHeadHash: Hex
}

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function blockHash(blockNumber: bigint) {
  return hash(`block:${blockNumber.toString()}`)
}

function baseLog(
  blockNumber: bigint,
  family: string,
  logIndex = 0,
): IndexedEventLog {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber,
    data: '0x',
    logIndex,
    topics: [],
    transactionHash: hash(
      `transaction:${family}:${blockNumber.toString()}:${logIndex.toString()}`,
    ),
    transactionIndex: logIndex,
  }
}

function likeLog(
  blockNumber: bigint,
  options: {
    account?: Address
    liked?: boolean
    postId?: bigint
  } = {},
): IndexedEventLog {
  const account = options.account ?? ACCOUNT_A
  const liked = options.liked ?? true
  const postId = options.postId ?? 7n
  return {
    ...baseLog(blockNumber, 'like'),
    data: encodeAbiParameters(LIKE_DATA_PARAMETERS, [liked]),
    topics: [
      LIKE_SET_TOPIC,
      POST_CONTENT_KIND_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(account, { size: 32 }),
    ],
  }
}

function repostLog(
  blockNumber: bigint,
  options: { account?: Address; postId?: bigint } = {},
): IndexedEventLog {
  const account = options.account ?? ACCOUNT_A
  const postId = options.postId ?? 7n
  return {
    ...baseLog(blockNumber, 'repost'),
    topics: [
      REPOST_PUBLISHED_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(account, { size: 32 }),
    ],
  }
}

function seedCursor(filter: EventLogFilter) {
  return createEventCursor({
    chainId: 1n,
    filter,
    finalityDepth: FINALITY_DEPTH,
    startBlock: POST_REACTION_EVENT_START_BLOCK,
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
    databaseName: `post-reaction-projection-${crypto.randomUUID()}`,
    factory: new IDBFactory(),
    keyRange: IDBKeyRange,
  }
}

async function unsupportedHistory(): Promise<never> {
  throw new ProtocolHistoryUnavailableError(
    0n,
    new Error('Historical state is unavailable.'),
  )
}

function anchorProvider() {
  const control: AnchorProviderControl = {
    head: HEAD,
    safeHeadHash: blockHash(SAFE_HEAD),
  }
  const provider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_blockNumber') {
        const head = control.head
        if (control.headAfterRead !== undefined) {
          control.head = control.headAfterRead
          control.headAfterRead = undefined
        }
        if (control.replaceSafeHeadAfterHeadReads) {
          control.replaceSafeHeadAfterHeadReads.remaining -= 1
          if (control.replaceSafeHeadAfterHeadReads.remaining === 0) {
            control.safeHeadHash = control.replaceSafeHeadAfterHeadReads.hash
            delete control.replaceSafeHeadAfterHeadReads
          }
        }
        return toHex(head)
      }
      if (method === 'eth_getBlockByNumber') {
        const [number] = params as [Hex]
        const blockNumber = BigInt(number)
        return {
          hash:
            blockNumber === SAFE_HEAD
              ? control.safeHeadHash
              : blockHash(blockNumber),
          number,
        }
      }
      if (method === 'eth_getLogs') {
        throw new Error('A caught-up reaction stream must not request logs.')
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    }),
  } satisfies Eip1193Provider
  return { control, provider }
}

async function populateStream(
  storageOptions: TestStorage,
  filter: EventLogFilter,
  logs: readonly IndexedEventLog[],
) {
  const seed = seedCursor(filter)
  const cache = await openEventCache({ ...storageOptions, filter })
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

async function appendStream(
  storageOptions: TestStorage,
  filter: EventLogFilter,
  logs: readonly IndexedEventLog[],
  head: bigint,
  safeHead: bigint,
) {
  const seed = seedCursor(filter)
  const cache = await openEventCache({ ...storageOptions, filter })
  try {
    const current = await cache.readLatest(seed)
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
      head,
      logs,
      safeHead,
      scannedRanges: 1,
    })
  } finally {
    cache.close()
  }
}

async function completeRun(
  run: Awaited<ReturnType<typeof openPostReactionProjectionRun>>,
) {
  for (let steps = 0; run.snapshot.phase !== 'complete'; steps += 1) {
    if (steps >= 16) throw new Error('The projection did not complete.')
    await run.advance()
  }
}

async function prepareProjection(
  likes: readonly IndexedEventLog[],
  reposts: readonly IndexedEventLog[],
) {
  const storageOptions = storage()
  await populateStream(storageOptions, POST_LIKE_SET_FILTER, likes)
  await populateStream(storageOptions, PUBLISHED_REPOST_FILTER, reposts)
  const { control, provider } = anchorProvider()
  const synchronized = await synchronizePostReactionStream(provider, 1n, {
    resolveHistoryBoundary: unsupportedHistory,
    storage: storageOptions,
  })
  if (!synchronized.projectionAnchor) {
    throw new Error('The test streams did not issue a projection anchor.')
  }
  return {
    anchor: synchronized.projectionAnchor,
    control,
    provider,
    storage: storageOptions,
  }
}

describe('post reaction projection run', () => {
  it('publishes exact totals only after both bounded scans complete', async () => {
    const prepared = await prepareProjection(
      [
        likeLog(1n),
        likeLog(2n, { account: ACCOUNT_B }),
        likeLog(3n, { liked: false }),
      ],
      [repostLog(1n), repostLog(2n, { account: ACCOUNT_B })],
    )
    const run = await openPostReactionProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })

    expect(run.snapshot).toEqual({
      chainId: 1n,
      head: HEAD,
      likes: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
      phase: 'likes',
      reposts: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
      safeHead: SAFE_HEAD,
      startBlock: POST_REACTION_EVENT_START_BLOCK,
    })
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
    expect(() => run.baselines).toThrow(/not complete/i)
    expect(() => run.projectionSnapshot).toThrow(/not complete/i)
    expect(() => run.resumeState).toThrow(/not complete/i)

    await run.advance()
    expect(run.snapshot).toMatchObject({
      likes: { complete: false, logsProcessed: 1n, pagesScanned: 1n },
      phase: 'likes',
    })
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)

    await run.advance()
    await run.advance()
    expect(run.snapshot).toMatchObject({
      likes: { complete: true, logsProcessed: 3n, pagesScanned: 3n },
      phase: 'reposts',
    })
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)

    await run.advance()
    await run.advance()
    expect(run.snapshot).toMatchObject({
      phase: 'authenticate',
      reposts: { complete: true, logsProcessed: 2n, pagesScanned: 2n },
    })
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
    await run.advance()
    expect(run.snapshot.phase).toBe('complete')
    expect(run.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 1n,
      likedByAccount: false,
      repostCount: 2n,
    })
    expect(run.getSummary(7n, ACCOUNT_B)).toEqual({
      likeCount: 1n,
      likedByAccount: true,
      repostCount: 2n,
    })
    expect(run.baselines.likes.logCount).toBe(3)
    expect(run.baselines.reposts.logCount).toBe(2)
    expect(run.projectionSnapshot.repostCounts).toEqual([
      { count: 2n, postId: 7n },
    ])
    expect(run.projectionSnapshot.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
    expect(run.projectionSnapshot.blockHashes).toEqual([])
    const resume = run.resumeState
    const digest = getPostReactionProjectionSnapshotDigest(resume.projection)
    expect(resume.bindings.likes.digest).toBe(digest)
    expect(resume.bindings.reposts.digest).toBe(digest)
    expect(resume.baselines.likes.logCount).toBe(3)
    expect(resume.baselines.reposts.logCount).toBe(2)
    await expect(run.advance()).resolves.toEqual(run.snapshot)
    run.close()
    expect(run.getSummary(7n).repostCount).toBe(2n)
  })

  it('handles a caught-up empty history without inventing progress', async () => {
    const prepared = await prepareProjection([], [])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )

    await run.advance()
    expect(run.snapshot).toMatchObject({
      likes: { complete: true, logsProcessed: 0n, pagesScanned: 1n },
      phase: 'reposts',
    })
    await run.advance()
    expect(run.snapshot).toMatchObject({
      phase: 'authenticate',
      reposts: { complete: true, logsProcessed: 0n, pagesScanned: 1n },
    })
    await run.advance()
    expect(run.snapshot.phase).toBe('complete')
    expect(run.getSummary(1n)).toEqual({
      likeCount: 0n,
      repostCount: 0n,
    })
    expect(run.projectionSnapshot.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
  })

  it('preserves a confirmed boundary when only one stream has events', async () => {
    const prepared = await prepareProjection([likeLog(1n), likeLog(2n)], [])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )

    await run.advance()
    await run.advance()
    await run.advance()
    const snapshot = run.projectionSnapshot
    expect(snapshot.blockHashes).toEqual([])
    expect(snapshot.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
    const restored = PostReactionProjection.fromSnapshot(snapshot)
    expect(() => restored.applyRepostLogs([repostLog(SAFE_HEAD)])).toThrow(
      /page boundary/i,
    )
  })

  it('returns defensive progress and reusable authenticated baselines', async () => {
    const prepared = await prepareProjection([likeLog(1n)], [repostLog(2n)])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    await run.advance()

    const snapshot = run.snapshot
    snapshot.likes.logsProcessed = 99n
    const baselines = run.baselines
    baselines.likes.cursor.checkpoints[0]!.blockNumber = 99n
    baselines.likes.last!.logIndex = 99
    const resume = run.resumeState
    resume.baselines.reposts.logCount = 99
    resume.bindings.likes.proof = hash('mutated binding')
    resume.projection.repostCounts[0]!.count = 99n
    expect(run.snapshot.likes.logsProcessed).toBe(1n)
    expect(run.baselines.likes.cursor.checkpoints[0]!.blockNumber).toBe(
      SAFE_HEAD,
    )
    expect(run.baselines.likes.last).toEqual({
      blockNumber: 1n,
      logIndex: 0,
    })
    expect(run.resumeState.baselines.reposts.logCount).toBe(1)
    expect(run.resumeState.bindings.likes.proof).not.toBe(
      hash('mutated binding'),
    )
    expect(run.resumeState.projection.repostCounts[0]?.count).toBe(1n)

    const likeCache = await openEventCache({
      ...prepared.storage,
      filter: POST_LIKE_SET_FILTER,
    })
    try {
      await expect(
        likeCache.scan(seedCursor(POST_LIKE_SET_FILTER), {
          baseline: run.baselines.likes,
        }),
      ).resolves.toMatchObject({ complete: true, logs: [], reset: false })
    } finally {
      likeCache.close()
    }
  })

  it('authenticates a saved projection and scans only appended reactions', async () => {
    const prepared = await prepareProjection(
      [likeLog(1n), likeLog(2n, { account: ACCOUNT_B })],
      [repostLog(3n)],
    )
    const first = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await completeRun(first)
    const resume = first.resumeState

    const nextHead = 19n
    const nextSafeHead = nextHead - FINALITY_DEPTH
    await appendStream(
      prepared.storage,
      POST_LIKE_SET_FILTER,
      [likeLog(6n, { liked: false })],
      nextHead,
      nextSafeHead,
    )
    await appendStream(
      prepared.storage,
      PUBLISHED_REPOST_FILTER,
      [repostLog(7n, { account: ACCOUNT_B })],
      nextHead,
      nextSafeHead,
    )
    prepared.control.head = nextHead
    const synchronized = await synchronizePostReactionStream(
      prepared.provider,
      1n,
      {
        resolveHistoryBoundary: unsupportedHistory,
        storage: prepared.storage,
      },
    )
    if (!synchronized.projectionAnchor) {
      throw new Error('The updated streams did not issue a projection anchor.')
    }

    const resumed = await openPostReactionProjectionRun(
      synchronized.projectionAnchor,
      { ...prepared.storage, pageSize: 1, resume },
    )
    expect(resumed.snapshot).toMatchObject({
      likes: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
      phase: 'likes',
      reposts: { complete: false, logsProcessed: 0n, pagesScanned: 0n },
      safeHead: nextSafeHead,
    })
    expect(() => resumed.getSummary(7n, ACCOUNT_A)).toThrow(/not complete/i)

    await resumed.advance()
    expect(resumed.snapshot).toMatchObject({
      likes: { complete: true, logsProcessed: 1n, pagesScanned: 1n },
      phase: 'reposts',
    })
    await resumed.advance()
    expect(resumed.snapshot).toMatchObject({
      phase: 'authenticate',
      reposts: { complete: true, logsProcessed: 1n, pagesScanned: 1n },
    })
    await resumed.advance()

    expect(resumed.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 1n,
      likedByAccount: false,
      repostCount: 2n,
    })
    expect(resumed.getSummary(7n, ACCOUNT_B)).toEqual({
      likeCount: 1n,
      likedByAccount: true,
      repostCount: 2n,
    })
    expect(resumed.baselines.likes.logCount).toBe(3)
    expect(resumed.baselines.reposts.logCount).toBe(2)
    expect(resumed.projectionSnapshot.confirmedThrough).toEqual({
      blockHash: blockHash(nextSafeHead),
      blockNumber: nextSafeHead,
    })
    expect(resumed.resumeState.bindings.likes.digest).not.toBe(
      resume.bindings.likes.digest,
    )
  })

  it('reauthenticates an unchanged saved projection without replaying logs', async () => {
    const prepared = await prepareProjection([likeLog(1n)], [repostLog(2n)])
    const first = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await completeRun(first)
    const resume = first.resumeState

    const resumed = await openPostReactionProjectionRun(prepared.anchor, {
      ...prepared.storage,
      resume,
    })
    await resumed.advance()
    await resumed.advance()
    expect(resumed.snapshot).toMatchObject({
      likes: { complete: true, logsProcessed: 0n, pagesScanned: 1n },
      phase: 'authenticate',
      reposts: { complete: true, logsProcessed: 0n, pagesScanned: 1n },
    })
    await resumed.advance()

    expect(resumed.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 1n,
      likedByAccount: true,
      repostCount: 1n,
    })
    expect(resumed.resumeState.bindings.likes.digest).toBe(
      resume.bindings.likes.digest,
    )
    expect(resumed.resumeState.bindings.reposts.digest).toBe(
      resume.bindings.reposts.digest,
    )
  })

  it('rejects edited or mismatched saved reaction projections', async () => {
    const prepared = await prepareProjection([likeLog(1n)], [repostLog(2n)])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await completeRun(run)
    const resume = run.resumeState
    const editedProjection = {
      ...resume.projection,
      repostCounts: [{ count: 99n, postId: 7n }],
    }
    const editedDigest =
      getPostReactionProjectionSnapshotDigest(editedProjection)

    await expect(
      openPostReactionProjectionRun(prepared.anchor, {
        ...prepared.storage,
        resume: { ...resume, projection: editedProjection },
      }),
    ).rejects.toThrow(/resume projection digest/i)
    await expect(
      openPostReactionProjectionRun(prepared.anchor, {
        ...prepared.storage,
        resume: {
          ...resume,
          bindings: {
            likes: { ...resume.bindings.likes, digest: editedDigest },
            reposts: { ...resume.bindings.reposts, digest: editedDigest },
          },
          projection: editedProjection,
        },
      }),
    ).rejects.toThrow(/derived state binding changed or is corrupt/i)
    await expect(
      openPostReactionProjectionRun(prepared.anchor, {
        ...prepared.storage,
        resume: {
          ...resume,
          bindings: {
            ...resume.bindings,
            likes: {
              ...resume.bindings.likes,
              proof: hash('edited like proof'),
            },
          },
        },
      }),
    ).rejects.toThrow(/derived state binding changed or is corrupt/i)
    await expect(
      openPostReactionProjectionRun(prepared.anchor, {
        ...prepared.storage,
        resume: {
          ...resume,
          baselines: {
            likes: resume.baselines.reposts,
            reposts: resume.baselines.likes,
          },
        },
      }),
    ).rejects.toThrow(/like resume baseline/i)
  })

  it('fails closed when the cache moved beyond the verified anchor', async () => {
    const prepared = await prepareProjection([likeLog(1n)], [repostLog(2n)])
    const likeCache = await openEventCache({
      ...prepared.storage,
      filter: POST_LIKE_SET_FILTER,
    })
    try {
      const seed = seedCursor(POST_LIKE_SET_FILTER)
      const current = await likeCache.readLatest(seed)
      await likeCache.apply(current, syncResult(current.cursor, []))
    } finally {
      likeCache.close()
    }
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )

    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
  })

  it('reauthenticates completed likes after the repost scan', async () => {
    const prepared = await prepareProjection(
      [likeLog(1n)],
      [repostLog(2n), repostLog(3n, { account: ACCOUNT_B })],
    )
    const run = await openPostReactionProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    expect(run.snapshot.phase).toBe('reposts')

    const likeCache = await openEventCache({
      ...prepared.storage,
      filter: POST_LIKE_SET_FILTER,
    })
    try {
      await likeCache.clear(seedCursor(POST_LIKE_SET_FILTER))
    } finally {
      likeCache.close()
    }

    await run.advance()
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')
    await expect(run.advance()).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n, ACCOUNT_A)).toThrow(/not complete/i)
  })

  it('authenticates reposts in the same final cache transaction', async () => {
    const prepared = await prepareProjection([likeLog(1n)], [repostLog(2n)])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')

    const repostCache = await openEventCache({
      ...prepared.storage,
      filter: PUBLISHED_REPOST_FILTER,
    })
    try {
      await repostCache.clear(seedCursor(PUBLISHED_REPOST_FILTER))
    } finally {
      repostCache.close()
    }

    await expect(run.advance()).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
  })

  it('rejects an anchor whose confirmed block left the provider chain', async () => {
    const prepared = await prepareProjection([], [])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    prepared.control.safeHeadHash = hash('replacement safe head')

    await expect(run.advance()).rejects.toThrow(/checkpoint changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
  })

  it('rejects a provider head that regresses during final cache proof', async () => {
    const prepared = await prepareProjection([], [])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    prepared.control.headAfterRead = HEAD - 1n

    await expect(run.advance()).rejects.toThrow(
      /head moved behind the post reaction projection anchor/i,
    )
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
  })

  it('rechecks the checkpoint after the final provider head read', async () => {
    const prepared = await prepareProjection([], [])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    prepared.control.replaceSafeHeadAfterHeadReads = {
      hash: hash('replacement after the final head read'),
      remaining: 2,
    }

    await expect(run.advance()).rejects.toThrow(/checkpoint changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
  })

  it('does not start provider authentication after a projection is closed', async () => {
    const prepared = await prepareProjection([], [])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')

    let enterAuthentication!: () => void
    let releaseAuthentication!: () => void
    const authenticationEntered = new Promise<void>((resolve) => {
      enterAuthentication = resolve
    })
    const authenticationBlocked = new Promise<void>((resolve) => {
      releaseAuthentication = resolve
    })
    const authenticate = vi
      .spyOn(BrowserEventCache.prototype, 'authenticateBaselines')
      .mockImplementationOnce(async () => {
        enterAuthentication()
        await authenticationBlocked
      })
    const providerRequestCount = prepared.provider.request.mock.calls.length

    const advancing = run.advance()
    await authenticationEntered
    run.close()
    releaseAuthentication()

    await expect(advancing).rejects.toThrow(/cancelled/i)
    expect(run.snapshot.phase).toBe('closed')
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(prepared.provider.request).toHaveBeenCalledTimes(
      providerRequestCount,
    )
  })

  it('discards a partial projection when its scan session is invalidated', async () => {
    const prepared = await prepareProjection(
      [likeLog(1n), likeLog(2n, { account: ACCOUNT_B })],
      [repostLog(3n)],
    )
    const run = await openPostReactionProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    expect(run.snapshot.likes.logsProcessed).toBe(1n)

    const likeCache = await openEventCache({
      ...prepared.storage,
      filter: POST_LIKE_SET_FILTER,
    })
    try {
      await likeCache.clear(seedCursor(POST_LIKE_SET_FILTER))
    } finally {
      likeCache.close()
    }

    await expect(run.advance()).rejects.toThrow(/changed during/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getSummary(7n, ACCOUNT_A)).toThrow(/not complete/i)
    expect(() => run.baselines).toThrow(/not complete/i)
  })

  it('rejects malformed, non-caught-up, and cross-filter anchors', async () => {
    const prepared = await prepareProjection([], [])
    expect(Object.isFrozen(prepared.anchor)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.likes)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.likes.cursor)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.reposts)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.reposts.cursor)).toBe(true)
    await expect(
      openPostReactionProjectionRun({ ...prepared.anchor }, prepared.storage),
    ).rejects.toThrow(/not issued by this page/i)
    const conflictingRepostCheckpoints =
      prepared.anchor.reposts.cursor.checkpoints.map(
        (checkpoint, index, all) =>
          index === all.length - 1
            ? { ...checkpoint, blockHash: hash('another safe-head fork') }
            : checkpoint,
      )
    await expect(
      openPostReactionProjectionRun(
        {
          ...prepared.anchor,
          reposts: {
            ...prepared.anchor.reposts,
            cursor: {
              ...prepared.anchor.reposts.cursor,
              checkpoints: conflictingRepostCheckpoints,
            },
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/shared safe-head checkpoint/i)
    await expect(
      openPostReactionProjectionRun(
        {
          ...prepared.anchor,
          likes: {
            ...prepared.anchor.likes,
            cursor: prepared.anchor.reposts.cursor,
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/like anchor boundary/i)
    await expect(
      openPostReactionProjectionRun(
        {
          ...prepared.anchor,
          safeHead: SAFE_HEAD - 1n,
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/safe head/i)
    await expect(
      openPostReactionProjectionRun(
        {
          ...prepared.anchor,
          likes: {
            ...prepared.anchor.likes,
            cursor: {
              ...prepared.anchor.likes.cursor,
              checkpoints: [],
              nextBlock: POST_REACTION_EVENT_START_BLOCK,
            },
          },
        },
        prepared.storage,
      ),
    ).rejects.toThrow(/like anchor boundary/i)
    await expect(
      openPostReactionProjectionRun(undefined as never, prepared.storage),
    ).rejects.toThrow(/projection run anchor/i)
    await expect(
      openPostReactionProjectionRun(prepared.anchor, {
        ...prepared.storage,
        pageSize: 201,
      }),
    ).rejects.toThrow(/page size/i)
  })

  it('rejects overlapping advances without invalidating the active scan', async () => {
    const prepared = await prepareProjection([likeLog(1n)], [repostLog(2n)])
    const run = await openPostReactionProjectionRun(
      prepared.anchor,
      prepared.storage,
    )

    const advancing = run.advance()
    await expect(run.advance()).rejects.toThrow(/already advancing/i)
    await expect(advancing).resolves.toMatchObject({ phase: 'reposts' })
    await expect(run.advance()).resolves.toMatchObject({
      phase: 'authenticate',
    })
    await expect(run.advance()).resolves.toMatchObject({ phase: 'complete' })
  })

  it('discards partial derived state when closed', async () => {
    const prepared = await prepareProjection(
      [likeLog(1n), likeLog(2n, { account: ACCOUNT_B })],
      [repostLog(3n)],
    )
    const run = await openPostReactionProjectionRun(prepared.anchor, {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    run.close()

    expect(run.snapshot.phase).toBe('closed')
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
    expect(() => run.baselines).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/run is closed/i)
  })
})
