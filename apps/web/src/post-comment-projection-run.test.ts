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
import {
  createEventCursor,
  type EventCursor,
  type EventSyncResult,
  type IndexedEventLog,
} from './event-indexer'
import {
  openPostCommentProjectionRun,
  type OpenPostCommentProjectionRunOptions,
} from './post-comment-projection-run'
import {
  POST_COMMENT_EVENT_START_BLOCK,
  type PostCommentProjectionAnchor,
} from './post-comment-stream'
import { PUBLISHED_COMMENT_FILTER } from './protocol-events'
import { COMMENT_PUBLISHED_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const COMMENT_DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH

type TestStorage = Required<
  Pick<OpenPostCommentProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenPostCommentProjectionRunOptions, 'keyRange'>

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function blockHash(blockNumber: bigint) {
  return hash(`block:${blockNumber.toString()}`)
}

function commentLog(
  commentId: bigint,
  blockNumber: bigint,
  options: {
    author?: Address
    body?: string
    data?: Hex
    logIndex?: number
    postId?: bigint
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const author = options.author ?? ACCOUNT_A
  const body = options.body ?? `comment ${commentId.toString()}`
  const logIndex = options.logIndex ?? 0
  const postId = options.postId ?? 7n
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: blockHash(blockNumber),
    blockNumber,
    data:
      options.data ??
      encodeAbiParameters(COMMENT_DATA_PARAMETERS, [body, '0x']),
    logIndex,
    topics: [
      COMMENT_PUBLISHED_TOPIC,
      padHex(toHex(commentId), { size: 32 }),
      padHex(toHex(postId), { size: 32 }),
      padHex(author, { size: 32 }),
    ],
    transactionHash: hash(
      `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
    ),
    transactionIndex,
  }
}

function seedCursor(chainId = 1n) {
  return createEventCursor({
    chainId,
    filter: PUBLISHED_COMMENT_FILTER,
    finalityDepth: FINALITY_DEPTH,
    startBlock: POST_COMMENT_EVENT_START_BLOCK,
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
    databaseName: `post-comment-projection-${crypto.randomUUID()}`,
    factory: new IDBFactory(),
    keyRange: IDBKeyRange,
  }
}

async function populateComments(
  storageOptions: TestStorage,
  logs: readonly IndexedEventLog[],
) {
  const seed = seedCursor()
  const cache = await openEventCache({
    ...storageOptions,
    filter: PUBLISHED_COMMENT_FILTER,
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
  const comments = await populateComments(storageOptions, logs)
  return {
    anchor: {
      chainId: 1n,
      comments,
      head: HEAD,
      safeHead: SAFE_HEAD,
    } satisfies PostCommentProjectionAnchor,
    storage: storageOptions,
  }
}

describe('post comment projection run', () => {
  it('publishes selected exact histories only after bounded local work', async () => {
    const prepared = await prepareProjection([
      commentLog(1n, 1n, { postId: 7n }),
      commentLog(2n, 2n, { author: ACCOUNT_B, postId: 8n }),
      commentLog(3n, 3n, { postId: 7n }),
    ])
    const run = await openPostCommentProjectionRun(prepared.anchor, [8n, 7n], {
      ...prepared.storage,
      pageSize: 1,
    })

    expect(run.snapshot).toEqual({
      chainId: 1n,
      commentsRetained: 0n,
      head: HEAD,
      logsProcessed: 0n,
      pagesScanned: 0n,
      phase: 'comments',
      safeHead: SAFE_HEAD,
    })
    expect(run.trackedPostIds).toEqual([7n, 8n])
    expect(() => run.getComments(7n)).toThrow(/not complete/i)
    expect(() => run.progress).toThrow(/not complete/i)
    expect(() => run.baseline).toThrow(/not complete/i)

    await run.advance()
    expect(run.snapshot).toMatchObject({
      commentsRetained: 1n,
      logsProcessed: 1n,
      pagesScanned: 1n,
      phase: 'comments',
    })
    await run.advance()
    await run.advance()
    expect(run.snapshot).toMatchObject({
      commentsRetained: 3n,
      logsProcessed: 3n,
      pagesScanned: 3n,
      phase: 'authenticate',
    })
    expect(() => run.getComments(7n)).toThrow(/not complete/i)

    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.getComments(7n).map(({ commentId }) => commentId)).toEqual([
      1n,
      3n,
    ])
    expect(run.getComments(8n)[0]).toMatchObject({
      author: getAddress(ACCOUNT_B),
      commentId: 2n,
      postId: 8n,
    })
    expect(run.progress).toEqual({
      commentCount: 3n,
      confirmedThrough: {
        blockHash: blockHash(SAFE_HEAD),
        blockNumber: SAFE_HEAD,
      },
      last: {
        blockHash: blockHash(3n),
        blockNumber: 3n,
        logIndex: 0,
      },
      retainedCommentCount: 3n,
    })
    expect(run.baseline.logCount).toBe(3)
    await expect(run.advance()).resolves.toEqual(run.snapshot)
    run.close()
    expect(run.getComments(7n)).toHaveLength(2)
  })

  it('validates every global event while retaining only selected posts', async () => {
    const prepared = await prepareProjection([
      commentLog(1n, 1n, { postId: 9n }),
      commentLog(2n, 2n, { postId: 7n }),
    ])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )

    await run.advance()
    expect(run.snapshot).toMatchObject({
      commentsRetained: 1n,
      logsProcessed: 2n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.getComments(7n).map(({ commentId }) => commentId)).toEqual([2n])
    expect(run.progress.commentCount).toBe(2n)
    expect(() => run.getComments(9n)).toThrow(/untracked post/i)
  })

  it('handles an authenticated empty history without inventing comments', async () => {
    const prepared = await prepareProjection([])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )

    await run.advance()
    expect(run.snapshot).toMatchObject({
      commentsRetained: 0n,
      logsProcessed: 0n,
      pagesScanned: 1n,
      phase: 'authenticate',
    })
    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(run.getComments(7n)).toEqual([])
    expect(run.progress.confirmedThrough).toEqual({
      blockHash: blockHash(SAFE_HEAD),
      blockNumber: SAFE_HEAD,
    })
  })

  it('fails closed when the cache moved beyond the stream anchor', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const cache = await openEventCache({
      ...prepared.storage,
      filter: PUBLISHED_COMMENT_FILTER,
    })
    try {
      const seed = seedCursor()
      const current = await cache.readLatest(seed)
      await cache.apply(current, syncResult(current.cursor, []))
    } finally {
      cache.close()
    }
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )

    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getComments(7n)).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/cache anchor/i)
  })

  it('discards partial state when a continuation is invalidated', async () => {
    const prepared = await prepareProjection([
      commentLog(1n, 1n),
      commentLog(2n, 2n),
    ])
    const run = await openPostCommentProjectionRun(prepared.anchor, [7n], {
      ...prepared.storage,
      pageSize: 1,
    })
    await run.advance()
    expect(run.snapshot.commentsRetained).toBe(1n)

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PUBLISHED_COMMENT_FILTER,
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/changed during/i)
    expect(run.snapshot).toMatchObject({
      commentsRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.getComments(7n)).toThrow(/not complete/i)
  })

  it('reauthenticates the completed baseline before publication', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )
    await run.advance()
    expect(run.snapshot.phase).toBe('authenticate')

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PUBLISHED_COMMENT_FILTER,
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }

    await expect(run.advance()).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.getComments(7n)).toThrow(/not complete/i)
  })

  it('rejects malformed cached comments and identifier gaps atomically', async () => {
    const malformed = await prepareProjection([
      commentLog(1n, 1n, { data: '0x' }),
    ])
    const malformedRun = await openPostCommentProjectionRun(
      malformed.anchor,
      [7n],
      malformed.storage,
    )
    await expect(malformedRun.advance()).rejects.toThrow(/projection event/i)
    expect(malformedRun.snapshot.phase).toBe('failed')

    const gap = await prepareProjection([
      commentLog(1n, 1n),
      commentLog(3n, 2n),
    ])
    const gapRun = await openPostCommentProjectionRun(
      gap.anchor,
      [7n],
      gap.storage,
    )
    await expect(gapRun.advance()).rejects.toThrow(/identifier sequence/i)
    expect(gapRun.snapshot).toMatchObject({
      commentsRetained: 0n,
      phase: 'failed',
    })
  })

  it('rejects malformed, non-caught-up, and cross-chain anchors', async () => {
    const prepared = await prepareProjection([])
    await expect(
      openPostCommentProjectionRun(
        { ...prepared.anchor, safeHead: SAFE_HEAD - 1n },
        [7n],
        prepared.storage,
      ),
    ).rejects.toThrow(/safe head/i)
    await expect(
      openPostCommentProjectionRun(
        {
          ...prepared.anchor,
          comments: {
            ...prepared.anchor.comments,
            cursor: seedCursor(2n),
          },
        },
        [7n],
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openPostCommentProjectionRun(
        {
          ...prepared.anchor,
          comments: {
            ...prepared.anchor.comments,
            cursor: {
              ...prepared.anchor.comments.cursor,
              checkpoints: [],
              nextBlock: POST_COMMENT_EVENT_START_BLOCK,
            },
          },
        },
        [7n],
        prepared.storage,
      ),
    ).rejects.toThrow(/anchor boundary/i)
    await expect(
      openPostCommentProjectionRun(undefined as never, [7n], prepared.storage),
    ).rejects.toThrow(/projection run anchor/i)
    await expect(
      openPostCommentProjectionRun(prepared.anchor, [], prepared.storage),
    ).rejects.toThrow(/tracked posts/i)
    await expect(
      openPostCommentProjectionRun(prepared.anchor, [7n], {
        ...prepared.storage,
        pageSize: 201,
      }),
    ).rejects.toThrow(/page size/i)
  })

  it('returns defensive completed data and a reusable baseline', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )
    await run.advance()
    await run.advance()

    const comments = run.getComments(7n)
    comments[0]!.body = 'mutated'
    const baseline = run.baseline
    baseline.cursor.checkpoints[0]!.blockNumber = 99n
    baseline.last!.logIndex = 99
    expect(run.getComments(7n)[0]!.body).toBe('comment 1')
    expect(run.baseline.cursor.checkpoints[0]!.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.last).toEqual({ blockNumber: 1n, logIndex: 0 })

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PUBLISHED_COMMENT_FILTER,
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
      commentLog(1n, 1n),
      commentLog(2n, 2n),
    ])
    const run = await openPostCommentProjectionRun(prepared.anchor, [7n], {
      ...prepared.storage,
      pageSize: 1,
    })

    const advancing = run.advance()
    await expect(run.advance()).rejects.toThrow(/already advancing/i)
    await expect(advancing).resolves.toMatchObject({ phase: 'comments' })
    run.close()

    expect(run.snapshot).toMatchObject({
      commentsRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.getComments(7n)).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/run is closed/i)
  })
})
