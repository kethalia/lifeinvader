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
  openPostCommentProjectionRun,
  type OpenPostCommentProjectionRunOptions,
} from './post-comment-projection-run'
import { getPostCommentProjectionSnapshotDigest } from './post-comment-projection'
import {
  POST_COMMENT_EVENT_START_BLOCK,
  synchronizePostCommentStream,
} from './post-comment-stream'
import { PUBLISHED_COMMENT_FILTER } from './protocol-events'
import {
  COMMENT_PUBLISHED_TOPIC,
  LIFEINVADER_INIT_CODE,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const COMMENT_DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const FINALITY_DEPTH = 12n
const HEAD = 17n
const SAFE_HEAD = HEAD - FINALITY_DEPTH
const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

type TestStorage = Required<
  Pick<OpenPostCommentProjectionRunOptions, 'databaseName' | 'factory'>
> &
  Pick<OpenPostCommentProjectionRunOptions, 'keyRange'>

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

function commentLog(
  commentId: bigint,
  blockNumber: bigint,
  options: {
    author?: Address
    body?: string
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
    data: encodeAbiParameters(COMMENT_DATA_PARAMETERS, [body, '0x']),
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
        throw new Error('A caught-up comment stream must not request logs.')
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    },
  }
  return { control, provider }
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
  await populateComments(storageOptions, logs)
  const { control, provider } = anchorProvider()
  const synchronized = await synchronizePostCommentStream(provider, 1n, {
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
      startBlock: POST_COMMENT_EVENT_START_BLOCK,
    })
    expect(run.trackedPostIds).toEqual([7n, 8n])
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
    expect(() => run.progress).toThrow(/not complete/i)
    expect(() => run.projectionSnapshot).toThrow(/not complete/i)
    expect(() => run.baseline).toThrow(/not complete/i)
    expect(() => run.resumeState).toThrow(/not complete/i)

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
    expect(() => run.readComments(7n)).toThrow(/not complete/i)

    await run.advance()

    expect(run.snapshot.phase).toBe('complete')
    expect(
      run.readComments(7n).comments.map(({ commentId }) => commentId),
    ).toEqual([1n, 3n])
    expect(run.readComments(8n).comments[0]).toMatchObject({
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
    expect(run.projectionSnapshot).toMatchObject({
      commentCount: 3n,
      comments: [
        { commentId: 1n, postId: 7n },
        { commentId: 2n, postId: 8n },
        { commentId: 3n, postId: 7n },
      ],
      postIds: [7n, 8n],
    })
    expect(run.resumeState).toMatchObject({
      baseline: { logCount: 3 },
      binding: { digest: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
      projection: { commentCount: 3n, comments: expect.any(Array) },
    })
    await expect(run.advance()).resolves.toEqual(run.snapshot)
    run.close()
    expect(run.readComments(7n).comments).toHaveLength(2)
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

    expect(
      run.readComments(7n).comments.map(({ commentId }) => commentId),
    ).toEqual([2n])
    expect(run.progress.commentCount).toBe(2n)
    expect(() => run.readComments(9n)).toThrow(/untracked post/i)
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
    expect(run.readComments(7n).comments).toEqual([])
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
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
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
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
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
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
  })

  it('rejects an anchor whose confirmed block left the provider chain', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )
    await run.advance()
    prepared.control.safeHeadHash = hash('replacement safe head')

    await expect(run.advance()).rejects.toThrow(/checkpoint changed/i)
    expect(run.snapshot).toMatchObject({
      commentsRetained: 0n,
      phase: 'failed',
    })
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
  })

  it('brackets provider authentication with exact cache proofs', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
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
      filter: PUBLISHED_COMMENT_FILTER,
    })
    try {
      await cache.clear(seedCursor())
    } finally {
      cache.close()
    }
    release.resolve()

    await expect(authenticating).rejects.toThrow(/baseline snapshot changed/i)
    expect(run.snapshot.phase).toBe('failed')
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
  })

  it('cancels provider authentication when the local run closes', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
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
      commentsRetained: 0n,
      phase: 'closed',
    })
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
  })

  it('rejects cached identifier gaps atomically', async () => {
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
    expect(Object.isFrozen(prepared.anchor)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.comments)).toBe(true)
    expect(Object.isFrozen(prepared.anchor.comments.cursor)).toBe(true)
    await expect(
      openPostCommentProjectionRun(
        { ...prepared.anchor },
        [7n],
        prepared.storage,
      ),
    ).rejects.toThrow(/not issued by this page/i)
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

    const comments = run.readComments(7n).comments
    comments[0]!.body = 'mutated'
    const projectionSnapshot = run.projectionSnapshot
    projectionSnapshot.comments[0]!.body = 'mutated snapshot'
    projectionSnapshot.last!.logIndex = 99
    const baseline = run.baseline
    baseline.cursor.checkpoints[0]!.blockNumber = 99n
    baseline.last!.logIndex = 99
    const resume = run.resumeState
    resume.baseline.logCount = 99
    resume.binding.proof = hash('mutated binding')
    resume.projection.comments[0]!.body = 'mutated resume'
    expect(run.readComments(7n).comments[0]!.body).toBe('comment 1')
    expect(run.projectionSnapshot.comments[0]!.body).toBe('comment 1')
    expect(run.projectionSnapshot.last!.logIndex).toBe(0)
    expect(run.baseline.cursor.checkpoints[0]!.blockNumber).toBe(SAFE_HEAD)
    expect(run.baseline.last).toEqual({ blockNumber: 1n, logIndex: 0 })
    expect(run.resumeState.baseline.logCount).toBe(1)
    expect(run.resumeState.binding.proof).not.toBe(hash('mutated binding'))
    expect(run.resumeState.projection.comments[0]!.body).toBe('comment 1')

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

  it('authenticates a saved projection and scans only appended comments', async () => {
    const prepared = await prepareProjection([
      commentLog(1n, 1n, { postId: 7n }),
      commentLog(2n, 2n, { postId: 8n }),
      commentLog(3n, 3n, { postId: 7n }),
    ])
    const first = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )
    await first.advance()
    await first.advance()
    const resume = first.resumeState

    const cache = await openEventCache({
      ...prepared.storage,
      filter: PUBLISHED_COMMENT_FILTER,
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
        logs: [
          commentLog(4n, 6n, { postId: 8n }),
          commentLog(5n, 7n, { postId: 7n }),
        ],
        safeHead,
        scannedRanges: 1,
      })
    } finally {
      cache.close()
    }
    prepared.control.head = 19n
    const synchronized = await synchronizePostCommentStream(
      prepared.provider,
      1n,
      { storage: prepared.storage },
    )
    if (!synchronized.projectionAnchor) {
      throw new Error('The updated stream did not issue a projection anchor.')
    }

    const resumed = await openPostCommentProjectionRun(
      synchronized.projectionAnchor,
      [7n],
      { ...prepared.storage, pageSize: 1, resume },
    )
    expect(resumed.snapshot).toMatchObject({
      commentsRetained: 2n,
      logsProcessed: 0n,
      pagesScanned: 0n,
      phase: 'comments',
      safeHead: 7n,
    })
    expect(() => resumed.readComments(7n)).toThrow(/not complete/i)

    await resumed.advance()
    expect(resumed.snapshot).toMatchObject({
      commentsRetained: 2n,
      logsProcessed: 1n,
      pagesScanned: 1n,
      phase: 'comments',
    })
    await resumed.advance()
    expect(resumed.snapshot).toMatchObject({
      commentsRetained: 3n,
      logsProcessed: 2n,
      pagesScanned: 2n,
      phase: 'authenticate',
    })
    await resumed.advance()

    expect(
      resumed.readComments(7n).comments.map(({ commentId }) => commentId),
    ).toEqual([1n, 3n, 5n])
    expect(resumed.progress.commentCount).toBe(5n)
    expect(resumed.baseline.logCount).toBe(5)
    expect(resumed.projectionSnapshot.confirmedThrough).toEqual({
      blockHash: blockHash(7n),
      blockNumber: 7n,
    })
    expect(resumed.resumeState.binding.digest).not.toBe(resume.binding.digest)
  })

  it('rejects edited or mismatched saved comment projections', async () => {
    const prepared = await prepareProjection([commentLog(1n, 1n)])
    const run = await openPostCommentProjectionRun(
      prepared.anchor,
      [7n],
      prepared.storage,
    )
    await run.advance()
    await run.advance()
    const resume = run.resumeState
    const editedProjection = {
      ...resume.projection,
      comments: resume.projection.comments.map((comment) => ({
        ...comment,
        body: 'edited',
      })),
    }

    await expect(
      openPostCommentProjectionRun(prepared.anchor, [7n], {
        ...prepared.storage,
        resume: { ...resume, projection: editedProjection },
      }),
    ).rejects.toThrow(/resume projection digest/i)
    await expect(
      openPostCommentProjectionRun(prepared.anchor, [7n], {
        ...prepared.storage,
        resume: {
          ...resume,
          binding: { ...resume.binding, proof: hash('edited proof') },
        },
      }),
    ).rejects.toThrow(/derived state binding changed or is corrupt/i)
    await expect(
      openPostCommentProjectionRun(prepared.anchor, [8n], {
        ...prepared.storage,
        resume,
      }),
    ).rejects.toThrow(/resume posts/i)

    const mismatchedCount = {
      ...resume.projection,
      commentCount: 2n,
      last: {
        blockHash: blockHash(2n),
        blockNumber: 2n,
        logIndex: 0,
      },
    }
    await expect(
      openPostCommentProjectionRun(prepared.anchor, [7n], {
        ...prepared.storage,
        resume: {
          ...resume,
          binding: {
            ...resume.binding,
            digest: getPostCommentProjectionSnapshotDigest(mismatchedCount),
          },
          projection: mismatchedCount,
        },
      }),
    ).rejects.toThrow(/resume tail/i)
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
    expect(() => run.readComments(7n)).toThrow(/not complete/i)
    await expect(run.advance()).rejects.toThrow(/run is closed/i)
  })
})
