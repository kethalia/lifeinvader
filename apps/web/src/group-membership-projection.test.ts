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
  getGroupMembershipProjectionSnapshotDigest,
  GroupMembershipProjection,
  MAX_GROUP_MEMBERSHIP_PROJECTION_PAGE_LOGS,
  MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE,
} from './group-membership-projection'
import { GROUP_MEMBERSHIP_SET_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const GROUP_ID = 17n
const OTHER_GROUP_ID = 18n
const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const ACCOUNT_C = '0x000000000000000000000000000000000000cccc' as Address
const MEMBERSHIP_DATA_PARAMETERS = [{ type: 'bool' }] as const

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function account(value: number) {
  return `0x${value.toString(16).padStart(40, '0')}` as Address
}

function membershipLog(
  member: Address,
  joined: boolean,
  blockNumber: bigint,
  options: {
    blockHash?: Hex
    groupId?: bigint
    logIndex?: number
    transactionHash?: Hex
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const groupId = options.groupId ?? GROUP_ID
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: options.blockHash ?? hash(`block:${blockNumber.toString()}`),
    blockNumber,
    data: encodeAbiParameters(MEMBERSHIP_DATA_PARAMETERS, [joined]),
    logIndex,
    topics: [
      GROUP_MEMBERSHIP_SET_TOPIC,
      padHex(toHex(groupId), { size: 32 }),
      padHex(member, { size: 32 }),
    ],
    transactionHash:
      options.transactionHash ??
      hash(
        `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
      ),
    transactionIndex,
  }
}

describe('group membership projection', () => {
  it('reduces complete history to each account latest public signal', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)

    projection.applyLogs([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_B, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])
    projection.applyLogs([
      membershipLog(ACCOUNT_A, false, 2n),
      membershipLog(ACCOUNT_C, false, 2n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])
    projection.applyLogs([
      membershipLog(ACCOUNT_A, true, 3n),
      membershipLog(ACCOUNT_B, false, 3n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])

    expect(projection.groupId).toBe(GROUP_ID)
    expect(projection.isMember(ACCOUNT_A)).toBe(true)
    expect(projection.isMember(ACCOUNT_B)).toBe(false)
    expect(projection.isMember(ACCOUNT_C)).toBe(false)
    expect(projection.getMember(ACCOUNT_A)).toMatchObject({
      account: ACCOUNT_A,
      blockNumber: 3n,
      groupId: GROUP_ID,
      joined: true,
    })
    expect(projection.getMember(ACCOUNT_B)).toBeUndefined()
    expect(projection.progress).toEqual({
      memberCount: 1n,
      signalCount: 6n,
      last: {
        blockHash: hash('block:3'),
        blockNumber: 3n,
        logIndex: 1,
      },
    })
  })

  it('treats repeated signals as latest state instead of counters', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([
      membershipLog(ACCOUNT_A, false, 1n),
      membershipLog(ACCOUNT_A, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
      membershipLog(ACCOUNT_A, true, 1n, {
        logIndex: 2,
        transactionIndex: 2,
      }),
    ])

    expect(projection.progress).toMatchObject({
      memberCount: 1n,
      signalCount: 3n,
    })
    expect(projection.getMember(ACCOUNT_A)).toMatchObject({
      blockNumber: 1n,
      joined: true,
      logIndex: 2,
    })

    projection.applyLogs([membershipLog(ACCOUNT_A, false, 2n)])
    expect(projection.progress).toMatchObject({
      memberCount: 0n,
      signalCount: 4n,
    })
  })

  it('returns deterministic members through strictly bounded read pages', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs(
      Array.from({ length: 205 }, (_, index) =>
        membershipLog(account(205 - index), true, BigInt(index + 1)),
      ),
    )

    const first = projection.readMembers({ limit: 2 })
    expect(first).toMatchObject({
      complete: false,
      nextAfter: account(2),
      totalMembers: 205n,
    })
    expect(first.members.map(({ account: member }) => member)).toEqual([
      account(1),
      account(2),
    ])

    const middle = projection.readMembers({
      after: first.nextAfter,
      limit: MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE,
    })
    expect(middle.members).toHaveLength(200)
    expect(middle.nextAfter).toBe(account(202))
    expect(middle.complete).toBe(false)

    const last = projection.readMembers({ after: middle.nextAfter })
    expect(
      last.members.map(({ account: member }) => member.toLowerCase()),
    ).toEqual([
      account(203).toLowerCase(),
      account(204).toLowerCase(),
      account(205).toLowerCase(),
    ])
    expect(last).toMatchObject({ complete: true, totalMembers: 205n })
    expect(last.nextAfter).toBeUndefined()
  })

  it('returns defensive copies of members, progress, and snapshots', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([membershipLog(ACCOUNT_A, true, 1n)])
    projection.confirmThrough({
      blockHash: hash('block:3'),
      blockNumber: 3n,
    })

    const member = projection.getMember(ACCOUNT_A)!
    const pageMember = projection.readMembers().members[0]!
    const progress = projection.progress
    const snapshot = projection.snapshot
    member.blockNumber = 90n
    pageMember.blockNumber = 91n
    progress.last!.blockNumber = 92n
    progress.confirmedThrough!.blockNumber = 93n
    snapshot.members[0]!.blockNumber = 94n
    snapshot.last!.blockNumber = 95n

    expect(projection.getMember(ACCOUNT_A)!.blockNumber).toBe(1n)
    expect(projection.progress.last!.blockNumber).toBe(1n)
    expect(projection.progress.confirmedThrough!.blockNumber).toBe(3n)
  })

  it('rejects another group atomically even after valid entries in a page', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([membershipLog(ACCOUNT_A, true, 1n)])
    const before = projection.snapshot

    expect(() =>
      projection.applyLogs([
        membershipLog(ACCOUNT_B, true, 2n),
        membershipLog(ACCOUNT_C, true, 2n, {
          groupId: OTHER_GROUP_ID,
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/event group/i)
    expect(projection.snapshot).toEqual(before)
  })

  it('rejects malformed, unordered, and transaction-inconsistent pages', () => {
    const otherEvent = {
      ...membershipLog(ACCOUNT_A, true, 1n),
      topics: [hash('another event')],
    }
    expect(() =>
      new GroupMembershipProjection(GROUP_ID).applyLogs([otherEvent]),
    ).toThrow(/event family/i)

    expect(() =>
      new GroupMembershipProjection(GROUP_ID).applyLogs([
        membershipLog(ACCOUNT_B, true, 1n, {
          logIndex: 1,
          transactionIndex: 1,
        }),
        membershipLog(ACCOUNT_A, true, 1n),
      ]),
    ).toThrow(/page order/i)

    expect(() =>
      new GroupMembershipProjection(GROUP_ID).applyLogs([
        membershipLog(ACCOUNT_A, true, 1n),
        membershipLog(ACCOUNT_B, true, 1n, {
          blockHash: hash('conflicting block'),
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/page block hash/i)

    const sharedTransaction = hash('shared transaction')
    expect(() =>
      new GroupMembershipProjection(GROUP_ID).applyLogs([
        membershipLog(ACCOUNT_A, true, 1n, {
          transactionHash: sharedTransaction,
          transactionIndex: 0,
        }),
        membershipLog(ACCOUNT_B, true, 1n, {
          logIndex: 1,
          transactionHash: sharedTransaction,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/transaction metadata/i)

    const invalidBoolean = {
      ...membershipLog(ACCOUNT_A, true, 1n),
      data: padHex(toHex(2), { size: 32 }),
    }
    expect(() =>
      new GroupMembershipProjection(GROUP_ID).applyLogs([invalidBoolean]),
    ).toThrow(/projection event/i)
  })

  it('rejects reused block and transaction identities across pages atomically', () => {
    const transactionHash = hash('transaction reused across blocks')
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([
      membershipLog(ACCOUNT_A, true, 1n, { transactionHash }),
    ])
    const before = projection.snapshot

    expect(() =>
      projection.applyLogs([
        membershipLog(ACCOUNT_B, true, 2n, { transactionHash }),
      ]),
    ).toThrow(/history transaction block/i)
    expect(projection.snapshot).toEqual(before)

    expect(() =>
      projection.applyLogs([
        membershipLog(ACCOUNT_B, true, 2n, {
          blockHash: hash('block:1'),
        }),
      ]),
    ).toThrow(/history block identity/i)
    expect(projection.snapshot).toEqual(before)
  })

  it('applies a one-log delta over 5,000 retained members', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs(
      Array.from({ length: 5_000 }, (_, index) =>
        membershipLog(account(index + 1), true, BigInt(index + 1)),
      ),
    )

    projection.applyLogs([membershipLog(account(5_001), true, 5_001n)])

    const sorting = vi.spyOn(Array.prototype, 'toSorted')
    try {
      const firstPage = projection.readMembers({
        limit: MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE,
      })
      const secondPage = projection.readMembers({
        after: firstPage.nextAfter,
        limit: MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE,
      })
      expect(sorting).not.toHaveBeenCalled()
      expect(firstPage.members).toHaveLength(200)
      expect(firstPage.nextAfter?.toLowerCase()).toBe(
        account(200).toLowerCase(),
      )
      expect(secondPage.members[0]?.account.toLowerCase()).toBe(
        account(201).toLowerCase(),
      )
    } finally {
      sorting.mockRestore()
    }

    expect(projection.progress).toMatchObject({
      memberCount: 5_001n,
      signalCount: 5_001n,
    })
    expect(projection.getMember(account(5_001))).toMatchObject({
      blockNumber: 5_001n,
      joined: true,
    })
  })

  it('requires later pages to start in a later complete block', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([membershipLog(ACCOUNT_A, true, 2n)])

    expect(() =>
      projection.applyLogs([
        membershipLog(ACCOUNT_B, true, 2n, {
          logIndex: 1,
          transactionIndex: 1,
        }),
      ]),
    ).toThrow(/page boundary/i)
    expect(() =>
      projection.applyLogs([membershipLog(ACCOUNT_B, true, 1n)]),
    ).toThrow(/page boundary/i)
    expect(projection.progress.signalCount).toBe(1n)
  })

  it('binds future pages to a monotonic confirmation boundary', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([membershipLog(ACCOUNT_A, true, 2n)])
    projection.confirmThrough({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })

    expect(projection.progress.confirmedThrough).toEqual({
      blockHash: hash('block:5'),
      blockNumber: 5n,
    })
    expect(() =>
      projection.applyLogs([membershipLog(ACCOUNT_B, true, 5n)]),
    ).toThrow(/page boundary/i)

    projection.applyLogs([membershipLog(ACCOUNT_B, true, 6n)])
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

  it('round-trips canonical resumable snapshots and their digest', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([
      membershipLog(ACCOUNT_B, true, 1n),
      membershipLog(ACCOUNT_A, true, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])
    projection.confirmThrough({
      blockHash: hash('block:4'),
      blockNumber: 4n,
    })
    const snapshot = projection.snapshot
    const reversed = { ...snapshot, members: [...snapshot.members].reverse() }

    expect(GroupMembershipProjection.fromSnapshot(reversed).snapshot).toEqual(
      snapshot,
    )
    expect(getGroupMembershipProjectionSnapshotDigest(reversed)).toBe(
      getGroupMembershipProjectionSnapshotDigest(snapshot),
    )
    expect(
      getGroupMembershipProjectionSnapshotDigest({
        ...snapshot,
        signalCount: snapshot.signalCount + 1n,
      }),
    ).not.toBe(getGroupMembershipProjectionSnapshotDigest(snapshot))
  })

  it('round-trips a non-empty history whose current member set is empty', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_A, false, 1n, {
        logIndex: 1,
        transactionIndex: 1,
      }),
    ])

    const restored = GroupMembershipProjection.fromSnapshot(projection.snapshot)
    expect(restored.readMembers()).toEqual({
      complete: true,
      members: [],
      nextAfter: undefined,
      totalMembers: 0n,
    })
    expect(restored.progress).toMatchObject({
      memberCount: 0n,
      signalCount: 2n,
    })
  })

  it('rejects inconsistent or forged resumable snapshots', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([
      membershipLog(ACCOUNT_A, true, 1n),
      membershipLog(ACCOUNT_B, true, 2n),
    ])
    const snapshot = projection.snapshot

    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        schemaVersion: 2,
      }),
    ).toThrow(/schema version/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({ ...snapshot, groupId: 0n }),
    ).toThrow(/group identifier/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        signalCount: 1n,
      }),
    ).toThrow(/member count/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({ ...snapshot, last: undefined }),
    ).toThrow(/signal progress/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        members: [snapshot.members[0], snapshot.members[0]],
      }),
    ).toThrow(/duplicate member/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        members: [
          { ...snapshot.members[0], groupId: OTHER_GROUP_ID },
          snapshot.members[1],
        ],
      }),
    ).toThrow(/member group/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        members: [
          { ...snapshot.members[0], joined: false },
          snapshot.members[1],
        ],
      }),
    ).toThrow(/member state/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        members: [
          {
            ...snapshot.members[0],
            account: '0x0000000000000000000000000000000000000000',
          },
          snapshot.members[1],
        ],
      }),
    ).toThrow(/account/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        last: {
          ...snapshot.last!,
          blockNumber: 1n,
          logIndex: 0,
        },
      }),
    ).toThrow(/member boundary/i)
    expect(() =>
      GroupMembershipProjection.fromSnapshot({
        ...snapshot,
        last: {
          ...snapshot.last!,
          blockHash: snapshot.members[0]!.blockHash,
        },
        members: [
          snapshot.members[0],
          {
            ...snapshot.members[1],
            blockHash: snapshot.members[0]!.blockHash,
          },
        ],
      }),
    ).toThrow(/block identity/i)
  })

  it('validates group, page, account, and read work bounds', () => {
    expect(() => new GroupMembershipProjection(0n)).toThrow(/group identifier/i)
    expect(() => new GroupMembershipProjection(1n << 256n)).toThrow(
      /group identifier/i,
    )

    const projection = new GroupMembershipProjection(GROUP_ID)
    expect(() => projection.applyLogs('logs')).toThrow(/projection page/i)
    expect(() =>
      projection.applyLogs(
        Array(MAX_GROUP_MEMBERSHIP_PROJECTION_PAGE_LOGS + 1).fill(
          membershipLog(ACCOUNT_A, true, 1n),
        ),
      ),
    ).toThrow(/page size/i)
    expect(() => projection.isMember('not-an-address')).toThrow(/account/i)
    expect(() =>
      projection.isMember('0x0000000000000000000000000000000000000000'),
    ).toThrow(/account/i)
    expect(() => projection.readMembers(null as never)).toThrow(/read options/i)
    expect(() => projection.readMembers({ limit: 0 })).toThrow(/read limit/i)
    expect(() =>
      projection.readMembers({
        limit: MAX_GROUP_MEMBERSHIP_PROJECTION_READ_PAGE_SIZE + 1,
      }),
    ).toThrow(/read limit/i)
    expect(() => projection.readMembers({ after: ACCOUNT_A })).toThrow(
      /read cursor/i,
    )
  })

  it('clears derived state without changing the selected group', () => {
    const projection = new GroupMembershipProjection(GROUP_ID)
    projection.applyLogs([membershipLog(ACCOUNT_A, true, 1n)])
    projection.confirmThrough({
      blockHash: hash('block:3'),
      blockNumber: 3n,
    })

    projection.reset()

    expect(projection.groupId).toBe(GROUP_ID)
    expect(projection.readMembers()).toMatchObject({
      complete: true,
      members: [],
      totalMembers: 0n,
    })
    expect(projection.progress).toEqual({
      memberCount: 0n,
      signalCount: 0n,
    })
  })
})
