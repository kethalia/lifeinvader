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
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { GroupTransactionConsole } from './group-transaction-console'
import { parseMediaCid } from './media-cid'
import {
  createGroup,
  setGroupMembership,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
  type TransactionReceipt,
} from './protocol'
import type { WalletSession } from './wallet-session'

const ACCOUNT_A = '0x000000000000000000000000000000000000a11c'
const ACCOUNT_B = '0x000000000000000000000000000000000000b0bb'
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const SECOND_TRANSACTION_HASH = `0x${'33'.repeat(32)}` as const
const GROUP_ID = 17n
const MEDIA_CID = parseMediaCid(
  'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
)!

const CREATE_RECEIPT = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  groupId: GROUP_ID,
  hash: TRANSACTION_HASH,
} satisfies TransactionReceipt

function connectedSession(
  provider: Eip1193Provider,
  account: Address = ACCOUNT_A,
  chainId = 1n,
): WalletSession {
  return {
    account,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function guardedProvider(
  account: Address = ACCOUNT_A,
  chainId = 1n,
): Eip1193Provider {
  return {
    on: vi.fn(),
    removeListener: vi.fn(),
    request: vi.fn(async ({ method }: ProviderRequest) => {
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
      if (method === 'eth_accounts') return [account]
      throw new Error(`Unexpected provider method: ${method}`)
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function fillCreateForm({
  metadataCid = MEDIA_CID.text,
  name = 'Bagholders Anonymous',
}: {
  metadataCid?: string
  name?: string
} = {}) {
  fireEvent.change(screen.getByLabelText('Group name'), {
    target: { value: name },
  })
  fireEvent.change(screen.getByLabelText(/IPFS metadata CID/i), {
    target: { value: metadataCid },
  })
}

afterEach(cleanup)

describe('GroupTransactionConsole', () => {
  it('states the public boundary and stays wallet-inert while disconnected', () => {
    const createGroupAction = vi.fn<typeof createGroup>()
    const setMembershipAction = vi.fn<typeof setGroupMembership>()
    render(
      <GroupTransactionConsole
        createGroupAction={createGroupAction}
        session={{ status: 'disconnected' }}
        setMembershipAction={setMembershipAction}
      />,
    )

    expect(
      screen.getByRole('heading', {
        name: 'Form a circle. Expose the membership list.',
      }),
    ).toBeTruthy()
    expect(screen.getByText(/each require a wallet transaction/i)).toBeTruthy()
    expect(
      screen.getByText(/grants no access and hides no messages/i),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Create group on-chain',
      }).disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Join group on-chain',
      }).disabled,
    ).toBe(true)
    expect(createGroupAction).not.toHaveBeenCalled()
    expect(setMembershipAction).not.toHaveBeenCalled()
  })

  it('validates UTF-8 names, canonical metadata CIDs, and uint256 group IDs', () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    render(<GroupTransactionConsole session={connectedSession(provider)} />)
    const createButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Create group on-chain',
    })
    const joinButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Join group on-chain',
    })
    expect(createButton.disabled).toBe(true)
    expect(joinButton.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Group name'), {
      target: { value: '🫥'.repeat(25) },
    })
    expect(screen.getByText('100 / 96 UTF-8 bytes')).toBeTruthy()
    expect(
      screen.getByLabelText('Group name').getAttribute('aria-invalid'),
    ).toBe('true')
    fireEvent.change(screen.getByLabelText('Group name'), {
      target: { value: 'Public club' },
    })
    fireEvent.change(screen.getByLabelText(/IPFS metadata CID/i), {
      target: { value: 'not-a-cid' },
    })
    expect(screen.getByText(/invalid media CID/i)).toBeTruthy()
    expect(createButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/IPFS metadata CID/i), {
      target: { value: MEDIA_CID.text },
    })
    expect(screen.getByText(/commit canonical CIDv1 bytes/i)).toBeTruthy()
    expect(createButton.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Membership group ID'), {
      target: { value: '0' },
    })
    expect(screen.getByText(/positive decimal group ID/i)).toBeTruthy()
    expect(joinButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Membership group ID'), {
      target: { value: (1n << 256n).toString() },
    })
    expect(screen.getByText(/exceeds the EVM uint256 limit/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Membership group ID'), {
      target: { value: GROUP_ID.toString() },
    })
    expect(screen.getByText(/target public group #17/i)).toBeTruthy()
    expect(joinButton.disabled).toBe(false)
  })

  it('submits an exact group payload, locks other writes, and clears only a confirmed draft', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<Awaited<ReturnType<typeof createGroup>>>()
    const createGroupAction = vi.fn<typeof createGroup>(
      async (_provider, _account, _chainId, _payload, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        return pending.promise
      },
    )
    const onSelectGroup = vi.fn()
    render(
      <GroupTransactionConsole
        createGroupAction={createGroupAction}
        onSelectGroup={onSelectGroup}
        selectedGroupId={3n}
        session={connectedSession(provider)}
      />,
    )
    fillCreateForm()

    fireEvent.click(
      screen.getByRole('button', { name: 'Create group on-chain' }),
    )
    expect(await screen.findByTitle(TRANSACTION_HASH)).toBeTruthy()
    expect(
      screen.getByText(/waiting for an authenticated on-chain receipt/i),
    ).toBeTruthy()
    expect(createGroupAction).toHaveBeenCalledWith(
      provider,
      ACCOUNT_A,
      1n,
      {
        metadataCid: MEDIA_CID.bytes,
        name: 'Bagholders Anonymous',
      },
      expect.any(Function),
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Join group on-chain',
      }).disabled,
    ).toBe(true)

    await act(async () => pending.resolve(CREATE_RECEIPT))
    expect(await screen.findByText(/Group #17 was created/i)).toBeTruthy()
    expect(onSelectGroup).toHaveBeenCalledWith(GROUP_ID)
    expect(screen.getByLabelText<HTMLInputElement>('Group name').value).toBe('')
    expect(
      screen.getByLabelText<HTMLInputElement>(/IPFS metadata CID/i).value,
    ).toBe('')
  })

  it('makes an old-context wallet prompt dismissible and ignores its result', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<Awaited<ReturnType<typeof createGroup>>>()
    const createGroupAction = vi.fn<typeof createGroup>(
      async () => pending.promise,
    )
    const onSelectGroup = vi.fn()
    const { rerender } = render(
      <GroupTransactionConsole
        createGroupAction={createGroupAction}
        onSelectGroup={onSelectGroup}
        session={connectedSession(provider)}
      />,
    )
    fillCreateForm({ metadataCid: '', name: 'Account A group' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Create group on-chain' }),
    )
    expect(await screen.findByText(/waiting for wallet approval/i)).toBeTruthy()

    rerender(
      <GroupTransactionConsole
        createGroupAction={createGroupAction}
        onSelectGroup={onSelectGroup}
        session={connectedSession(provider, ACCOUNT_B)}
      />,
    )
    expect(screen.getByText(/belongs to another wallet context/i)).toBeTruthy()
    expect(screen.getByText(/keeps every wallet write locked/i)).toBeTruthy()
    const groupName = screen.getByLabelText('Group name')
    expect(groupName.hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Create group on-chain',
      }).disabled,
    ).toBe(true)

    expect(
      await screen.findByText(/may have broadcast the action/i),
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: /I checked my wallet/i }),
    )
    await waitFor(() => expect(groupName.hasAttribute('disabled')).toBe(false))
    fireEvent.change(screen.getByLabelText('Group name'), {
      target: { value: 'Account B draft' },
    })
    await act(async () => pending.resolve(CREATE_RECEIPT))

    expect(screen.getByLabelText<HTMLInputElement>('Group name').value).toBe(
      'Account B draft',
    )
    expect(onSelectGroup).not.toHaveBeenCalled()
    expect(screen.queryByText(/Group #17 was created/i)).toBeNull()
  })

  it('publishes explicit join and leave events for the selected group', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    let call = 0
    const setMembershipAction = vi.fn<typeof setGroupMembership>(
      async (_provider, _account, _chainId, _groupId, _joined, onSubmitted) => {
        call += 1
        const hash = call === 1 ? TRANSACTION_HASH : SECOND_TRANSACTION_HASH
        onSubmitted?.(hash)
        return {
          blockHash: BLOCK_HASH,
          blockNumber: 50n + BigInt(call),
          hash,
        }
      },
    )
    const onSelectGroup = vi.fn()
    render(
      <GroupTransactionConsole
        onSelectGroup={onSelectGroup}
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        setMembershipAction={setMembershipAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Join group on-chain' }))
    expect(
      await screen.findByText(/Public join event for group #17 was confirmed/i),
    ).toBeTruthy()
    expect(setMembershipAction).toHaveBeenLastCalledWith(
      provider,
      ACCOUNT_A,
      1n,
      GROUP_ID,
      true,
      expect.any(Function),
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Leave group on-chain' }),
    )
    expect(
      await screen.findByText(
        /Public leave event for group #17 was confirmed/i,
      ),
    ).toBeTruthy()
    expect(setMembershipAction).toHaveBeenLastCalledWith(
      provider,
      ACCOUNT_A,
      1n,
      GROUP_ID,
      false,
      expect.any(Function),
    )
    expect(onSelectGroup).toHaveBeenCalledTimes(2)
  })

  it('preserves a newer group selection when a membership receipt arrives', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<Awaited<ReturnType<typeof setGroupMembership>>>()
    const setMembershipAction = vi.fn<typeof setGroupMembership>(
      async () => pending.promise,
    )
    const onSelectGroup = vi.fn()
    const { rerender } = render(
      <GroupTransactionConsole
        onSelectGroup={onSelectGroup}
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        setMembershipAction={setMembershipAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Join group on-chain' }))
    expect(await screen.findByText(/waiting for wallet approval/i)).toBeTruthy()

    rerender(
      <GroupTransactionConsole
        onSelectGroup={onSelectGroup}
        selectedGroupId={99n}
        session={connectedSession(provider)}
        setMembershipAction={setMembershipAction}
      />,
    )
    expect(
      screen.getByLabelText<HTMLInputElement>('Membership group ID').value,
    ).toBe('99')

    await act(async () =>
      pending.resolve({
        blockHash: BLOCK_HASH,
        blockNumber: 51n,
        hash: TRANSACTION_HASH,
      }),
    )
    expect(
      await screen.findByText(/Public join event for group #17 was confirmed/i),
    ).toBeTruthy()
    expect(onSelectGroup).not.toHaveBeenCalled()
    expect(
      screen.getByLabelText<HTMLInputElement>('Membership group ID').value,
    ).toBe('99')
  })

  it('reauthenticates the exact creation event before recovering an unknown receipt', async () => {
    const provider = guardedProvider()
    const createGroupAction = vi.fn<typeof createGroup>(
      async (_provider, _account, _chainId, _payload, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Temporary receipt outage.')
      },
    )
    const waitForReceipt = vi.fn<typeof waitForTransactionReceipt>(
      async () => CREATE_RECEIPT,
    )
    const onSelectGroup = vi.fn()
    render(
      <GroupTransactionConsole
        createGroupAction={createGroupAction}
        onSelectGroup={onSelectGroup}
        session={connectedSession(provider)}
        waitForReceipt={waitForReceipt}
      />,
    )
    fillCreateForm()
    fireEvent.click(
      screen.getByRole('button', { name: 'Create group on-chain' }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Check group action receipt again',
      }),
    ).toBeTruthy()
    expect(screen.getByText('Temporary receipt outage.')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Check group action receipt again',
      }),
    )

    await waitFor(() => expect(waitForReceipt).toHaveBeenCalledTimes(1))
    expect(waitForReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      expect.objectContaining({
        assertCurrentChain: expect.any(Function),
        assertUnchanged: expect.any(Function),
        expectedGroupCreated: {
          creator: ACCOUNT_A,
          metadataCid: MEDIA_CID.bytes,
          name: 'Bagholders Anonymous',
        },
        selectedChainId: 1n,
      }),
    )
    expect(await screen.findByText(/Group #17 was created/i)).toBeTruthy()
    expect(onSelectGroup).toHaveBeenCalledWith(GROUP_ID)
    expect(provider.removeListener).toHaveBeenCalled()
  })

  it('locks ambiguous submissions until the user checks wallet activity', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const createGroupAction = vi.fn<typeof createGroup>(async () => {
      throw new TransactionSubmissionUnknownError(new Error('Disconnected.'))
    })
    render(
      <GroupTransactionConsole
        createGroupAction={createGroupAction}
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
      />,
    )
    fillCreateForm({ metadataCid: '' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Create group on-chain' }),
    )

    expect(
      await screen.findByText(
        /wallet returned no hash but may have broadcast/i,
      ),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', {
        name: 'Check group action receipt again',
      }),
    ).toBeNull()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Join group on-chain',
      }).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'I checked my wallet' }))
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Join group on-chain',
      }).disabled,
    ).toBe(false)
  })
})
