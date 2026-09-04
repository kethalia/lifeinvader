import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { Eip1193Provider } from './ethereum'
import { createEventCursor } from './event-indexer'
import {
  GROUP_DIRECTORY_START_BLOCK,
  type GroupDirectorySnapshot,
} from './group-directory'
import type { GroupMembershipProjectionReader } from './group-membership-read-model'
import type { GroupMembershipProjectionRunSnapshot } from './group-membership-projection-run'
import type {
  GroupMembershipProjectionAnchor,
  GroupMembershipStreamSnapshot,
} from './group-membership-stream'
import { parseMediaCid } from './media-cid'
import { POST_FEED_CONFIRMATION_DEPTH } from './post-feed-confirmation'
import {
  getGroupMembershipFilter,
  type GroupMembershipSet,
  type PublishedGroup,
} from './protocol-events'
import { PublicGroupPanel } from './public-group-panel'
import type { WalletSession } from './wallet-session'

const ACCOUNT_A = '0x000000000000000000000000000000000000aaaa' as Address
const ACCOUNT_B = '0x000000000000000000000000000000000000bbbb' as Address
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const GROUP_A = 17n
const GROUP_B = 18n
const START_BLOCK = 0n
const CID = parseMediaCid('QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C')!
const ANCHOR_CURSOR = {
  ...createEventCursor({
    chainId: 1n,
    filter: getGroupMembershipFilter(GROUP_A),
    finalityDepth: POST_FEED_CONFIRMATION_DEPTH,
    startBlock: START_BLOCK,
  }),
  checkpoints: [{ blockHash: BLOCK_HASH, blockNumber: 8n }],
  nextBlock: 9n,
}
const ANCHOR = {
  chainId: 1n,
  groupId: GROUP_A,
  head: 20n,
  memberships: {
    cursor: ANCHOR_CURSOR,
    generation: '0'.repeat(64),
    revision: 1n,
  },
  safeHead: 8n,
} satisfies GroupMembershipProjectionAnchor

function connectedSession(
  provider: Eip1193Provider,
  chainId = 1n,
): WalletSession {
  return {
    account: ACCOUNT_A,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function group(
  groupId: bigint,
  name: string,
  options: Partial<PublishedGroup> = {},
): PublishedGroup {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: groupId,
    creator: ACCOUNT_A,
    groupId,
    logIndex: 0,
    metadataCid: '0x',
    name,
    nameBytes: '0x',
    nameEncoding: 'utf8',
    transactionHash: TRANSACTION_HASH,
    transactionIndex: 0,
    ...options,
  }
}

function directory(
  caughtUp: boolean,
  groups: readonly PublishedGroup[],
): GroupDirectorySnapshot {
  return {
    cacheReset: false,
    caughtUp,
    groups,
    head: 20n,
    historyBoundaryKind: 'confirmed',
    indexedThrough: caughtUp ? 8n : 4n,
    safeHead: 8n,
    scannedRanges: 1,
    startBlock: GROUP_DIRECTORY_START_BLOCK,
  }
}

function membershipStream(
  projectionAnchor?: GroupMembershipProjectionAnchor,
): GroupMembershipStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    groupId: GROUP_A,
    head: 20n,
    historyBoundaryKind: 'genesis-fallback',
    indexedThrough: projectionAnchor ? 8n : 4n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentSignals: [],
    safeHead: 8n,
    scannedRanges: 1,
    startBlock: projectionAnchor?.memberships.cursor.startBlock ?? START_BLOCK,
  }
}

function projection(
  phase: GroupMembershipProjectionRunSnapshot['phase'],
): GroupMembershipProjectionRunSnapshot {
  const complete = phase === 'complete'
  return {
    chainId: 1n,
    groupId: GROUP_A,
    head: 20n,
    logsProcessed: complete ? 4n : 2n,
    membersRetained: complete ? 2n : 1n,
    pagesScanned: complete ? 2n : 1n,
    phase,
    safeHead: 8n,
    startBlock: START_BLOCK,
  }
}

function member(account: Address, blockNumber: bigint): GroupMembershipSet {
  return {
    account,
    blockHash: BLOCK_HASH,
    blockNumber,
    groupId: GROUP_A,
    joined: true,
    logIndex: 0,
    transactionHash: TRANSACTION_HASH,
    transactionIndex: 0,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('PublicGroupPanel', () => {
  it('does no RPC work until a connected user requests it', () => {
    const synchronizeDirectory = vi.fn()
    const synchronizeMembership = vi.fn()
    render(
      <PublicGroupPanel
        membershipOptions={{ synchronize: synchronizeMembership }}
        session={{ status: 'disconnected' }}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )

    expect(
      screen.getByRole('heading', {
        name: 'Public groups. Public membership.',
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed public groups',
      }).disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed members',
      }).disabled,
    ).toBe(true)
    expect(synchronizeDirectory).not.toHaveBeenCalled()
    expect(synchronizeMembership).not.toHaveBeenCalled()
  })

  it('loads one directory range per action and selects a listed group', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const groups = [
      group(GROUP_B, 'Diamond Hands Department', {
        metadataCid: CID.bytes,
      }),
      group(GROUP_A, 'Bagholders Anonymous'),
    ]
    const synchronizeDirectory = vi
      .fn()
      .mockResolvedValueOnce(directory(false, groups.slice(1)))
      .mockResolvedValueOnce(directory(true, groups))
    render(
      <PublicGroupPanel
        readProvider={readProvider}
        session={connectedSession(provider)}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed public groups' }),
    )
    expect(
      await screen.findByText(/More confirmed group history remains/i),
    ).toBeTruthy()
    expect(synchronizeDirectory).toHaveBeenCalledTimes(1)
    expect(synchronizeDirectory).toHaveBeenLastCalledWith(
      readProvider,
      1n,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(screen.getByText(/This list is partial/i)).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: 'Load next group range' }),
    )
    expect(
      await screen.findByText(
        /Caught up from block 0 through confirmed block 8/i,
      ),
    ).toBeTruthy()
    expect(synchronizeDirectory).toHaveBeenCalledTimes(2)
    expect(screen.getByText(CID.text)).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', {
        name: /Diamond Hands Department.*Group #18/i,
      }),
    )
    const selectedName = screen.getByText('Diamond Hands Department', {
      selector: '.selected-group-summary strong',
    })
    expect(selectedName.parentElement?.textContent).toContain('ID 18')
    expect(screen.getByLabelText<HTMLInputElement>('Group ID').value).toBe('18')
    expect(
      screen.getByLabelText<HTMLInputElement>('Membership group ID').value,
    ).toBe('18')
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed members',
      }).disabled,
    ).toBe(false)
    expect(screen.getByText('Selected public group #18.')).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed group messages',
      }).disabled,
    ).toBe(false)
  })

  it('keeps a pending directory hidden until its history boundary is confirmed', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronizeDirectory = vi.fn().mockResolvedValue({
      ...directory(false, []),
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: 9n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    render(
      <PublicGroupPanel
        session={connectedSession(provider)}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed public groups' }),
    )

    expect(
      await screen.findByRole('button', { name: 'Check group confirmations' }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /earliest possible Lifeinvader deployment block is 9.*has not reached the confirmed head 9 yet.*No group log range was requested/i,
      ),
    ).toBeTruthy()
    expect(screen.queryByText('No confirmed groups found.')).toBeNull()
    expect(document.querySelector('.group-empty-result')).toBeNull()
  })

  it('keeps a pre-finality directory pending without showing an empty result', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronizeDirectory = vi.fn().mockResolvedValue({
      ...directory(false, []),
      head: 5n,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: undefined,
      scannedRanges: 0,
      startBlock: 0n,
    })
    render(
      <PublicGroupPanel
        session={connectedSession(provider)}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed public groups' }),
    )

    expect(
      await screen.findByRole('button', { name: 'Check group confirmations' }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /history can begin at block 0.*does not have a confirmed head yet.*No group log range was requested/i,
      ),
    ).toBeTruthy()
    expect(screen.queryByText('No confirmed groups found.')).toBeNull()
    expect(document.querySelector('.group-empty-result')).toBeNull()
  })

  it('accepts a valid direct group ID and rejects malformed selections', () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    render(<PublicGroupPanel session={connectedSession(provider)} />)
    const input = screen.getByLabelText('Group ID')

    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select group' }))
    expect(screen.getByRole('alert').textContent).toMatch(/positive decimal/i)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed members',
      }).disabled,
    ).toBe(true)

    fireEvent.change(input, { target: { value: GROUP_A.toString() } })
    fireEvent.click(screen.getByRole('button', { name: 'Select group' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Group #17').parentElement?.textContent).toContain(
      'ID 17',
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Load confirmed members',
      }).disabled,
    ).toBe(false)
    expect(screen.getByText('Selected public group #17.')).toBeTruthy()
  })

  it('keeps membership hidden while its deployment boundary awaits confirmation', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronizeMembership = vi.fn().mockResolvedValue({
      ...membershipStream(),
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: 9n,
      scannedRanges: 0,
      startBlock: 9n,
    })
    render(
      <PublicGroupPanel
        membershipOptions={{ synchronize: synchronizeMembership }}
        session={connectedSession(provider)}
      />,
    )
    fireEvent.change(screen.getByLabelText('Group ID'), {
      target: { value: GROUP_A.toString() },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select group' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed members' }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Check membership confirmations',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /earliest possible Lifeinvader deployment block is 9.*has not reached the confirmed head 9 yet.*No membership log range was requested/i,
      ),
    ).toBeTruthy()
    expect(document.querySelector('.group-member-list')).toBeNull()
  })

  it('keeps pre-finality membership pending without implying an empty group', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronizeMembership = vi.fn().mockResolvedValue({
      ...membershipStream(),
      head: 5n,
      historyBoundaryKind: 'pending-confirmation',
      indexedThrough: undefined,
      safeHead: undefined,
      scannedRanges: 0,
      startBlock: 0n,
    })
    render(
      <PublicGroupPanel
        membershipOptions={{ synchronize: synchronizeMembership }}
        session={connectedSession(provider)}
      />,
    )
    fireEvent.change(screen.getByLabelText('Group ID'), {
      target: { value: GROUP_A.toString() },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select group' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed members' }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Check membership confirmations',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /membership history can begin at block 0.*does not have a confirmed head yet.*No membership log range was requested/i,
      ),
    ).toBeTruthy()
    expect(document.querySelector('.group-member-list')).toBeNull()
  })

  it('steps exact-group catch-up and local projection before listing members', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const synchronizeMembership = vi
      .fn()
      .mockResolvedValueOnce(membershipStream())
      .mockResolvedValueOnce(membershipStream(ANCHOR))
    const firstMember = member(ACCOUNT_A, 3n)
    const secondMember = member(ACCOUNT_B, 4n)
    const readMembers = vi.fn(
      (options?: { after?: Address; limit?: number }) =>
        options?.after
          ? {
              complete: true,
              members: [secondMember],
              totalMembers: 2n,
            }
          : {
              complete: false,
              members: [firstMember],
              nextAfter: ACCOUNT_A,
              totalMembers: 2n,
            },
    )
    const run = {
      advance: vi
        .fn()
        .mockResolvedValueOnce(projection('authenticate'))
        .mockResolvedValueOnce(projection('complete')),
      close: vi.fn(),
      getMember: vi.fn().mockReturnValue(firstMember),
      groupId: GROUP_A,
      isMember: vi.fn().mockReturnValue(true),
      readMembers,
      snapshot: projection('memberships'),
      startBlock: START_BLOCK,
    } satisfies GroupMembershipProjectionReader
    const openProjection = vi.fn().mockResolvedValue(run)
    render(
      <PublicGroupPanel
        membershipOptions={{
          openProjection,
          synchronize: synchronizeMembership,
        }}
        readProvider={readProvider}
        session={connectedSession(provider)}
      />,
    )
    fireEvent.change(screen.getByLabelText('Group ID'), {
      target: { value: GROUP_A.toString() },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select group' }))

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed members' }),
    )
    expect(
      await screen.findByText(/More confirmed membership history remains/i),
    ).toBeTruthy()
    expect(synchronizeMembership).toHaveBeenLastCalledWith(
      readProvider,
      1n,
      GROUP_A,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(openProjection).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: 'Load next membership range' }),
    )
    await waitFor(() => expect(openProjection).toHaveBeenCalledWith(ANCHOR))
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Process next local member page',
      }).disabled,
    ).toBe(false)
    expect(screen.queryByTitle(ACCOUNT_A)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Process next local member page',
      }),
    )
    expect(
      await screen.findByRole('button', {
        name: 'Authenticate confirmed members',
      }),
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Authenticate confirmed members' }),
    )

    expect(await screen.findByText(/Membership is authenticated/i)).toBeTruthy()
    expect(screen.getByText(/Connected account:/i).textContent).toContain(
      'current member',
    )
    expect(screen.getByTitle(ACCOUNT_A).textContent).toContain('0x0000…aaaa')
    expect(screen.getByText('Page 1 · 2 total')).toBeTruthy()
    expect(readMembers).toHaveBeenLastCalledWith({ limit: 25 })

    fireEvent.click(screen.getByRole('button', { name: 'Next members' }))
    expect((await screen.findByTitle(ACCOUNT_B)).textContent).toContain(
      '0x0000…bbbb',
    )
    expect(screen.getByText('Page 2 · 2 total')).toBeTruthy()
    expect(readMembers).toHaveBeenLastCalledWith({
      after: ACCOUNT_A,
      limit: 25,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Previous members' }))
    expect(await screen.findByTitle(ACCOUNT_A)).toBeTruthy()
  })

  it('aborts old directory work and clears selection when the read provider changes', async () => {
    const walletProvider = { request: vi.fn() } as Eip1193Provider
    const firstReadProvider = { request: vi.fn() } as Eip1193Provider
    const secondReadProvider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<GroupDirectorySnapshot>()
    const synchronizeDirectory = vi.fn().mockReturnValue(pending.promise)
    const { rerender } = render(
      <PublicGroupPanel
        readProvider={firstReadProvider}
        session={connectedSession(walletProvider)}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )
    fireEvent.change(screen.getByLabelText('Group ID'), {
      target: { value: GROUP_A.toString() },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Select group' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed public groups' }),
    )
    await waitFor(() => expect(synchronizeDirectory).toHaveBeenCalled())
    const signal = synchronizeDirectory.mock.calls[0]![2].signal as AbortSignal

    rerender(
      <PublicGroupPanel
        readProvider={secondReadProvider}
        session={connectedSession(walletProvider)}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )
    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('Selected public group #17.')).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('Group ID').value).toBe('')
    await act(async () =>
      pending.resolve(directory(true, [group(GROUP_A, 'Stale group')])),
    )

    expect(screen.queryByText('Stale group')).toBeNull()
    expect(screen.getByText(/Not loaded.*bounded RPC log range/i)).toBeTruthy()
  })

  it('surfaces directory failures for an explicit retry', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronizeDirectory = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC range refused.'))
      .mockResolvedValueOnce(directory(true, []))
    render(
      <PublicGroupPanel
        session={connectedSession(provider)}
        synchronizeDirectory={synchronizeDirectory}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Load confirmed public groups' }),
    )
    expect(await screen.findByText(/RPC range refused\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry public groups' }))

    expect(await screen.findByText('No confirmed groups found.')).toBeTruthy()
    expect(synchronizeDirectory).toHaveBeenCalledTimes(2)
  })
})
