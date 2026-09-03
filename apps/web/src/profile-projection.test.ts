import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  padHex,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import type { IndexedEventLog } from './event-indexer'
import {
  getProfileProjectionSnapshotDigest,
  MAX_PROFILE_PROJECTION_ACCOUNTS,
  MAX_PROFILE_PROJECTION_PAGE_LOGS,
  PROFILE_PROJECTION_SNAPSHOT_VERSION,
  ProfileProjection,
} from './profile-projection'
import {
  POST_PUBLISHED_TOPIC,
  PROFILE_SET_TOPIC,
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

function hash(value: string) {
  return keccak256(stringToHex(value))
}

function profileLog(
  blockNumber: bigint,
  options: {
    account?: Address
    avatarCid?: Hex
    bio?: string
    blockHash?: Hex
    displayName?: string
    logIndex?: number
    transactionHash?: Hex
    transactionIndex?: number
  } = {},
): IndexedEventLog {
  const account = options.account ?? ACCOUNT_A
  const avatarCid = options.avatarCid ?? '0x01701220'
  const bio = options.bio ?? `Bio at block ${blockNumber.toString()}`
  const displayName = options.displayName ?? 'Tracey'
  const logIndex = options.logIndex ?? 0
  const transactionIndex = options.transactionIndex ?? logIndex
  return {
    address: PROTOCOL_ADDRESS,
    blockHash: options.blockHash ?? hash(`block:${blockNumber.toString()}`),
    blockNumber,
    data: encodeAbiParameters(PROFILE_DATA_PARAMETERS, [
      displayName,
      bio,
      avatarCid,
    ]),
    logIndex,
    topics: [PROFILE_SET_TOPIC, padHex(account, { size: 32 })],
    transactionHash:
      options.transactionHash ??
      hash(
        `transaction:${blockNumber.toString()}:${transactionIndex.toString()}`,
      ),
    transactionIndex,
  }
}

describe('profile projection', () => {
  it('retains only the latest snapshot for each requested account', () => {
    const projection = new ProfileProjection([ACCOUNT_A, ACCOUNT_B])
    projection.applyLogs([
      profileLog(1n, { displayName: 'First A' }),
      profileLog(2n, { account: ACCOUNT_C, displayName: 'Ignored C' }),
      profileLog(3n, { account: ACCOUNT_B, displayName: 'Only B' }),
      profileLog(4n, {
        avatarCid: '0x',
        bio: '',
        displayName: '',
      }),
    ])

    expect(projection.getProfile(ACCOUNT_A)).toMatchObject({
      account: getAddress(ACCOUNT_A),
      avatarCid: '0x',
      bio: '',
      blockNumber: 4n,
      displayName: '',
    })
    expect(projection.getProfile(ACCOUNT_B)).toMatchObject({
      account: getAddress(ACCOUNT_B),
      blockNumber: 3n,
      displayName: 'Only B',
    })
    expect(() => projection.getProfile(ACCOUNT_C)).toThrow(/untracked account/i)
    expect(projection.progress).toEqual({
      blockHash: hash('block:4'),
      blockNumber: 4n,
      logIndex: 0,
    })
  })

  it('round-trips canonical state and resumes after confirmed coverage', () => {
    const projection = new ProfileProjection([ACCOUNT_B, ACCOUNT_A])
    projection.applyLogs([
      profileLog(1n, { displayName: 'A one' }),
      profileLog(2n, { account: ACCOUNT_B, displayName: 'B one' }),
      profileLog(3n, { displayName: 'A two' }),
    ])
    const confirmedThrough = {
      blockHash: hash('block:5'),
      blockNumber: 5n,
    } as const
    projection.confirmThrough(confirmedThrough)

    const snapshot = projection.snapshot
    expect(snapshot).toEqual({
      accounts: [getAddress(ACCOUNT_A), getAddress(ACCOUNT_B)],
      confirmedThrough,
      last: {
        blockHash: hash('block:3'),
        blockNumber: 3n,
        logIndex: 0,
      },
      profiles: [
        expect.objectContaining({
          account: getAddress(ACCOUNT_A),
          blockNumber: 3n,
          displayName: 'A two',
        }),
        expect.objectContaining({
          account: getAddress(ACCOUNT_B),
          blockNumber: 2n,
          displayName: 'B one',
        }),
      ],
      schemaVersion: PROFILE_PROJECTION_SNAPSHOT_VERSION,
    })

    const restored = ProfileProjection.fromSnapshot(snapshot)
    expect(restored.snapshot).toEqual(snapshot)
    expect(() => restored.applyLogs([profileLog(5n)])).toThrow(/page boundary/i)
    restored.applyLogs([profileLog(6n, { displayName: 'A three' })])
    expect(restored.getProfile(ACCOUNT_A)).toMatchObject({
      blockNumber: 6n,
      displayName: 'A three',
    })
  })

  it('canonicalizes tracked and retained account order for snapshots', () => {
    const first = new ProfileProjection([ACCOUNT_A, ACCOUNT_B])
    first.applyLogs([
      profileLog(1n, { account: ACCOUNT_A }),
      profileLog(1n, { account: ACCOUNT_B, logIndex: 1 }),
    ])
    const second = new ProfileProjection([ACCOUNT_B, ACCOUNT_A])
    second.applyLogs([
      profileLog(1n, { account: ACCOUNT_A }),
      profileLog(1n, { account: ACCOUNT_B, logIndex: 1 }),
    ])

    expect(second.snapshot).toEqual(first.snapshot)
    expect(getProfileProjectionSnapshotDigest(second.snapshot)).toBe(
      getProfileProjectionSnapshotDigest(first.snapshot),
    )
    const reversed = {
      ...first.snapshot,
      accounts: first.snapshot.accounts.toReversed(),
      profiles: first.snapshot.profiles.toReversed(),
    }
    expect(ProfileProjection.fromSnapshot(reversed).snapshot).toEqual(
      first.snapshot,
    )
    expect(getProfileProjectionSnapshotDigest(reversed)).toBe(
      getProfileProjectionSnapshotDigest(first.snapshot),
    )
    expect(
      getProfileProjectionSnapshotDigest({
        ...first.snapshot,
        profiles: first.snapshot.profiles.map((profile, index) =>
          index === 0 ? { ...profile, bio: 'Changed' } : profile,
        ),
      }),
    ).not.toBe(getProfileProjectionSnapshotDigest(first.snapshot))
  })

  it('returns defensive views and resets all derived state', () => {
    const projection = new ProfileProjection([ACCOUNT_A])
    projection.applyLogs([profileLog(1n)])
    projection.confirmThrough({
      blockHash: hash('block:2'),
      blockNumber: 2n,
    })
    const profile = projection.getProfile(ACCOUNT_A)!
    const progress = projection.progress!
    const confirmedThrough = projection.confirmedThrough!
    const snapshot = projection.snapshot
    const trackedAccounts = projection.trackedAccounts
    profile.displayName = 'Mutated'
    progress.blockNumber = 99n
    confirmedThrough.blockNumber = 99n
    snapshot.profiles[0]!.bio = 'Mutated'
    trackedAccounts[0] = ACCOUNT_C

    expect(projection.getProfile(ACCOUNT_A)).toMatchObject({
      bio: 'Bio at block 1',
      displayName: 'Tracey',
    })
    expect(projection.progress?.blockNumber).toBe(1n)
    expect(projection.confirmedThrough?.blockNumber).toBe(2n)
    expect(projection.trackedAccounts).toEqual([getAddress(ACCOUNT_A)])

    projection.reset()
    expect(projection.getProfile(ACCOUNT_A)).toBeUndefined()
    expect(projection.progress).toBeUndefined()
    expect(projection.confirmedThrough).toBeUndefined()
  })

  it('rejects malformed or internally inconsistent snapshots', () => {
    const projection = new ProfileProjection([ACCOUNT_A, ACCOUNT_B])
    projection.applyLogs([
      profileLog(1n, { account: ACCOUNT_A }),
      profileLog(2n, { account: ACCOUNT_B }),
    ])
    const valid = projection.snapshot
    const invalid = [
      undefined,
      { ...valid, schemaVersion: 2 },
      { ...valid, accounts: 'not-an-array' },
      { ...valid, accounts: [ACCOUNT_A, ACCOUNT_A] },
      { ...valid, accounts: ['not-an-address'] },
      { ...valid, profiles: 'not-an-array' },
      { ...valid, profiles: [...valid.profiles, valid.profiles[0]!] },
      {
        ...valid,
        profiles: [
          { ...valid.profiles[0]!, account: ACCOUNT_C },
          valid.profiles[1]!,
        ],
      },
      { ...valid, last: undefined },
      {
        ...valid,
        last: { ...valid.last!, blockNumber: 1n },
      },
      {
        ...valid,
        profiles: [
          {
            ...valid.profiles[0]!,
            blockHash: hash('wrong profile fork'),
            blockNumber: valid.last!.blockNumber,
          },
        ],
      },
      {
        ...valid,
        profiles: [
          valid.profiles[0]!,
          {
            ...valid.profiles[1]!,
            blockHash: valid.profiles[0]!.blockHash,
            blockNumber: valid.profiles[0]!.blockNumber,
            logIndex: valid.profiles[0]!.logIndex,
          },
        ],
      },
      {
        ...valid,
        profiles: [
          valid.profiles[0]!,
          {
            ...valid.profiles[1]!,
            blockHash: hash('wrong shared block fork'),
            blockNumber: valid.profiles[0]!.blockNumber,
            logIndex: 1,
          },
        ],
      },
      {
        ...valid,
        profiles: [
          valid.profiles[0]!,
          {
            ...valid.profiles[1]!,
            blockHash: valid.profiles[0]!.blockHash,
            blockNumber: valid.profiles[0]!.blockNumber,
            logIndex: 1,
            transactionIndex: valid.profiles[0]!.transactionIndex,
          },
        ],
      },
      {
        ...valid,
        profiles: [
          { ...valid.profiles[0]!, avatarCid: '0x01ff0' },
          valid.profiles[1]!,
        ],
      },
      {
        ...valid,
        profiles: [
          {
            ...valid.profiles[0]!,
            displayName: '🫥'.repeat(17),
          },
          valid.profiles[1]!,
        ],
      },
      { ...valid, last: { ...valid.last!, blockHash: '0x01' } },
      {
        ...valid,
        confirmedThrough: {
          blockHash: hash('block:1'),
          blockNumber: 1n,
        },
      },
      {
        ...valid,
        confirmedThrough: {
          blockHash: hash('wrong confirmed fork'),
          blockNumber: valid.last!.blockNumber,
        },
      },
    ]

    for (const snapshot of invalid) {
      expect(() => ProfileProjection.fromSnapshot(snapshot)).toThrow(
        /invalid profile projection/i,
      )
    }
    expect(() => getProfileProjectionSnapshotDigest(null)).toThrow(
      /invalid profile projection snapshot/i,
    )
  })

  it('applies pages atomically and enforces complete-block ordering', () => {
    const projection = new ProfileProjection([ACCOUNT_A, ACCOUNT_B])
    projection.applyLogs([profileLog(1n)])
    const snapshot = projection.snapshot
    const conflict = profileLog(2n, {
      account: ACCOUNT_B,
      blockHash: hash('conflicting block'),
      logIndex: 1,
    })
    expect(() => projection.applyLogs([profileLog(2n), conflict])).toThrow(
      /block hash/i,
    )
    expect(projection.snapshot).toEqual(snapshot)

    projection.applyLogs([
      profileLog(2n),
      profileLog(2n, { account: ACCOUNT_B, logIndex: 1 }),
    ])
    expect(() =>
      projection.applyLogs([profileLog(2n, { logIndex: 2 })]),
    ).toThrow(/page boundary/i)
    expect(() => projection.applyLogs([profileLog(1n)])).toThrow(
      /page boundary/i,
    )
    expect(() =>
      new ProfileProjection([ACCOUNT_A]).applyLogs([
        profileLog(2n),
        profileLog(1n),
      ]),
    ).toThrow(/page order/i)
  })

  it('rejects corrupt logs, event families, and transaction metadata', () => {
    const projection = new ProfileProjection([ACCOUNT_A])
    expect(() => projection.applyLogs([null])).toThrow(/projection log/i)
    expect(() =>
      projection.applyLogs([
        {
          ...profileLog(1n),
          topics: [POST_PUBLISHED_TOPIC, padHex(ACCOUNT_A, { size: 32 })],
        },
      ]),
    ).toThrow(/event family/i)
    expect(() =>
      projection.applyLogs([
        profileLog(1n, { logIndex: 0, transactionIndex: 1 }),
        profileLog(1n, {
          account: ACCOUNT_B,
          logIndex: 1,
          transactionIndex: 0,
        }),
      ]),
    ).toThrow(/transaction metadata/i)
    expect(() =>
      projection.applyLogs(
        Array.from({ length: MAX_PROFILE_PROJECTION_PAGE_LOGS + 1 }, () =>
          profileLog(1n),
        ),
      ),
    ).toThrow(/page size/i)
  })

  it('bounds tracked scope and validates confirmation progress', () => {
    expect(() => new ProfileProjection([])).toThrow(/tracked accounts/i)
    expect(
      () =>
        new ProfileProjection(
          Array.from(
            { length: MAX_PROFILE_PROJECTION_ACCOUNTS + 1 },
            (_value, index) =>
              `0x${(index + 1).toString(16).padStart(40, '0')}`,
          ),
        ),
    ).toThrow(/tracked accounts/i)
    expect(() => new ProfileProjection([ACCOUNT_A, ACCOUNT_A])).toThrow(
      /duplicate tracked account/i,
    )

    const projection = new ProfileProjection([ACCOUNT_A])
    projection.applyLogs([])
    expect(projection.progress).toBeUndefined()
    projection.applyLogs([profileLog(2n)])
    expect(() =>
      projection.confirmThrough({
        blockHash: hash('block:1'),
        blockNumber: 1n,
      }),
    ).toThrow(/confirmation progress/i)
    projection.confirmThrough({
      blockHash: hash('block:2'),
      blockNumber: 2n,
    })
    expect(() =>
      projection.confirmThrough({
        blockHash: hash('another block:2'),
        blockNumber: 2n,
      }),
    ).toThrow(/confirmation boundary/i)
    expect(() => projection.getProfile('not-an-address')).toThrow(/account/i)
  })
})
