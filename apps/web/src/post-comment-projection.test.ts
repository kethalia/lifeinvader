import { describe, expect, it } from 'vitest'
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
  MAX_POST_COMMENT_PROJECTION_READ_PAGE_SIZE,
  MAX_POST_COMMENT_PROJECTION_PAGE_LOGS,
  MAX_POST_COMMENT_PROJECTION_POSTS,
  PostCommentProjection,
} from './post-comment-projection'
import { COMMENT_PUBLISHED_TOPIC, PROTOCOL_ADDRESS } from './protocol'

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
