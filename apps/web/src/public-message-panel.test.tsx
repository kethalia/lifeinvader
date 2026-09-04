import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import {
  DIRECT_MESSAGE_START_BLOCK,
  type DirectMessageStreamSnapshot,
  type DirectMessageStreamSynchronizer,
} from './direct-message-stream'
import type { Eip1193Provider } from './ethereum'
import { parseMediaCid } from './media-cid'
import {
  getDirectConversationId,
  sendDirectMessage,
  TransactionSubmissionUnknownError,
  waitForTransactionReceipt,
  type TransactionReceipt,
} from './protocol'
import type { PublishedDirectMessage } from './protocol-events'
import { PublicMessagePanel } from './public-message-panel'
import type { WalletSession } from './wallet-session'
import {
  WalletWriteBoundary,
  useWalletWriteBoundary,
  type WalletWriteScope,
} from './wallet-write-boundary'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const RECIPIENT = '0x0000000000000000000000000000000000000b0b'
const OTHER_RECIPIENT = '0x0000000000000000000000000000000000000ca1'
const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'22'.repeat(32)}` as const
const MEDIA_CID = parseMediaCid(
  'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C',
)!
const RECEIPT = {
  blockHash: BLOCK_HASH,
  blockNumber: 42n,
  hash: TRANSACTION_HASH,
} satisfies TransactionReceipt

function connectedSession(
  provider: Eip1193Provider,
  chainId = 1n,
): WalletSession {
  return {
    account: ACCOUNT,
    chainId,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function publicMessage(
  body: string,
  messageId: bigint,
  {
    mediaCid = '0x',
    recipient = RECIPIENT,
    sender = ACCOUNT,
  }: {
    mediaCid?: Hex
    recipient?: Address
    sender?: Address
  } = {},
): PublishedDirectMessage {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: messageId + 20n,
    body,
    conversationId: getDirectConversationId(sender, recipient),
    logIndex: Number(messageId),
    mediaCid,
    messageId,
    recipient,
    sender,
    transactionHash: TRANSACTION_HASH,
    transactionIndex: Number(messageId),
  }
}

function snapshot(
  messages: readonly PublishedDirectMessage[],
  caughtUp = true,
  recipient: Address = RECIPIENT,
): DirectMessageStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp,
    conversationId: getDirectConversationId(ACCOUNT, recipient),
    head: 30n,
    indexedThrough: 18n,
    recentMessages: messages,
    safeHead: 18n,
    scannedRanges: 1,
    startBlock: DIRECT_MESSAGE_START_BLOCK,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function WriteBoundaryProbe({
  local = false,
  scope,
}: {
  local?: boolean
  scope: WalletWriteScope
}) {
  const lockedByAnother = useWalletWriteBoundary(scope, local)
  return (
    <output data-testid={`write-lock-${scope}`}>
      {String(lockedByAnother)}
    </output>
  )
}

function fillDraft({
  body = 'Everyone can read this.',
  mediaCid,
  recipient = RECIPIENT,
}: {
  body?: string
  mediaCid?: string
  recipient?: string
} = {}) {
  fireEvent.change(screen.getByLabelText(/recipient address/i), {
    target: { value: recipient },
  })
  fireEvent.change(screen.getByLabelText(/public message$/i), {
    target: { value: body },
  })
  if (mediaCid !== undefined) {
    fireEvent.change(screen.getByLabelText(/message attachment commitment/i), {
      target: { value: mediaCid },
    })
  }
  fireEvent.click(
    screen.getByLabelText(/I understand this is not a private message/i),
  )
}

afterEach(cleanup)

describe('PublicMessagePanel', () => {
  it('states the privacy boundary and remains RPC-inert while disconnected', () => {
    const synchronize = vi.fn<DirectMessageStreamSynchronizer>()
    render(
      <PublicMessagePanel
        session={{ status: 'disconnected' }}
        synchronize={synchronize}
      />,
    )

    expect(
      screen.getByRole('heading', { name: /public messages/i }),
    ).toBeTruthy()
    expect(screen.getByText(/“Direct” only names the recipient/i)).toBeTruthy()
    expect(screen.getByText(/anyone can read/i)).toBeTruthy()
    expect(screen.getByText(/connect a wallet to reconstruct/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /send public message on-chain/i })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('requires a nonzero recipient, bounded payload, canonical CID, and disclosure acknowledgment', () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const sendMessage = vi.fn<typeof sendDirectMessage>()
    render(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    const sendButton = screen.getByRole('button', {
      name: /send public message on-chain/i,
    })

    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: 'not-an-address' },
    })
    expect(screen.getAllByText(/valid EVM recipient/i)).toHaveLength(2)
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: '0x0000000000000000000000000000000000000000' },
    })
    expect(screen.getAllByText(/nonzero recipient/i)).toHaveLength(2)
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: RECIPIENT },
    })
    fireEvent.change(screen.getByLabelText(/public message$/i), {
      target: { value: '🫥'.repeat(1_025) },
    })
    fireEvent.click(
      screen.getByLabelText(/I understand this is not a private message/i),
    )
    expect(screen.getByText(/4100 \/ 4096 UTF-8 bytes/i)).toBeTruthy()
    expect(sendButton.hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText(/public message$/i), {
      target: { value: 'Within bounds.' },
    })
    fireEvent.change(screen.getByLabelText(/message attachment commitment/i), {
      target: { value: 'not-a-cid' },
    })
    expect(screen.getByText(/invalid media CID/i)).toBeTruthy()
    expect(sendButton.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(/message attachment commitment/i), {
      target: { value: '' },
    })
    expect(sendButton.hasAttribute('disabled')).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('participates in the shared unresolved wallet-write boundary', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<TransactionReceipt>()
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async () => pending.promise,
    )
    const view = (walletLocked: boolean, chainId = 1n) => (
      <WalletWriteBoundary>
        <WriteBoundaryProbe local={walletLocked} scope="wallet" />
        <PublicMessagePanel
          sendMessage={sendMessage}
          session={connectedSession(provider, chainId)}
        />
      </WalletWriteBoundary>
    )
    const { rerender } = render(view(false))

    fillDraft()
    const send = screen.getByRole('button', {
      name: /send public message on-chain/i,
    })
    expect(send.hasAttribute('disabled')).toBe(false)

    rerender(view(true))
    expect(
      screen
        .getByRole('button', { name: /another wallet action is pending/i })
        .hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: /another wallet action is pending/i }),
    )
    expect(sendMessage).not.toHaveBeenCalled()

    rerender(view(false))
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('write-lock-wallet').textContent).toBe('true')

    rerender(view(false, 2n))
    expect(screen.getByTestId('write-lock-wallet').textContent).toBe('true')
    expect(
      screen
        .getByRole('button', { name: /public message action pending/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    await act(async () => pending.resolve(RECEIPT))
    await waitFor(() =>
      expect(screen.getByTestId('write-lock-wallet').textContent).toBe('false'),
    )
  })

  it('submits a normalized public event, preserves its hash, and clears only the confirmed draft', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const pendingReceipt = deferred<TransactionReceipt>()
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async (
        _provider,
        _account,
        _chainId,
        _recipient,
        _payload,
        onSubmitted,
      ) => {
        onSubmitted?.(TRANSACTION_HASH)
        return pendingReceipt.promise
      },
    )
    render(
      <PublicMessagePanel
        readProvider={readProvider}
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft({ mediaCid: MEDIA_CID.text })

    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    expect(await screen.findByTitle(TRANSACTION_HASH)).toBeTruthy()
    expect(screen.getByText(/waiting for an on-chain receipt/i)).toBeTruthy()
    expect(sendMessage).toHaveBeenCalledWith(
      provider,
      ACCOUNT,
      1n,
      getAddress(RECIPIENT),
      { body: 'Everyone can read this.', mediaCid: MEDIA_CID.bytes },
      expect.any(Function),
    )
    expect(readProvider.request).not.toHaveBeenCalled()

    await act(async () => pendingReceipt.resolve(RECEIPT))
    expect(await screen.findByText(/was included in block 42/i)).toBeTruthy()
    expect(
      screen.getByText(
        /only after the confirmation depth and a manual refresh/i,
      ),
    ).toBeTruthy()
    expect(screen.getByLabelText(/public message$/i)).toHaveProperty(
      'value',
      '',
    )
    expect(
      screen.getByLabelText(/message attachment commitment/i),
    ).toHaveProperty('value', '')
    expect(screen.getByLabelText(/recipient address/i)).toHaveProperty(
      'value',
      RECIPIENT,
    )
    expect(
      screen.getByLabelText(/I understand this is not a private message/i),
    ).toHaveProperty('checked', false)
  })

  it('locks a new chain until the old write resolves and preserves later drafts', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingReceipt = deferred<TransactionReceipt>()
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async () => pendingReceipt.promise,
    )
    const { rerender } = render(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft({ body: 'Old-chain draft.' })
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    expect(await screen.findByText(/approve or reject/i)).toBeTruthy()

    rerender(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider, 2n)}
      />,
    )
    const body = screen.getByLabelText(/public message$/i)
    expect(body.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/keeps every wallet write locked/i)).toBeTruthy()
    await act(async () => pendingReceipt.resolve(RECEIPT))
    await waitFor(() => expect(body.hasAttribute('disabled')).toBe(false))
    fireEvent.change(body, { target: { value: 'New-chain draft.' } })

    expect(body).toHaveProperty('value', 'New-chain draft.')
    expect(screen.queryByText(/was included in block 42/i)).toBeNull()
  })

  it('clears an untouched confirmed draft while another wallet context is active', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingReceipt = deferred<TransactionReceipt>()
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async () => pendingReceipt.promise,
    )
    const { rerender } = render(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft({ body: 'Confirmed while away.' })
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    rerender(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider, 2n)}
      />,
    )

    await act(async () => pendingReceipt.resolve(RECEIPT))
    expect(screen.getByLabelText(/public message$/i)).toHaveProperty(
      'value',
      '',
    )
    expect(
      screen.getByLabelText(/I understand this is not a private message/i),
    ).toHaveProperty('checked', false)
    rerender(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    expect(screen.getByLabelText(/public message$/i)).toHaveProperty(
      'value',
      '',
    )
  })

  it('locks unresolved account-chain activity across injected providers', async () => {
    const firstProvider = { request: vi.fn() } as Eip1193Provider
    const secondProvider = { request: vi.fn() } as Eip1193Provider
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async (
        _provider,
        _account,
        _chainId,
        _recipient,
        _payload,
        onSubmitted,
      ) => {
        onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Receipt transport timed out.')
      },
    )
    const { rerender } = render(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(firstProvider)}
      />,
    )
    fillDraft()
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()

    rerender(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(secondProvider)}
      />,
    )
    expect(screen.getByText(/still locks this account and chain/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /public message action pending/i })
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(
      screen.queryByRole('button', { name: /check message receipt again/i }),
    ).toBeNull()
  })

  it('retains one unresolved lock across more than eight wallet contexts', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pendingForever = new Promise<TransactionReceipt>(() => undefined)
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async () => pendingForever,
    )
    const { rerender } = render(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft()
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))

    for (let chainId = 2n; chainId <= 10n; chainId += 1n) {
      rerender(
        <PublicMessagePanel
          sendMessage={sendMessage}
          session={connectedSession(provider, chainId)}
        />,
      )
      expect(screen.getByText(/keeps every wallet write locked/i)).toBeTruthy()
      expect(
        screen
          .getByRole('button', { name: /public message action pending/i })
          .hasAttribute('disabled'),
      ).toBe(true)
    }

    rerender(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    expect(screen.getAllByText(/approve or reject/i)).toHaveLength(1)
    expect(
      screen
        .getByRole('button', { name: /public message action pending/i })
        .hasAttribute('disabled'),
    ).toBe(true)
  })

  it('advances exactly one bounded range per click and withholds partial history', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const readProvider = { request: vi.fn() } as Eip1193Provider
    const newer = publicMessage('Newer public event.', 2n, {
      mediaCid: MEDIA_CID.bytes,
      recipient: ACCOUNT,
      sender: RECIPIENT,
    })
    const older = publicMessage('Older public event.', 1n)
    const synchronize = vi
      .fn<DirectMessageStreamSynchronizer>()
      .mockResolvedValueOnce({
        ...snapshot([newer, older], false),
        cacheReset: true,
      })
      .mockResolvedValueOnce(snapshot([newer, older]))
    render(
      <PublicMessagePanel
        readProvider={readProvider}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: RECIPIENT },
    })
    expect(synchronize).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )
    expect(
      await screen.findByRole('button', {
        name: /load next bounded message range/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/local event cache was reset/i)).toBeTruthy()
    expect(screen.queryByText('Older public event.')).toBeNull()
    expect(synchronize).toHaveBeenCalledTimes(1)

    fireEvent.click(
      screen.getByRole('button', { name: /load next bounded message range/i }),
    )
    expect(
      await screen.findByRole('button', {
        name: /check for newer public messages/i,
      }),
    ).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(2)
    expect(synchronize).toHaveBeenNthCalledWith(
      2,
      readProvider,
      1n,
      ACCOUNT,
      getAddress(RECIPIENT),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    const renderedMessages = screen.getAllByRole('listitem')
    expect(renderedMessages[0]?.textContent).toContain('Older public event.')
    expect(renderedMessages[1]?.textContent).toContain('Newer public event.')
    expect(screen.getByText(MEDIA_CID.text)).toBeTruthy()
    expect(screen.getAllByText(/newest retained page/i)).toHaveLength(2)
  })

  it('shows a confirmation check without exposing pending deployment history', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi.fn<DirectMessageStreamSynchronizer>(async () => ({
      ...snapshot([], false),
      indexedThrough: undefined,
      safeHead: 18n,
      scannedRanges: 0,
      startBlock: 20n,
    }))
    render(
      <PublicMessagePanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: RECIPIENT },
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )

    expect(
      await screen.findByRole('button', {
        name: /check message confirmations/i,
      }),
    ).toBeTruthy()
    expect(screen.getByText(/history can begin at block 20/i)).toBeTruthy()
    expect(screen.getByText(/confirmed head is still 18/i)).toBeTruthy()
    expect(screen.getByText(/no message log range was requested/i)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('aborts a selected conversation and ignores its stale result', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<DirectMessageStreamSnapshot>()
    const synchronize = vi.fn<DirectMessageStreamSynchronizer>(
      () => pending.promise,
    )
    render(
      <PublicMessagePanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: RECIPIENT },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const signal = synchronize.mock.calls[0]?.[4]?.signal
    expect(signal?.aborted).toBe(false)

    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: OTHER_RECIPIENT },
    })
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve(snapshot([publicMessage('Wrong selection.', 1n)])),
    )
    expect(screen.queryByText('Wrong selection.')).toBeNull()
    expect(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    ).toBeTruthy()
  })

  it('aborts and hides read state when the selected read provider changes', async () => {
    const walletProvider = { request: vi.fn() } as Eip1193Provider
    const firstReadProvider = { request: vi.fn() } as Eip1193Provider
    const secondReadProvider = { request: vi.fn() } as Eip1193Provider
    const pending = deferred<DirectMessageStreamSnapshot>()
    const synchronize = vi
      .fn<DirectMessageStreamSynchronizer>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(
        snapshot([publicMessage('Second provider history.', 2n)]),
      )
    const view = render(
      <PublicMessagePanel
        readProvider={firstReadProvider}
        session={connectedSession(walletProvider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: RECIPIENT },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )
    await waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1))
    const firstSignal = synchronize.mock.calls[0]?.[4]?.signal

    view.rerender(
      <PublicMessagePanel
        readProvider={secondReadProvider}
        session={connectedSession(walletProvider)}
        synchronize={synchronize}
      />,
    )
    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    expect(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    ).toBeTruthy()
    await act(async () =>
      pending.resolve(snapshot([publicMessage('Stale history.', 1n)])),
    )
    expect(screen.queryByText('Stale history.')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )
    expect(await screen.findByText('Second provider history.')).toBeTruthy()
    expect(synchronize).toHaveBeenNthCalledWith(
      2,
      secondReadProvider,
      1n,
      ACCOUNT,
      getAddress(RECIPIENT),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('rejects a synchronizer result for a different conversation', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi.fn<DirectMessageStreamSynchronizer>(async () => ({
      ...snapshot([publicMessage('Do not render me.', 1n)]),
      conversationId: `0x${'99'.repeat(32)}`,
    }))
    render(
      <PublicMessagePanel
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )
    fireEvent.change(screen.getByLabelText(/recipient address/i), {
      target: { value: RECIPIENT },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: /load confirmed public conversation/i,
      }),
    )

    expect(
      await screen.findByText(/returned a different public conversation/i),
    ).toBeTruthy()
    expect(screen.queryByText('Do not render me.')).toBeNull()
  })

  it('locks an unknown hash and retries with the exact expected message event', async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_accounts') return [ACCOUNT]
        throw new Error(`Unexpected method: ${method}`)
      }),
    } as Eip1193Provider
    const sendMessage = vi.fn<typeof sendDirectMessage>(
      async (
        _provider,
        _account,
        _chainId,
        _recipient,
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
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
        waitForReceipt={waitForReceipt}
      />,
    )
    fillDraft({ mediaCid: MEDIA_CID.text })
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )
    expect(await screen.findByText(/final status is unknown/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /public message action pending/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    fireEvent.click(
      screen.getByRole('button', { name: /check message receipt again/i }),
    )
    expect(await screen.findByText(/was included in block 42/i)).toBeTruthy()
    expect(waitForReceipt).toHaveBeenCalledWith(
      provider,
      TRANSACTION_HASH,
      expect.objectContaining({
        assertCurrentChain: expect.any(Function),
        assertUnchanged: expect.any(Function),
        expectedDirectMessage: {
          body: 'Everyone can read this.',
          conversationId: getDirectConversationId(ACCOUNT, RECIPIENT),
          mediaCid: MEDIA_CID.bytes,
          recipient: getAddress(RECIPIENT),
          sender: ACCOUNT,
        },
        selectedChainId: 1n,
      }),
    )
  })

  it('requires explicit wallet-activity acknowledgment after a hashless broadcast', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const sendMessage = vi.fn<typeof sendDirectMessage>(async () => {
      throw new TransactionSubmissionUnknownError(
        new Error('Provider response timed out.'),
      )
    })
    render(
      <PublicMessagePanel
        sendMessage={sendMessage}
        session={connectedSession(provider)}
      />,
    )
    fillDraft()
    fireEvent.click(
      screen.getByRole('button', { name: /send public message on-chain/i }),
    )

    const acknowledge = await screen.findByRole('button', {
      name: /I checked my wallet activity/i,
    })
    expect(screen.getByText(/may have broadcast it/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /public message action pending/i })
        .hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.click(acknowledge)
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /send public message on-chain/i })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
