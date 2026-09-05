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
import type { IndexedEventLog } from './event-indexer'
import {
  getPostCommentProjectionSnapshotDigest,
  MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE,
  MAX_POST_COMMENT_PROJECTION_PAGE_LOGS,
  MAX_POST_COMMENT_PROJECTION_POSTS,
  POST_COMMENT_PROJECTION_SNAPSHOT_VERSION,
  PostCommentProjection,
} from './post-comment-projection'
import {
  decodePublishedComment,
  type PublishedComment,
} from './protocol-events'
import {
  COMMENT_PUBLISHED_TOPIC,
  MAX_MEDIA_CID_BYTES,
  MAX_POST_BODY_BYTES,
  PROTOCOL_ADDRESS,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const COMMENT_DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function commentLog(
  commentId: bigint,
  blockNumber: bigint,
  options: {
    author?: Address
    blockHash?: Hex
    body?: string
    logIndex?: number
    mediaCid?: Hex
    postId?: bigint
    transactionHash?: Hex
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const author = options.author ?? ACCOUNT_A
  const body = options.body ?? `comment ${commentId.toString()}`
  const logIndex = options.logIndex ?? 0
  const mediaCid = options.mediaCid ?? '0x'
  const postId = options.postId ?? 7n
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: options.blockHash ?? hash(`block:${blockNumber.toString()}`),
    blockNumber,
    data: encodeAbiParameters(COMMENT_DATA_PARAMETERS, [body, mediaCid]),
    logIndex,
    topics: [
      COMMENT_PUBLISHED_TOPIC,
      padHex(toHex(commentId), { size: 32 }),
      padHex(toHex(postId), { size: 32 }),
      padHex(author, { size: 32 }),
    ],
    transactionHash:
      options.transactionHash ??
      hash(
        `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
      ),
    transactionIndex,
  }
}

function publishedComment(
  commentId: bigint,
  blockNumber: bigint,
  options: Parameters<typeof commentLog>[2] = {},
): PublishedComment {
  const comment = decodePublishedComment(
    commentLog(commentId, blockNumber, options),
  )
  if (!comment) throw new Error('Expected a comment event.')
  return comment
}

describe('post comment projection', () => {
  it('groups exact chronological comments for only the tracked posts', () => {
    const projection = new PostCommentProjection([9n, 7n])

    projection.applyLogs([
      commentLog(1n, 1n, { postId: 7n }),
      commentLog(2n, 1n, {
        author: ACCOUNT_B,
        logIndex: 1,
        postId: 8n,
        transactionIndex: 1,
      }),
    ])
    projection.applyLogs([
      commentLog(3n, 2n, { postId: 9n }),
      commentLog(4n, 2n, {
        logIndex: 1,
        postId: 7n,
        transactionIndex: 1,
      }),
    ])

    expect(projection.trackedPostIds).toEqual([7n, 9n])
    expect(
      projection.readComments(7n).comments.map(({ commentId }) => commentId),
    ).toEqual([1n, 4n])
    expect(
      projection.readComments(9n).comments.map(({ commentId }) => commentId),
    ).toEqual([3n])
    expect(projection.progress).toEqual({
      commentCount: 4n,
      confirmedThrough: undefined,
      last: {
        blockHash: hash('block:2'),
        blockNumber: 2n,
        logIndex: 1,
      },
      retainedCommentCount: 3n,
    })
  })

  it('round-trips one canonical snapshot across equivalent input order and casing', () => {
    const projection = new PostCommentProjection([9n, 7n])
    projection.applyLogs([
      commentLog(1n, 1n, { postId: 7n }),
      commentLog(2n, 1n, {
        logIndex: 1,
        postId: 8n,
        transactionIndex: 1,
      }),
    ])
    projection.applyLogs([
      commentLog(3n, 2n, { author: ACCOUNT_B, postId: 9n }),
      commentLog(4n, 2n, {
        body: 'media too',
        logIndex: 1,
        mediaCid: '0xabcd',
        postId: 7n,
        transactionIndex: 1,
      }),
    ])
    projection.confirmThrough({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })

    const snapshot = projection.snapshot
    expect(snapshot.postIds).toEqual([7n, 9n])
    expect(snapshot.commentCount).toBe(4n)
    expect(snapshot.comments.map(({ commentId }) => commentId)).toEqual([
      1n,
      3n,
      4n,
    ])
    expect(snapshot.schemaVersion).toBe(
      POST_COMMENT_PROJECTION_SNAPSHOT_VERSION,
    )
    expect(PostCommentProjection.fromSnapshot(snapshot).snapshot).toEqual(
      snapshot,
    )

    const uppercaseHex = (value: string) => `0x${value.slice(2).toUpperCase()}`
    const equivalent = {
      ...snapshot,
      comments: snapshot.comments.toReversed().map((comment) => ({
        ...comment,
        author: comment.author.toLowerCase(),
        blockHash: uppercaseHex(comment.blockHash),
        mediaCid: uppercaseHex(comment.mediaCid),
        transactionHash: uppercaseHex(comment.transactionHash),
      })),
      confirmedThrough: {
        ...snapshot.confirmedThrough!,
        blockHash: uppercaseHex(snapshot.confirmedThrough!.blockHash),
      },
      last: {
        ...snapshot.last!,
        blockHash: uppercaseHex(snapshot.last!.blockHash),
      },
      postIds: snapshot.postIds.toReversed(),
    }
    const restored = PostCommentProjection.fromSnapshot(equivalent)
    expect(restored.snapshot).toEqual(snapshot)
    expect(getPostCommentProjectionSnapshotDigest(equivalent)).toBe(
      getPostCommentProjectionSnapshotDigest(snapshot),
    )

    const view = restored.snapshot
    view.comments[0]!.body = 'mutated'
    view.last!.blockNumber = 99n
    view.confirmedThrough!.blockNumber = 99n
    expect(restored.snapshot.comments[0]!.body).toBe('comment 1')
    expect(restored.snapshot.last!.blockNumber).toBe(2n)
    expect(restored.snapshot.confirmedThrough!.blockNumber).toBe(5n)
  })

  it('continues the global identifier sequence from a restored snapshot', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([
      commentLog(1n, 1n),
      commentLog(2n, 1n, {
        logIndex: 1,
        postId: 8n,
        transactionIndex: 1,
      }),
    ])
    projection.confirmThrough({
      blockHash: hash('block:3'),
      blockNumber: 3n,
    })
    const restored = PostCommentProjection.fromSnapshot(projection.snapshot)

    expect(() => restored.applyLogs([commentLog(3n, 3n)])).toThrow(
      /page boundary/i,
    )
    restored.applyLogs([commentLog(3n, 4n)])
    expect(restored.progress).toMatchObject({
      commentCount: 3n,
      confirmedThrough: undefined,
      retainedCommentCount: 2n,
    })
    expect(() => restored.applyLogs([commentLog(5n, 5n)])).toThrow(
      /comment identifier sequence/i,
    )
    restored.applyLogs([commentLog(4n, 5n, { postId: 8n })])
    restored.confirmThrough({
      blockHash: hash('block:6'),
      blockNumber: 6n,
    })

    expect(
      restored.snapshot.comments.map(({ commentId }) => commentId),
    ).toEqual([1n, 3n])
    expect(restored.snapshot.commentCount).toBe(4n)
    expect(
      PostCommentProjection.fromSnapshot(restored.snapshot).snapshot,
    ).toEqual(restored.snapshot)
  })

  it('returns defensive post and comment copies', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([commentLog(1n, 1n)])

    const postIds = projection.trackedPostIds
    postIds[0] = 99n
    const comments = projection.readComments(7n).comments
    comments[0]!.body = 'mutated'
    const progress = projection.progress
    progress.last!.blockNumber = 99n

    expect(projection.trackedPostIds).toEqual([7n])
    expect(projection.readComments(7n).comments[0]!.body).toBe('comment 1')
    expect(projection.progress.last!.blockNumber).toBe(1n)
  })

  it('copies completed histories through strictly bounded read pages', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs(
      Array.from({ length: 205 }, (_, index) => {
        const commentId = BigInt(index + 1)
        return commentLog(commentId, commentId)
      }),
    )

    const first = projection.readComments(7n, { limit: 2 })
    expect(first).toMatchObject({
      complete: false,
      nextOffset: 2,
      totalComments: 205n,
    })
    expect(first.comments.map(({ commentId }) => commentId)).toEqual([1n, 2n])

    const middle = projection.readComments(7n, {
      limit: MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE,
      offset: first.nextOffset,
    })
    expect(middle.comments).toHaveLength(200)
    expect(middle.nextOffset).toBe(202)
    expect(middle.complete).toBe(false)

    const last = projection.readComments(7n, { offset: middle.nextOffset })
    expect(last.comments.map(({ commentId }) => commentId)).toEqual([
      203n,
      204n,
      205n,
    ])
    expect(last).toMatchObject({ complete: true, totalComments: 205n })
    expect(last.nextOffset).toBeUndefined()

    expect(() => projection.readComments(7n, { limit: 0 })).toThrow(
      /read limit/i,
    )
    expect(() =>
      projection.readComments(7n, {
        limit: MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE + 1,
      }),
    ).toThrow(/read limit/i)
    expect(() => projection.readComments(7n, { offset: 206 })).toThrow(
      /read offset/i,
    )
  })

  it('enforces the protocol-wide comment identifier sequence atomically', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([commentLog(1n, 1n)])
    const before = projection.readComments(7n).comments

    expect(() => projection.applyLogs([commentLog(3n, 2n)])).toThrow(
      /comment identifier sequence/i,
    )
    expect(projection.readComments(7n).comments).toEqual(before)
    expect(projection.progress.commentCount).toBe(1n)

    const fresh = new PostCommentProjection([7n])
    expect(() => fresh.applyLogs([commentLog(2n, 1n)])).toThrow(
      /comment identifier sequence/i,
    )
    expect(fresh.progress.commentCount).toBe(0n)
  })

  it('rejects malformed, unordered, and transaction-inconsistent pages', () => {
    const otherEvent = {
      ...commentLog(1n, 1n),
      topics: [hash('another event')],
    }
    expect(() =>
      new PostCommentProjection([7n]).applyLogs([otherEvent]),
    ).toThrow(/event family/i)

    expect(() =>
      new PostCommentProjection([7n]).applyLogs([
        commentLog(2n, 1n, { logIndex: 1, transactionIndex: 1 }),
        commentLog(1n, 1n),
      ]),
    ).toThrow(/page order/i)

    const sharedTransaction = hash('shared transaction')
    expect(() =>
      new PostCommentProjection([7n]).applyLogs([
        commentLog(1n, 1n, {
          transactionHash: sharedTransaction,
          transactionIndex: 0,
        }),
        commentLog(2n, 1n, {
          logIndex: 1,
          transactionHash: sharedTransaction,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/transaction metadata/i)
  })

  it('validates later pages against retained block and transaction history', () => {
    const reusedTransactionHash = hash('cross-page transaction')
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([
      commentLog(1n, 1n, { transactionHash: reusedTransactionHash }),
    ])
    const snapshot = projection.snapshot

    expect(() =>
      projection.applyLogs([
        commentLog(2n, 2n, {
          postId: 8n,
          transactionHash: reusedTransactionHash,
        }),
      ]),
    ).toThrow(/history transaction block/i)
    expect(projection.snapshot).toEqual(snapshot)

    expect(() =>
      projection.applyLogs([
        commentLog(2n, 2n, {
          blockHash: snapshot.comments[0]!.blockHash,
          postId: 8n,
        }),
      ]),
    ).toThrow(/history block identity/i)
    expect(projection.snapshot).toEqual(snapshot)
  })

  it('requires later pages to begin in a later complete block', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([commentLog(1n, 2n)])

    expect(() =>
      projection.applyLogs([commentLog(2n, 2n, { logIndex: 1 })]),
    ).toThrow(/page boundary/i)
    expect(() => projection.applyLogs([commentLog(2n, 1n)])).toThrow(
      /page boundary/i,
    )

    expect(() =>
      new PostCommentProjection([7n]).applyLogs([
        commentLog(1n, 1n),
        commentLog(2n, 1n, {
          blockHash: hash('conflicting block'),
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/page block hash/i)
  })

  it('binds later work to an authenticated confirmation boundary', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([commentLog(1n, 2n)])
    projection.confirmThrough({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })

    expect(projection.progress.confirmedThrough).toEqual({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })
    expect(() => projection.applyLogs([commentLog(2n, 5n)])).toThrow(
      /page boundary/i,
    )
    expect(() =>
      projection.confirmThrough({
        blockHash: hash('different block:5'),
        blockNumber: 5n,
      }),
    ).toThrow(/confirmation boundary/i)

    const ahead = new PostCommentProjection([7n])
    ahead.applyLogs([commentLog(1n, 6n)])
    expect(() =>
      ahead.confirmThrough({ blockHash: hash('block:5'), blockNumber: 5n }),
    ).toThrow(/confirmation progress/i)
  })

  it('validates tracked-post and page work bounds', () => {
    expect(() => new PostCommentProjection([])).toThrow(/tracked posts/i)
    expect(() => new PostCommentProjection([7n, 7n])).toThrow(
      /duplicate tracked post/i,
    )
    expect(
      () =>
        new PostCommentProjection(
          Array.from(
            { length: MAX_POST_COMMENT_PROJECTION_POSTS + 1 },
            (_, index) => BigInt(index + 1),
          ),
        ),
    ).toThrow(/tracked posts/i)
    expect(() => new PostCommentProjection([0n])).toThrow(/post identifier/i)

    const projection = new PostCommentProjection([7n])
    expect(() => projection.readComments(8n)).toThrow(/untracked post/i)
    expect(() =>
      projection.applyLogs(
        Array(MAX_POST_COMMENT_PROJECTION_PAGE_LOGS + 1).fill(
          commentLog(1n, 1n),
        ),
      ),
    ).toThrow(/page size/i)
  })

  it('commits every persisted semantic field to the snapshot digest', () => {
    const projection = new PostCommentProjection([7n, 9n])
    projection.applyLogs([commentLog(1n, 1n)])
    projection.applyLogs([commentLog(2n, 2n, { postId: 8n })])
    projection.confirmThrough({
      blockHash: hash('block:4'),
      blockNumber: 4n,
    })
    const snapshot = projection.snapshot
    const comment = snapshot.comments[0]!
    const variants = [
      { ...snapshot, postIds: [7n, 8n, 9n] },
      {
        ...snapshot,
        commentCount: 3n,
        last: {
          blockHash: hash('changed count tail'),
          blockNumber: 3n,
          logIndex: 0,
        },
      },
      {
        ...snapshot,
        confirmedThrough: {
          blockHash: hash('changed confirmation'),
          blockNumber: 5n,
        },
      },
      {
        ...snapshot,
        last: {
          blockHash: hash('changed tail'),
          blockNumber: 3n,
          logIndex: 1,
        },
      },
      {
        ...snapshot,
        comments: [{ ...comment, author: ACCOUNT_B }],
      },
      {
        ...snapshot,
        comments: [{ ...comment, body: 'changed body' }],
      },
      {
        ...snapshot,
        comments: [{ ...comment, mediaCid: '0xab' }],
      },
      {
        ...snapshot,
        comments: [{ ...comment, postId: 9n }],
      },
      {
        ...snapshot,
        comments: [
          {
            ...comment,
            blockHash: hash('changed comment block'),
          },
        ],
      },
      {
        ...snapshot,
        comments: [
          {
            ...comment,
            blockHash: hash('block:0'),
            blockNumber: 0n,
          },
        ],
      },
      {
        ...snapshot,
        comments: [{ ...comment, logIndex: 1 }],
      },
      {
        ...snapshot,
        comments: [{ ...comment, transactionHash: hash('changed tx') }],
      },
      {
        ...snapshot,
        comments: [{ ...comment, transactionIndex: 1 }],
      },
      {
        ...snapshot,
        comments: [
          {
            ...comment,
            blockHash: snapshot.last!.blockHash,
            blockNumber: snapshot.last!.blockNumber,
            commentId: 2n,
            logIndex: snapshot.last!.logIndex,
          },
        ],
      },
    ]
    const digest = getPostCommentProjectionSnapshotDigest(snapshot)

    for (const variant of variants) {
      expect(() => PostCommentProjection.fromSnapshot(variant)).not.toThrow()
      expect(getPostCommentProjectionSnapshotDigest(variant)).not.toBe(digest)
    }
    expect(
      new Set(variants.map(getPostCommentProjectionSnapshotDigest)).size,
    ).toBe(variants.length)
  })

  it('rejects malformed or internally inconsistent snapshots', () => {
    const first = publishedComment(1n, 1n, { postId: 7n })
    const second = publishedComment(2n, 2n, {
      author: ACCOUNT_B,
      postId: 9n,
    })
    const valid = {
      commentCount: 2n,
      comments: [first, second],
      confirmedThrough: {
        blockHash: hash('block:3'),
        blockNumber: 3n,
      },
      last: {
        blockHash: second.blockHash,
        blockNumber: second.blockNumber,
        logIndex: second.logIndex,
      },
      postIds: [7n, 9n],
      schemaVersion: POST_COMMENT_PROJECTION_SNAPSHOT_VERSION,
    }
    expect(PostCommentProjection.fromSnapshot(valid).snapshot).toEqual(valid)

    const invalid = [
      undefined,
      { ...valid, schemaVersion: 2 },
      { ...valid, postIds: [] },
      { ...valid, postIds: [7n, 7n] },
      { ...valid, postIds: [0n] },
      { ...valid, commentCount: -1n },
      { ...valid, commentCount: 1n << 256n },
      { ...valid, commentCount: 2 },
      { ...valid, comments: 'not-an-array' },
      { ...valid, comments: [...valid.comments, first] },
      { ...valid, commentCount: 0n },
      { ...valid, commentCount: 0n, comments: [], last: valid.last },
      { ...valid, last: undefined },
      {
        ...valid,
        comments: [{ ...first, postId: 8n }, second],
      },
      {
        ...valid,
        comments: [{ ...first, commentId: 3n }, second],
      },
      {
        ...valid,
        comments: [first, { ...second, commentId: first.commentId }],
      },
      {
        ...valid,
        comments: [
          first,
          {
            ...second,
            blockHash: first.blockHash,
            blockNumber: first.blockNumber,
            logIndex: first.logIndex,
          },
        ],
      },
      {
        ...valid,
        comments: [
          { ...first, commentId: second.commentId },
          { ...second, commentId: first.commentId },
        ],
      },
      {
        ...valid,
        comments: [
          {
            ...first,
            blockHash: hash('future comment block'),
            blockNumber: 4n,
          },
          second,
        ],
      },
      {
        ...valid,
        confirmedThrough: {
          blockHash: hash('later confirmation'),
          blockNumber: 5n,
        },
        last: {
          blockHash: hash('later global tail'),
          blockNumber: 4n,
          logIndex: 0,
        },
      },
      { ...valid, commentCount: 3n },
      {
        ...valid,
        last: { ...valid.last, blockHash: hash('wrong tail fork') },
      },
      {
        ...valid,
        confirmedThrough: {
          blockHash: first.blockHash,
          blockNumber: first.blockNumber,
        },
      },
      {
        ...valid,
        confirmedThrough: {
          blockHash: hash('wrong confirmed fork'),
          blockNumber: second.blockNumber,
        },
      },
      {
        ...valid,
        comments: [
          first,
          {
            ...second,
            blockHash: first.blockHash,
            blockNumber: first.blockNumber,
            logIndex: 1,
          },
        ],
      },
      {
        ...valid,
        comments: [first, { ...second, blockHash: first.blockHash }],
        last: { ...valid.last, blockHash: first.blockHash },
      },
      {
        ...valid,
        comments: [
          first,
          { ...second, transactionHash: first.transactionHash },
        ],
      },
      {
        ...valid,
        comments: [
          first,
          {
            ...second,
            blockHash: first.blockHash,
            blockNumber: first.blockNumber,
            logIndex: 1,
            transactionIndex: first.transactionIndex,
          },
        ],
        last: {
          blockHash: first.blockHash,
          blockNumber: first.blockNumber,
          logIndex: 1,
        },
      },
      { ...valid, comments: [{ ...first, body: 42 }, second] },
      {
        ...valid,
        comments: [
          { ...first, body: 'x'.repeat(MAX_POST_BODY_BYTES + 1) },
          second,
        ],
      },
      {
        ...valid,
        comments: [{ ...first, body: '', mediaCid: '0x' }, second],
      },
      {
        ...valid,
        comments: [{ ...first, mediaCid: '0xabc' }, second],
      },
      {
        ...valid,
        comments: [
          {
            ...first,
            mediaCid: `0x${'ab'.repeat(MAX_MEDIA_CID_BYTES + 1)}`,
          },
          second,
        ],
      },
      { ...valid, comments: [{ ...first, author: 'nope' }, second] },
      {
        ...valid,
        comments: [{ ...first, blockHash: '0x01' }, second],
      },
      {
        ...valid,
        comments: [{ ...first, blockNumber: -1n }, second],
      },
      { ...valid, comments: [{ ...first, commentId: 0n }, second] },
      { ...valid, comments: [{ ...first, postId: 0n }, second] },
      { ...valid, comments: [{ ...first, logIndex: -1 }, second] },
      {
        ...valid,
        comments: [{ ...first, transactionHash: '0x01' }, second],
      },
      {
        ...valid,
        comments: [
          { ...first, transactionIndex: Number.MAX_SAFE_INTEGER + 1 },
          second,
        ],
      },
      { ...valid, last: { ...valid.last, blockHash: '0x01' } },
      {
        ...valid,
        confirmedThrough: { blockHash: '0x01', blockNumber: 3n },
      },
    ]

    for (const snapshot of invalid) {
      expect(() => PostCommentProjection.fromSnapshot(snapshot)).toThrow(
        /invalid post comment projection/i,
      )
    }
    expect(() => getPostCommentProjectionSnapshotDigest(null)).toThrow(
      /invalid post comment projection snapshot/i,
    )
  })

  it('bounds persisted comment strings before UTF-8 encoding', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([commentLog(1n, 1n)])
    const snapshot = projection.snapshot
    const oversized = 'x'.repeat(MAX_POST_BODY_BYTES + 1)
    const multibyte = '🫥'.repeat(Math.floor(MAX_POST_BODY_BYTES / 4) + 1)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      expect(() =>
        PostCommentProjection.fromSnapshot({
          ...snapshot,
          comments: [{ ...snapshot.comments[0]!, body: oversized }],
        }),
      ).toThrow(/snapshot comment body/i)
      expect(encode.mock.calls.some(([value]) => value === oversized)).toBe(
        false,
      )

      encode.mockClear()
      expect(() =>
        PostCommentProjection.fromSnapshot({
          ...snapshot,
          comments: [{ ...snapshot.comments[0]!, body: multibyte }],
        }),
      ).toThrow(/snapshot comment body/i)
      expect(encode.mock.calls.some(([value]) => value === multibyte)).toBe(
        true,
      )
    } finally {
      encode.mockRestore()
    }
  })

  it('clears partial derived state without changing the tracked scope', () => {
    const projection = new PostCommentProjection([7n])
    projection.applyLogs([commentLog(1n, 1n)])
    projection.confirmThrough({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })

    projection.reset()

    expect(projection.trackedPostIds).toEqual([7n])
    expect(projection.readComments(7n).comments).toEqual([])
    expect(projection.progress).toEqual({
      commentCount: 0n,
      confirmedThrough: undefined,
      last: undefined,
      retainedCommentCount: 0n,
    })
  })
})
