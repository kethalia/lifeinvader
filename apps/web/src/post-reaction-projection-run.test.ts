import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
} from 'viem'
import { openEventCache, type EventCachePosition } from './event-cache'
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
  POST_REACTION_EVENT_START_BLOCK,
  type PostReactionProjectionAnchor,
} from './post-reaction-stream'
import {
  POST_CONTENT_KIND_TOPIC,
  POST_LIKE_SET_FILTER,
  PUBLISHED_REPOST_FILTER,
} from './protocol-events'
import {
  LIKE_SET_TOPIC,
  PROTOCOL_ADDRESS,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const LIKE_DATA_PARAMETERS = [{ type: 'bool' }] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH

type TestStorage = Required<
  Pick<OpenPostReactionProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenPostReactionProjectionRunOptions, 'keyRange'>

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

async function prepareProjection(
  likes: readonly IndexedEventLog[],
  reposts: readonly IndexedEventLog[],
) {
  const storageOptions = storage()
  const likePosition = await populateStream(
    storageOptions,
    POST_LIKE_SET_FILTER,
    likes,
  )
  const repostPosition = await populateStream(
    storageOptions,
    PUBLISHED_REPOST_FILTER,
    reposts,
  )
  return {
    anchor: {
      chainId: 1n,
      head: HEAD,
      likes: likePosition,
      reposts: repostPosition,
      safeHead: SAFE_HEAD,
    } satisfies PostReactionProjectionAnchor,
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
    })
    expect(() => run.getSummary(7n)).toThrow(/not complete/i)
    expect(() => run.baselines).toThrow(/not complete/i)

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
    expect(run.snapshot.likes.logsProcessed).toBe(1n)
    expect(run.baselines.likes.cursor.checkpoints[0]!.blockNumber).toBe(
      SAFE_HEAD,
    )
    expect(run.baselines.likes.last).toEqual({
      blockNumber: 1n,
      logIndex: 0,
    })

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
