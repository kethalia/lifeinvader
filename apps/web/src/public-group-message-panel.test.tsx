import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type {
  GroupMessageStreamSnapshot,
  GroupMessageStreamSynchronizer,
} from './group-message-stream'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import { parseMediaCid } from './media-cid'
import {
  sendGroupMessage,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
} from './protocol'
import type { PublishedGroupMessage } from './protocol-events'
import { PublicGroupMessagePanel } from './public-group-message-panel'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb'
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const GROUP_ID = 17n
const OTHER_GROUP_ID = 99n
const MEDIA_CID = parseMediaCid(
  'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
)!
const RECEIPT = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  hash: TRANSACTION_HASH,
  messageId: 7n,
} satisfies Awaited<ReturnType<typeof sendGroupMessage>>

function connectedSession(
  provider: Eip1193Provider,
  account: Address = ACCOUNT,
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
  account: Address = ACCOUNT,
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

function publicGroupMessage(
  body: string,
  messageId: bigint,
  {
    groupId = GROUP_ID,
    mediaCid = '0x',
    sender = ACCOUNT,
  }: {
    groupId?: bigint
    mediaCid?: Hex
    sender?: Address
  } = {},
): PublishedGroupMessage {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: messageId + 20n,
    body,
    groupId,
    logIndex: Number(messageId),
    mediaCid,
    messageId,
    sender,
    transactionHash: TRANSACTION_HASH,
    transactionIndex: Number(messageId),
  }
}

function snapshot(
  messages: readonly PublishedGroupMessage[],
  caughtUp = true,
  groupId = GROUP_ID,
): GroupMessageStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp,
    groupId,
    head: 30n,
    historyBoundaryKind: 'genesis-fallback',
    indexedThrough: 18n,
    recentMessages: messages,
    safeHead: 18n,
    scannedRanges: 1,
    startBlock: 0n,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function fillDraft({
  body = 'The whole group can read this.',
  mediaCid,
}: {
  body?: string
  mediaCid?: string
} = {}) {
  fireEvent.change(screen.getByLabelText(/public group message/i), {
    target: { value: body },
  })
  if (mediaCid !== undefined) {
    fireEvent.change(screen.getByLabelText(/group attachment commitment/i), {
      target: { value: mediaCid },
    })
  }
  fireEvent.click(
    screen.getByLabelText(/group membership does not make this private/i),
  )
}

afterEach(cleanup)

describe('PublicGroupMessagePanel', () => {
  it('states the public boundary and remains RPC-inert without a selection', () => {
    const synchronize = vi.fn<GroupMessageStreamSynchronizer>()
    render(
      <PublicGroupMessagePanel
        session={{ status: 'disconnected' }}
        synchronize={synchronize}
      />,
    )

    expect(
      screen.getByRole('heading', { name: /broadcast to the whole group/i }),
    ).toBeTruthy()
    expect(screen.getByText(/membership is not a gate/i)).toBeTruthy()
    expect(screen.getByText(/anyone can read or send/i)).toBeTruthy()
    expect(
      screen.getByText(/select a public group above before reading/i),
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /send group message on-chain/i,
      }).disabled,
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /load confirmed group messages/i,
      }).disabled,
    ).toBe(true)
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('requires a selected group, bounded payload, canonical CID, and disclosure acknowledgment', () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const sendMessage = vi.fn<typeof sendGroupMessage>()
    render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    const sendButton = screen.getByRole<HTMLButtonElement>('button', {
      name: /send group message on-chain/i,
    })
    expect(sendButton.disabled).toBe(true)

    fillDraft({ body: '🫥'.repeat(1_025) })
    expect(screen.getByText(/4100 \/ 4096 UTF-8 bytes/i)).toBeTruthy()
    expect(sendButton.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/public group message/i), {
      target: { value: 'Within bounds.' },
    })
    fireEvent.change(screen.getByLabelText(/group attachment commitment/i), {
      target: { value: 'not-a-cid' },
    })
    expect(screen.getByText(/invalid media CID/i)).toBeTruthy()
    expect(sendButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/group attachment commitment/i), {
      target: { value: MEDIA_CID.text },
    })
    expect(screen.getByText(/canonical dag-pb commitment/i)).toBeTruthy()
    expect(sendButton.disabled).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('submits the exact group payload, locks writes, and clears only its confirmed draft', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<Awaited<ReturnType<typeof sendGroupMessage>>>()
    const sendMessage = vi.fn<typeof sendGroupMessage>(
      async (
        _provider,
        _account,
        _chainId,
        _groupId,
        _payload,
        onSubmitted,
      ) => {
        onSubmitted?.(TRANSACTION_HASH)
        return pending.promise
      },
    )
    render(
      <PublicGroupMessagePanel
        readProvider={readProvider}
        selectedGroupId={GROUP_ID}
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft({ mediaCid: MEDIA_CID.text })

    fireEvent.click(
      screen.getByRole('button', { name: /send group message on-chain/i }),
    )
    expect(await screen.findByTitle(TRANSACTION_HASH)).toBeTruthy()
    expect(
      screen.getByText(/waiting for an authenticated on-chain receipt/i),
    ).toBeTruthy()
    expect(sendMessage).toHaveBeenCalledWith(
      provider,
      ACCOUNT,
      1n,
      GROUP_ID,
      {
        body: 'The whole group can read this.',
        mediaCid: MEDIA_CID.bytes,
      },
      expect.any(Function),
    )
    expect(readProvider.request).not.toHaveBeenCalled()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /group message action pending/i,
      }).disabled,
    ).toBe(true)

    await act(async () => pending.resolve(RECEIPT))
    expect(
      await screen.findByText(/public group message #7 for group #17/i),
    ).toBeTruthy()
    expect(screen.getByLabelText(/public group message/i)).toHaveProperty(
      'value',
      '',
    )
    expect(
      screen.getByLabelText(/group attachment commitment/i),
    ).toHaveProperty('value', '')
    expect(
      screen.getByLabelText(/group membership does not make this private/i),
    ).toHaveProperty('checked', false)
  })

  it('locks a new group context until the old write resolves', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<Awaited<ReturnType<typeof sendGroupMessage>>>()
    const sendMessage = vi.fn<typeof sendGroupMessage>(
      async () => pending.promise,
    )
    const { rerender } = render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft({ body: 'Group seventeen draft.' })
    fireEvent.click(
      screen.getByRole('button', { name: /send group message on-chain/i }),
    )
    expect(await screen.findByText(/approve or reject/i)).toBeTruthy()

    rerender(
      <PublicGroupMessagePanel
        selectedGroupId={OTHER_GROUP_ID}
        sendMessage={sendMessage}
        session={connectedSession(provider, OTHER_ACCOUNT)}
      />,
    )
    const body = screen.getByLabelText(/public group message/i)
    expect(body.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/keeps every wallet write locked/i)).toBeTruthy()
    await act(async () => pending.resolve(RECEIPT))
    await waitFor(() => expect(body.hasAttribute('disabled')).toBe(false))
    fireEvent.change(body, {
      target: { value: 'New account and group draft.' },
    })

    expect(body).toHaveProperty('value', 'New account and group draft.')
    expect(screen.queryByText(/public group message #7/i)).toBeNull()
  })

  it('advances one exact-group range per click and withholds partial history', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const newer = publicGroupMessage('Newer group event.', 2n, {
      mediaCid: MEDIA_CID.bytes,
      sender: OTHER_ACCOUNT,
    })
    const older = publicGroupMessage('Older group event.', 1n)
    const synchronize = vi
      .fn<GroupMessageStreamSynchronizer>()
      .mockResolvedValueOnce({
        ...snapshot([newer, older], false),
        cacheReset: true,
      })
      .mockResolvedValueOnce(snapshot([newer, older]))
    render(
      <PublicGroupMessagePanel
        readProvider={readProvider}
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    expect(synchronize).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )
    expect(
      await screen.findByRole('button', {
        name: /load next group message range/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/local message cache was reset/i)).toBeTruthy()
    expect(screen.queryByText('Older group event.')).toBeNull()
    expect(synchronize).toHaveBeenCalledTimes(1)

    fireEvent.click(
      screen.getByRole('button', { name: /load next group message range/i }),
    )
    expect(
      await screen.findByRole('button', {
        name: /check for newer group messages/i,
      }),
    ).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(synchronize).toHaveBeenNthCalledWith(
      2,
      readProvider,
      1n,
      GROUP_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    const renderedMessages = screen.getAllByRole('listitem')
    expect(renderedMessages[0]?.textContent).toContain('Older group event.')
    expect(renderedMessages[1]?.textContent).toContain('Newer group event.')
    expect(screen.getByText(MEDIA_CID.text)).toBeTruthy()
    expect(screen.getAllByText(/newest retained page/i)).toHaveLength(2)
  })

  it('keeps group messages hidden while deployment confirmation is pending', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn<GroupMessageStreamSynchronizer>()
      .mockResolvedValue({
        ...snapshot([], false),
        historyBoundaryKind: 'pending-confirmation',
        indexedThrough: undefined,
        safeHead: 9n,
        scannedRanges: 0,
        startBlock: 9n,
      })
    render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Check group-message confirmations',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /earliest possible Lifeinvader deployment block is 9.*has not reached the confirmed head 9 yet.*No group-message log range was requested/i,
      ),
    ).toBeTruthy()
    expect(document.querySelector('.message-empty-result')).toBeNull()
  })

  it('keeps pre-finality group messages pending without implying an empty channel', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi
      .fn<GroupMessageStreamSynchronizer>()
      .mockResolvedValue({
        ...snapshot([], false),
        head: 5n,
        historyBoundaryKind: 'pending-confirmation',
        indexedThrough: undefined,
        safeHead: undefined,
        scannedRanges: 0,
        startBlock: 0n,
      })
    render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Check group-message confirmations',
      }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        /group-message history can begin at block 0.*does not have a confirmed head yet.*No group-message log range was requested/i,
      ),
    ).toBeTruthy()
    expect(document.querySelector('.message-empty-result')).toBeNull()
  })

  it('aborts the old group read and ignores its stale result', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<GroupMessageStreamSnapshot>()
    const synchronize = vi.fn<GroupMessageStreamSynchronizer>(
      () => pending.promise,
    )
    const { rerender } = render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const signal = synchronize.mock.calls[0]?.[3]?.signal
    expect(signal?.aborted).toBe(false)

    rerender(
      <PublicGroupMessagePanel
        selectedGroupId={OTHER_GROUP_ID}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve(snapshot([publicGroupMessage('Wrong group.', 1n)])),
    )
    expect(screen.queryByText('Wrong group.')).toBeNull()
    expect(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    ).toBeTruthy()
  })

  it('aborts and hides group-message state when the read provider changes', async () => {
    const walletProvider = { request: vi.fn() } as Eip1193Provider
    const firstReadProvider = { request: vi.fn() } as Eip1193Provider
    const secondReadProvider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<GroupMessageStreamSnapshot>()
    const synchronize = vi
      .fn<GroupMessageStreamSynchronizer>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(snapshot([]))
    const view = render(
      <PublicGroupMessagePanel
        readProvider={firstReadProvider}
        selectedGroupId={GROUP_ID}
        session={connectedSession(walletProvider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]?.[3]?.signal

    view.rerender(
      <PublicGroupMessagePanel
        readProvider={secondReadProvider}
        selectedGroupId={GROUP_ID}
        session={connectedSession(walletProvider)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    expect(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    ).toBeTruthy()
    await act(async () =>
      pending.resolve(snapshot([publicGroupMessage('Stale message.', 1n)])),
    )
    expect(screen.queryByText('Stale message.')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2))
    expect(synchronize.mock.calls[1]?.[0]).toBe(secondReadProvider)
  })

  it('rejects a synchronizer result for a different group', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi.fn<GroupMessageStreamSynchronizer>(async () =>
      snapshot([publicGroupMessage('Do not render me.', 1n)], true, 18n),
    )
    render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed group messages/i }),
    )

    expect(
      await screen.findByText(/returned a different public group/i),
    ).toBeTruthy()
    expect(screen.queryByText('Do not render me.')).toBeNull()
  })

  it('reauthenticates an unknown hash with the exact expected group event', async () => {
    const provider = guardedProvider()
    const sendMessage = vi.fn<typeof sendGroupMessage>(
      async (
        _provider,
        _account,
        _chainId,
        _groupId,
        _payload,
        onSubmitted,
      ) => {
        onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Receipt transport timed out.')
      },
    )
    const waitForReceipt = vi.fn<typeof waitForTransactionReceipt>(
      async () => RECEIPT,
    )
    render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        sendMessage={sendMessage}
        session={connectedSession(provider)}
        waitForReceipt={waitForReceipt}
      />,
    )
    fillDraft({ mediaCid: MEDIA_CID.text })
    fireEvent.click(
      screen.getByRole('button', { name: /send group message on-chain/i }),
    )
    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', {
        name: /check group message receipt again/i,
      }),
    )
    expect(
      await screen.findByText(/public group message #7 for group #17/i),
    ).toBeTruthy()
    expect(waitForReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      expect.objectContaining({
        assertCurrentChain: expect.any(Function),
        assertUnchanged: expect.any(Function),
        expectedGroupMessage: {
          body: 'The whole group can read this.',
          groupId: GROUP_ID,
          mediaCid: MEDIA_CID.bytes,
          sender: ACCOUNT,
        },
        selectedChainId: 1n,
      }),
    )
    expect(provider.removeListener).toHaveBeenCalled()
  })

  it('requires wallet-activity acknowledgment after a hashless broadcast', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const sendMessage = vi.fn<typeof sendGroupMessage>(async () => {
      throw new TransactionSubmissionUnknownError(
        new Error('Provider response timed out.'),
      )
    })
    render(
      <PublicGroupMessagePanel
        selectedGroupId={GROUP_ID}
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft()
    fireEvent.click(
      screen.getByRole('button', { name: /send group message on-chain/i }),
    )

    const acknowledge = await screen.findByRole('button', {
      name: /I checked my wallet activity/i,
    })
    expect(screen.getByText(/may have broadcast it/i)).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /group message action pending/i,
      }).disabled,
    ).toBe(true)
    fireEvent.click(acknowledge)
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: /send group message on-chain/i,
        }).disabled,
      ).toBe(false),
    )
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
