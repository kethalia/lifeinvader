import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, padHex, type Address, type Hex } from 'viem'
import { parseMediaCid } from './media-cid'
import {
  LIFEINVADER_INIT_CODE,
  PROFILE_SET_TOPIC,
  PROTOCOL_ADDRESS,
  setProfile,
  type TransactionReceipt,
} from './protocol'
import { WalletPanel } from './wallet-panel'
import { resetWalletDiscoveryForTests } from './wallet-providers'
import type { WalletSessionController } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c' as Address
const TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RECEIPT_BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex
const PROFILE_DATA_PARAMETERS = [
  { type: 'string' },
  { type: 'string' },
  { type: 'bytes' },
] as const
const MEDIA_CID_V0 = 'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C'
const MEDIA_CID = parseMediaCid(MEDIA_CID_V0)!
const PROTOCOL_RUNTIME_CODE =
  `0x${LIFEINVADER_INIT_CODE.slice(2 + 0x32 * 2)}` as Hex

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function controller(provider: WalletSessionController['session']['provider']) {
  return {
    connect: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    session: {
      account: ACCOUNT,
      chainId: 1n,
      name: 'Profile Wallet',
      provider,
      status: 'connected',
    },
  } satisfies WalletSessionController
}

function inspectionProvider() {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
      throw new Error(`Unexpected method: ${method}`)
    }),
  }
}

async function waitForWalletWrites() {
  await waitFor(() =>
    expect(
      (screen.getByLabelText(/^display name$/i) as HTMLInputElement).disabled,
    ).toBe(false),
  )
}

afterEach(() => {
  cleanup()
  resetWalletDiscoveryForTests()
})

describe('wallet profile publisher', () => {
  it('requires a separate acknowledgment for an empty clear snapshot', async () => {
    const provider = inspectionProvider()
    const readProvider = { request: vi.fn() }
    const setProfileAction = vi.fn<typeof setProfile>(async () => ({
      blockHash: RECEIPT_BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    }))
    render(
      <WalletPanel
        onPostConfirmed={vi.fn()}
        readProvider={readProvider}
        setProfileAction={setProfileAction}
        walletSession={controller(provider)}
      />,
    )
    await screen.findByText(/verified Lifeinvader v1 code is ready/i)
    await waitForWalletWrites()
    fireEvent.change(screen.getByLabelText(/IPFS avatar CID/i), {
      target: { value: '   ' },
    })
    const publish = screen.getByRole('button', {
      name: /publish empty profile snapshot/i,
    })
    expect(publish.hasAttribute('disabled')).toBe(true)

    fireEvent.click(
      screen.getByRole('checkbox', { name: /does not erase history/i }),
    )
    fireEvent.click(publish)

    await waitFor(() => expect(setProfileAction).toHaveBeenCalledTimes(1))
    expect(setProfileAction).toHaveBeenCalledWith(
      provider,
      ACCOUNT,
      1n,
      { avatarCid: '0x', bio: '', displayName: '' },
      expect.any(Function),
    )
    expect(readProvider.request).not.toHaveBeenCalled()
  })

  it('validates and submits one complete public profile snapshot', async () => {
    const provider = inspectionProvider()
    const completion = deferred<TransactionReceipt>()
    const setProfileAction = vi.fn<typeof setProfile>(
      async (_provider, _account, _chainId, _payload, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        return completion.promise
      },
    )
    render(
      <WalletPanel
        onPostConfirmed={vi.fn()}
        setProfileAction={setProfileAction}
        walletSession={controller(provider)}
      />,
    )
    await screen.findByText(/verified Lifeinvader v1 code is ready/i)
    await waitForWalletWrites()

    const clearButton = screen.getByRole('button', {
      name: /publish empty profile snapshot/i,
    })
    expect(clearButton.hasAttribute('disabled')).toBe(true)
    fireEvent.click(
      screen.getByRole('checkbox', { name: /does not erase history/i }),
    )
    expect(clearButton.hasAttribute('disabled')).toBe(false)

    const displayName = screen.getByLabelText(/^display name$/i)
    const bio = screen.getByLabelText(/^bio$/i)
    const avatar = screen.getByLabelText(/IPFS avatar CID/i)
    fireEvent.change(displayName, { target: { value: '🫠'.repeat(17) } })
    expect(screen.getByText('68 / 64 UTF-8 bytes')).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /publish profile on-chain/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    fireEvent.change(displayName, { target: { value: 'Tracey De Santa' } })
    fireEvent.change(bio, { target: { value: '🫠'.repeat(257) } })
    expect(screen.getByText('1028 / 1024 UTF-8 bytes')).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /publish profile on-chain/i })
        .hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.change(bio, { target: { value: 'Public relations enthusiast.' } })
    fireEvent.change(avatar, { target: { value: 'not-a-cid' } })
    expect(screen.getByText(/invalid media CID/i)).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: /publish profile on-chain/i })
        .hasAttribute('disabled'),
    ).toBe(true)

    fireEvent.change(avatar, { target: { value: MEDIA_CID_V0 } })
    fireEvent.click(
      screen.getByRole('button', { name: /publish profile on-chain/i }),
    )
    await waitFor(() => expect(setProfileAction).toHaveBeenCalledTimes(1))
    expect(setProfileAction).toHaveBeenCalledWith(
      provider,
      ACCOUNT,
      1n,
      {
        avatarCid: MEDIA_CID.bytes,
        bio: 'Public relations enthusiast.',
        displayName: 'Tracey De Santa',
      },
      expect.any(Function),
    )
    expect(screen.getByText(/profile submitted on chain 1/i)).toBeTruthy()
    expect(displayName.hasAttribute('disabled')).toBe(true)

    await act(async () =>
      completion.resolve({
        blockHash: RECEIPT_BLOCK_HASH,
        blockNumber: 42n,
        hash: TRANSACTION_HASH,
      }),
    )
    expect(await screen.findByText(/included in block 42/i)).toBeTruthy()
    expect((displayName as HTMLInputElement).value).toBe('Tracey De Santa')
    expect((bio as HTMLTextAreaElement).value).toBe(
      'Public relations enthusiast.',
    )
    expect((avatar as HTMLInputElement).value).toBe(MEDIA_CID_V0)
  })

  it('reauthenticates the exact profile payload when retrying a receipt', async () => {
    const displayName = 'Michael Townley'
    const bio = 'Definitely retired.'
    const provider = {
      request: vi.fn(
        async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_accounts') return [ACCOUNT]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'eth_getCode') return PROTOCOL_RUNTIME_CODE
          if (method === 'eth_getTransactionReceipt') {
            return {
              blockHash: RECEIPT_BLOCK_HASH,
              blockNumber: '0x2a',
              logs: [
                {
                  address: PROTOCOL_ADDRESS,
                  blockHash: RECEIPT_BLOCK_HASH,
                  blockNumber: '0x2a',
                  data: encodeAbiParameters(PROFILE_DATA_PARAMETERS, [
                    displayName,
                    bio,
                    MEDIA_CID.bytes,
                  ]),
                  topics: [PROFILE_SET_TOPIC, padHex(ACCOUNT, { size: 32 })],
                  transactionHash: TRANSACTION_HASH,
                },
              ],
              status: '0x1',
              transactionHash: TRANSACTION_HASH,
            }
          }
          if (method === 'eth_getBlockByNumber') {
            return {
              hash: RECEIPT_BLOCK_HASH,
              number: (params as [string])[0],
            }
          }
          throw new Error(`Unexpected method: ${method}`)
        },
      ),
    }
    const setProfileAction = vi.fn<typeof setProfile>(
      async (_provider, _account, _chainId, _payload, onSubmitted) => {
        onSubmitted?.(TRANSACTION_HASH)
        throw new Error('Temporary receipt outage.')
      },
    )
    render(
      <WalletPanel
        onPostConfirmed={vi.fn()}
        setProfileAction={setProfileAction}
        walletSession={controller(provider)}
      />,
    )
    await screen.findByText(/verified Lifeinvader v1 code is ready/i)
    await waitForWalletWrites()
    fireEvent.change(screen.getByLabelText(/^display name$/i), {
      target: { value: displayName },
    })
    fireEvent.change(screen.getByLabelText(/^bio$/i), {
      target: { value: bio },
    })
    fireEvent.change(screen.getByLabelText(/IPFS avatar CID/i), {
      target: { value: MEDIA_CID_V0 },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /publish profile on-chain/i }),
    )

    expect(await screen.findByText(/its final status is unknown/i)).toBeTruthy()
    expect(
      (screen.getByLabelText(/^display name$/i) as HTMLInputElement).value,
    ).toBe(displayName)
    expect((screen.getByLabelText(/^bio$/i) as HTMLTextAreaElement).value).toBe(
      bio,
    )
    expect(
      (screen.getByLabelText(/IPFS avatar CID/i) as HTMLInputElement).value,
    ).toBe(MEDIA_CID_V0)
    fireEvent.click(
      screen.getByRole('button', { name: /check receipt again/i }),
    )

    expect(await screen.findByText(/included in block 42/i)).toBeTruthy()
    expect(provider.request).toHaveBeenCalledWith({
      method: 'eth_getTransactionReceipt',
      params: [TRANSACTION_HASH],
    })
  })
})
