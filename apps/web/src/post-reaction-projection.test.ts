import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  keccak256,
  padHex,
  stringToHex,
  toHex,
  type Address,
} from 'viem'
import type { IndexedEventLog } from './event-indexer'
import {
  MAX_POST_REACTION_PROJECTION_PAGE_LOGS,
  PostReactionProjection,
} from './post-reaction-projection'
import { POST_CONTENT_KIND_TOPIC } from './protocol-events'
import {
  LIKE_SET_TOPIC,
  PROTOCOL_ADDRESS,
  REPOST_PUBLISHED_TOPIC,
} from './protocol'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const LIKE_DATA_PARAMETERS = [{ type: 'bool' }] as const

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function baseLog(
  blockNumber: bigint,
  logIndex: number,
  transactionIndex = logIndex,
): IndexedEventLog {
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: hash(`block:${blockNumber}`),
    blockNumber,
    data: '0x',
    logIndex,
    topics: [],
    transactionHash: hash(`transaction:${blockNumber}:${transactionIndex}`),
    transactionIndex,
  }
}

function likeLog(
  blockNumber: bigint,
  options: {
    account?: Address
    liked?: boolean
    logIndex?: number
    postId?: bigint
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const account = options.account ?? ACCOUNT_A
  const liked = options.liked ?? true
  const logIndex = options.logIndex ?? 0
  const postId = options.postId ?? 7n
  return {
    ...baseLog(blockNumber, logIndex, options.transactionIndex ?? logIndex),
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
  options: {
    account?: Address
    logIndex?: number
    postId?: bigint
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const account = options.account ?? ACCOUNT_A
  const logIndex = options.logIndex ?? 0
  const postId = options.postId ?? 7n
  return {
    ...baseLog(blockNumber, logIndex, options.transactionIndex ?? logIndex),
    topics: [
      REPOST_PUBLISHED_TOPIC,
      padHex(toHex(postId), { size: 32 }),
      padHex(account, { size: 32 }),
    ],
  }
}

describe('post reaction projection', () => {
  it('reduces latest like state into exact per-post counts', () => {
    const projection = new PostReactionProjection()
    projection.applyLikeLogs([
      likeLog(1n),
      likeLog(2n),
      likeLog(3n, { account: ACCOUNT_B }),
      likeLog(4n, { liked: false }),
    ])

    expect(projection.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 1n,
      likedByAccount: false,
      repostCount: 0n,
    })
    expect(projection.getSummary(7n, ACCOUNT_B)).toEqual({
      likeCount: 1n,
      likedByAccount: true,
      repostCount: 0n,
    })

    projection.applyLikeLogs([likeLog(5n)])
    expect(projection.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 2n,
      likedByAccount: true,
      repostCount: 0n,
    })
  })

  it('counts every repost while isolating post identifiers', () => {
    const projection = new PostReactionProjection()
    projection.applyRepostLogs([
      repostLog(1n),
      repostLog(2n),
      repostLog(3n, { account: ACCOUNT_B }),
      repostLog(4n, { postId: 8n }),
    ])

    expect(projection.getSummary(7n)).toEqual({
      likeCount: 0n,
      repostCount: 3n,
    })
    expect(projection.getSummary(8n)).toEqual({
      likeCount: 0n,
      repostCount: 1n,
    })
  })

  it('applies a page atomically when a later record is corrupt', () => {
    const projection = new PostReactionProjection()
    projection.applyLikeLogs([likeLog(1n)])
    const progress = projection.progress
    const conflict = {
      ...likeLog(2n, { account: ACCOUNT_B, logIndex: 1 }),
      blockHash: hash('conflicting block'),
    }

    expect(() =>
      projection.applyLikeLogs([likeLog(2n, { liked: false }), conflict]),
    ).toThrow(/block hash/i)
    expect(projection.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 1n,
      likedByAccount: true,
      repostCount: 0n,
    })
    expect(projection.progress).toEqual(progress)
  })

  it('requires strict order and complete-block page boundaries', () => {
    const projection = new PostReactionProjection()
    expect(() => projection.applyLikeLogs([likeLog(2n), likeLog(1n)])).toThrow(
      /order/i,
    )

    projection.applyLikeLogs([
      likeLog(2n),
      likeLog(2n, { account: ACCOUNT_B, logIndex: 1 }),
    ])
    expect(() =>
      projection.applyLikeLogs([likeLog(2n, { liked: false, logIndex: 2 })]),
    ).toThrow(/page boundary/i)
    expect(() => projection.applyLikeLogs([likeLog(1n)])).toThrow(
      /page boundary/i,
    )
  })

  it('rejects inconsistent transaction metadata within a block', () => {
    const projection = new PostReactionProjection()
    expect(() =>
      projection.applyRepostLogs([
        repostLog(1n, { logIndex: 0, transactionIndex: 1 }),
        repostLog(1n, {
          account: ACCOUNT_B,
          logIndex: 1,
          transactionIndex: 0,
        }),
      ]),
    ).toThrow(/transaction metadata/i)
  })

  it('rejects another event family and oversized pages', () => {
    const projection = new PostReactionProjection()
    expect(() => projection.applyLikeLogs([repostLog(1n)])).toThrow(
      /like event family/i,
    )
    expect(() => projection.applyRepostLogs([likeLog(1n)])).toThrow(
      /repost event family/i,
    )
    expect(() =>
      projection.applyLikeLogs(
        Array.from({ length: MAX_POST_REACTION_PROJECTION_PAGE_LOGS + 1 }, () =>
          likeLog(1n),
        ),
      ),
    ).toThrow(/page size/i)
  })

  it('returns defensive progress and resets all derived state', () => {
    const projection = new PostReactionProjection()
    projection.applyLikeLogs([likeLog(1n)])
    projection.applyRepostLogs([repostLog(2n)])
    const progress = projection.progress
    progress.likes!.blockNumber = 99n
    progress.reposts!.logIndex = 99

    expect(projection.progress).toEqual({
      likes: {
        blockHash: hash('block:1'),
        blockNumber: 1n,
        logIndex: 0,
      },
      reposts: {
        blockHash: hash('block:2'),
        blockNumber: 2n,
        logIndex: 0,
      },
    })

    projection.reset()
    expect(projection.progress).toEqual({
      likes: undefined,
      reposts: undefined,
    })
    expect(projection.getSummary(7n, ACCOUNT_A)).toEqual({
      likeCount: 0n,
      likedByAccount: false,
      repostCount: 0n,
    })
  })

  it('rejects invalid queries and leaves empty pages as no-ops', () => {
    const projection = new PostReactionProjection()
    projection.applyLikeLogs([])
    projection.applyRepostLogs([])
    expect(projection.progress).toEqual({
      likes: undefined,
      reposts: undefined,
    })
    expect(() => projection.getSummary(0n)).toThrow(/post identifier/i)
    expect(() => projection.getSummary(1n << 256n)).toThrow(/post identifier/i)
    expect(() => projection.getSummary(1n, 'not-an-address')).toThrow(
      /account/i,
    )
  })
})
