import { describe, expect, it, vi } from 'vitest'
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
import type { IndexedEventLog } from './event-indexer'
import {
  FollowProjection,
  MAX_FOLLOW_PROJECTION_PAGE_LOGS,
  MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE,
  type FollowDirection,
} from './follow-projection'
import { FOLLOW_SET_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const SELECTED = getAddress('0x000000000000000000000000000000000000fafa')
const OTHER_SELECTED = getAddress('0x000000000000000000000000000000000000fbfb')
const ACCOUNT_A = getAddress('0x000000000000000000000000000000000000aaaa')
const ACCOUNT_B = getAddress('0x000000000000000000000000000000000000bbbb')
const ACCOUNT_C = getAddress('0x000000000000000000000000000000000000cccc')
const FOLLOW_DATA_PARAMETERS = [{ type: 'bool' }] as const

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function account(value: number) {
  return getAddress(`0x${value.toString(16).padStart(40, '0')}`)
}

function followLog(
  counterpart: Address,
  following: boolean,
  blockNumber: bigint,
  options: {
    blockHash?: Hex
    direction?: FollowDirection
    logIndex?: number
    selected?: Address
    transactionHash?: Hex
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
    blockHash: options.blockHash ?? hash(`block:${blockNumber.toString()}`),
    blockNumber,
    data: encodeAbiParameters(FOLLOW_DATA_PARAMETERS, [following]),
    logIndex,
    topics: [
      FOLLOW_SET_TOPIC,
      padHex(follower, { size: 32 }),
      padHex(followed, { size: 32 }),
    ],
    transactionHash:
      options.transactionHash ??
      hash(
        `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
      ),
    transactionIndex,
  }
}

function projectionState(projection: FollowProjection) {
  return {
    relationships: projection.readRelationships({
      limit: MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE,
    }).relationships,
    progress: projection.progress,
  }
}

describe('follow projection', () => {
  it('reduces complete outgoing history to each counterpart latest signal', () => {
    const projection = new FollowProjection(SELECTED, 'following')

    projection.applyLogs([
      followLog(ACCOUNT_A, true, 1n),
      followLog(ACCOUNT_B, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])
    projection.applyLogs([
      followLog(ACCOUNT_A, false, 2n),
      followLog(ACCOUNT_C, false, 2n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])
    projection.applyLogs([
      followLog(ACCOUNT_A, true, 3n),
      followLog(ACCOUNT_B, false, 3n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])

    expect(projection.account).toBe(SELECTED)
    expect(projection.direction).toBe('following')
    expect(projection.hasRelationship(ACCOUNT_A)).toBe(true)
    expect(projection.hasRelationship(ACCOUNT_B)).toBe(false)
    expect(projection.hasRelationship(ACCOUNT_C)).toBe(false)
    expect(projection.getRelationship(ACCOUNT_A)).toMatchObject({
      blockNumber: 3n,
      followed: ACCOUNT_A,
      follower: SELECTED,
      following: true,
    })
    expect(projection.getRelationship(ACCOUNT_B)).toBeUndefined()
    expect(projection.progress).toEqual({
      relationshipCount: 1n,
      signalCount: 6n,
      last: {
        blockHash: hash('block:3'),
        blockNumber: 3n,
        logIndex: 1,
      },
    })
  })

  it('projects incoming relationships by follower counterpart', () => {
    const projection = new FollowProjection(SELECTED, 'followers')
    projection.applyLogs([
      followLog(ACCOUNT_A, true, 1n, { direction: 'followers' }),
      followLog(ACCOUNT_B, true, 2n, { direction: 'followers' }),
      followLog(ACCOUNT_A, false, 3n, { direction: 'followers' }),
    ])

    expect(projection.account).toBe(SELECTED)
    expect(projection.direction).toBe('followers')
    expect(projection.hasRelationship(ACCOUNT_A)).toBe(false)
    expect(projection.getRelationship(ACCOUNT_B)).toMatchObject({
      followed: SELECTED,
      follower: ACCOUNT_B,
      following: true,
    })
    expect(projection.readRelationships().relationships).toHaveLength(1)
    expect(projection.progress).toMatchObject({
      relationshipCount: 1n,
      signalCount: 3n,
    })
  })

  it('treats repeated signals as latest state instead of counters', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([
      followLog(ACCOUNT_A, false, 1n),
      followLog(ACCOUNT_A, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
      followLog(ACCOUNT_A, true, 1n, {
        logIndex: 2,
        transactionIndex: 2,
      }),
    ])

    expect(projection.progress).toMatchObject({
      relationshipCount: 1n,
      signalCount: 3n,
    })
    expect(projection.getRelationship(ACCOUNT_A)).toMatchObject({
      blockNumber: 1n,
      following: true,
      logIndex: 2,
    })

    projection.applyLogs([followLog(ACCOUNT_A, false, 2n)])
    expect(projection.progress).toMatchObject({
      relationshipCount: 0n,
      signalCount: 4n,
    })
  })

  it('returns deterministic relationships through strictly bounded read pages', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs(
      Array.from({ length: 205 }, (_, index) =>
        followLog(account(205 - index), true, BigInt(index + 1)),
      ),
    )

    const first = projection.readRelationships({ limit: 2 })
    expect(first).toMatchObject({
      complete: false,
      nextAfter: account(2),
      totalRelationships: 205n,
    })
    expect(first.relationships.map(({ followed }) => followed)).toEqual([
      account(1),
      account(2),
    ])

    const middle = projection.readRelationships({
      after: first.nextAfter,
      limit: MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE,
    })
    expect(middle.relationships).toHaveLength(200)
    expect(middle.nextAfter).toBe(account(202))
    expect(middle.complete).toBe(false)

    const last = projection.readRelationships({ after: middle.nextAfter })
    expect(
      last.relationships.map(({ followed }) => followed.toLowerCase()),
    ).toEqual([
      account(203).toLowerCase(),
      account(204).toLowerCase(),
      account(205).toLowerCase(),
    ])
    expect(last).toMatchObject({ complete: true, totalRelationships: 205n })
    expect(last.nextAfter).toBeUndefined()
  })

  it('returns defensive copies of relationships and progress', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([followLog(ACCOUNT_A, true, 1n)])
    projection.confirmThrough({
      blockHash: hash('block:3'),
      blockNumber: 3n,
    })

    const relationship = projection.getRelationship(ACCOUNT_A)!
    const pageRelationship = projection.readRelationships().relationships[0]!
    const progress = projection.progress
    relationship.blockNumber = 90n
    pageRelationship.blockNumber = 91n
    progress.last!.blockNumber = 92n
    progress.confirmedThrough!.blockNumber = 93n

    expect(projection.getRelationship(ACCOUNT_A)!.blockNumber).toBe(1n)
    expect(projection.progress.last!.blockNumber).toBe(1n)
    expect(projection.progress.confirmedThrough!.blockNumber).toBe(3n)
  })

  it('rejects events outside the selected account and direction atomically', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([followLog(ACCOUNT_A, true, 1n)])
    const before = projectionState(projection)

    expect(() =>
      projection.applyLogs([
        followLog(ACCOUNT_B, true, 2n),
        followLog(ACCOUNT_C, true, 2n, {
          logIndex: 1,
          selected: OTHER_SELECTED,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/event account/i)
    expect(projectionState(projection)).toEqual(before)

    const incoming = new FollowProjection(SELECTED, 'followers')
    incoming.applyLogs([
      followLog(ACCOUNT_A, true, 1n, { direction: 'followers' }),
    ])
    const incomingBefore = projectionState(incoming)
    expect(() =>
      incoming.applyLogs([
        followLog(ACCOUNT_B, true, 2n, { direction: 'followers' }),
        followLog(ACCOUNT_C, true, 2n, {
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/event account/i)
    expect(projectionState(incoming)).toEqual(incomingBefore)
  })

  it('rejects malformed, unordered, and transaction-inconsistent pages', () => {
    const otherEvent = {
      ...followLog(ACCOUNT_A, true, 1n),
      topics: [hash('another event')],
    }
    expect(() =>
      new FollowProjection(SELECTED, 'following').applyLogs([otherEvent]),
    ).toThrow(/event family/i)

    expect(() =>
      new FollowProjection(SELECTED, 'following').applyLogs([
        followLog(ACCOUNT_B, true, 1n, {
          logIndex: 1,
          transactionIndex: 1,
        }),
        followLog(ACCOUNT_A, true, 1n),
      ]),
    ).toThrow(/page order/i)

    expect(() =>
      new FollowProjection(SELECTED, 'following').applyLogs([
        followLog(ACCOUNT_A, true, 1n),
        followLog(ACCOUNT_B, true, 1n, {
          blockHash: hash('conflicting block'),
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/page block hash/i)

    const sharedTransaction = hash('shared transaction')
    expect(() =>
      new FollowProjection(SELECTED, 'following').applyLogs([
        followLog(ACCOUNT_A, true, 1n, {
          transactionHash: sharedTransaction,
          transactionIndex: 0,
        }),
        followLog(ACCOUNT_B, true, 1n, {
          logIndex: 1,
          transactionHash: sharedTransaction,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/transaction metadata/i)

    const invalidBoolean = {
      ...followLog(ACCOUNT_A, true, 1n),
      data: padHex(toHex(2), { size: 32 }),
    }
    expect(() =>
      new FollowProjection(SELECTED, 'following').applyLogs([invalidBoolean]),
    ).toThrow(/projection event/i)
  })

  it('rejects reused block and transaction identities across pages atomically', () => {
    const transactionHash = hash('transaction reused across blocks')
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([followLog(ACCOUNT_A, true, 1n, { transactionHash })])
    const before = projectionState(projection)

    expect(() =>
      projection.applyLogs([
        followLog(ACCOUNT_B, true, 2n, { transactionHash }),
      ]),
    ).toThrow(/history transaction block/i)
    expect(projectionState(projection)).toEqual(before)

    expect(() =>
      projection.applyLogs([
        followLog(ACCOUNT_B, true, 2n, {
          blockHash: hash('block:1'),
        }),
      ]),
    ).toThrow(/history block identity/i)
    expect(projectionState(projection)).toEqual(before)
  })

  it('applies a one-log delta over 5,000 retained relationships', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs(
      Array.from({ length: 5_000 }, (_, index) =>
        followLog(account(index + 1), true, BigInt(index + 1)),
      ),
    )

    projection.applyLogs([followLog(account(5_001), true, 5_001n)])

    const sorting = vi.spyOn(Array.prototype, 'toSorted')
    try {
      projection.confirmThrough({
        blockHash: hash('block:5,002'),
        blockNumber: 5_002n,
      })
      const firstPage = projection.readRelationships({
        limit: MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE,
      })
      const secondPage = projection.readRelationships({
        after: firstPage.nextAfter,
        limit: MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE,
      })
      expect(sorting).not.toHaveBeenCalled()
      expect(firstPage.relationships).toHaveLength(200)
      expect(firstPage.nextAfter?.toLowerCase()).toBe(
        account(200).toLowerCase(),
      )
      expect(secondPage.relationships[0]?.followed.toLowerCase()).toBe(
        account(201).toLowerCase(),
      )
    } finally {
      sorting.mockRestore()
    }

    expect(projection.progress).toMatchObject({
      confirmedThrough: {
        blockHash: hash('block:5,002'),
        blockNumber: 5_002n,
      },
      relationshipCount: 5_001n,
      signalCount: 5_001n,
    })
    expect(projection.getRelationship(account(5_001))).toMatchObject({
      blockNumber: 5_001n,
      following: true,
    })
  })

  it('requires later pages to start in a later complete block', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([followLog(ACCOUNT_A, true, 2n)])

    expect(() =>
      projection.applyLogs([
        followLog(ACCOUNT_B, true, 2n, {
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/page boundary/i)
    expect(() =>
      projection.applyLogs([followLog(ACCOUNT_B, true, 1n)]),
    ).toThrow(/page boundary/i)
    expect(projection.progress.signalCount).toBe(1n)
  })

  it('binds future pages to a monotonic confirmation boundary', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([followLog(ACCOUNT_A, true, 2n)])
    projection.confirmThrough({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })

    expect(projection.progress.confirmedThrough).toEqual({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })
    expect(() =>
      projection.applyLogs([followLog(ACCOUNT_B, true, 5n)]),
    ).toThrow(/page boundary/i)

    projection.applyLogs([followLog(ACCOUNT_B, true, 6n)])
    expect(() =>
      projection.confirmThrough({
        blockHash: hash('block:5'),
        blockNumber: 5n,
      }),
    ).toThrow(/confirmation progress/i)
    projection.confirmThrough({
      blockHash: hash('block:8'),
      blockNumber: 8n,
    })
    expect(() =>
      projection.confirmThrough({
        blockHash: hash('block:7'),
        blockNumber: 7n,
      }),
    ).toThrow(/confirmation boundary/i)
    expect(() =>
      projection.confirmThrough({
        blockHash: hash('different block:8'),
        blockNumber: 8n,
      }),
    ).toThrow(/confirmation boundary/i)
  })

  it('compares confirmation identity with an all-left history tail', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([
      followLog(ACCOUNT_A, true, 1n),
      followLog(ACCOUNT_A, false, 2n),
    ])

    expect(() =>
      projection.confirmThrough({
        blockHash: hash('block:2'),
        blockNumber: 3n,
      }),
    ).toThrow(/confirmation block identity/i)
    expect(projection.progress.confirmedThrough).toBeUndefined()
    expect(projection.readRelationships().relationships).toEqual([])

    projection.confirmThrough({
      blockHash: hash('block:3'),
      blockNumber: 3n,
    })
    expect(projection.progress.confirmedThrough?.blockNumber).toBe(3n)
  })

  it('validates scope, page, counterpart, and read work bounds', () => {
    expect(() => new FollowProjection('not-an-address', 'following')).toThrow(
      /account/i,
    )
    expect(
      () =>
        new FollowProjection(
          '0x0000000000000000000000000000000000000000',
          'following',
        ),
    ).toThrow(/account/i)
    expect(() => new FollowProjection(SELECTED, 'sideways')).toThrow(
      /direction/i,
    )

    const projection = new FollowProjection(SELECTED, 'following')
    expect(() => projection.applyLogs('logs')).toThrow(/projection page/i)
    expect(() =>
      projection.applyLogs(
        Array(MAX_FOLLOW_PROJECTION_PAGE_LOGS + 1).fill(
          followLog(ACCOUNT_A, true, 1n),
        ),
      ),
    ).toThrow(/page size/i)
    expect(() => projection.hasRelationship('not-an-address')).toThrow(
      /account/i,
    )
    expect(() =>
      projection.hasRelationship('0x0000000000000000000000000000000000000000'),
    ).toThrow(/account/i)
    expect(() => projection.readRelationships(null as never)).toThrow(
      /read options/i,
    )
    expect(() => projection.readRelationships({ limit: 0 })).toThrow(
      /read limit/i,
    )
    expect(() =>
      projection.readRelationships({
        limit: MAX_FOLLOW_PROJECTION_READ_PAGE_SIZE + 1,
      }),
    ).toThrow(/read limit/i)
    expect(() => projection.readRelationships({ after: ACCOUNT_A })).toThrow(
      /read cursor/i,
    )
  })

  it('clears derived state without changing the selected scope', () => {
    const projection = new FollowProjection(SELECTED, 'following')
    projection.applyLogs([followLog(ACCOUNT_A, true, 1n)])
    projection.confirmThrough({
      blockHash: hash('block:3'),
      blockNumber: 3n,
    })

    projection.reset()

    expect(projection.account).toBe(SELECTED)
    expect(projection.direction).toBe('following')
    expect(projection.readRelationships()).toMatchObject({
      complete: true,
      relationships: [],
      totalRelationships: 0n,
    })
    expect(projection.progress).toEqual({
      relationshipCount: 0n,
      signalCount: 0n,
    })
  })
})
