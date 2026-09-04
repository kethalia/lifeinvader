import { describe, expect, it, vi } from 'vitest'
import { getAddress, type Address } from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_MAINNET_CHAIN_ID,
} from './filecoin-storage'
import {
  MAX_FILECOIN_STORAGE_QUOTE_RPC_REQUESTS,
  quoteFilecoinStorage,
  type FilecoinStorageCostReader,
  type FilecoinStorageCosts,
} from './filecoin-storage-quote'

const ACCOUNT = getAddress('0x000000000000000000000000000000000000a11c')
const OTHER_ACCOUNT = getAddress('0x000000000000000000000000000000000000b0bb')

function storageCosts(
  overrides: Partial<FilecoinStorageCosts> = {},
): FilecoinStorageCosts {
  return {
    depositNeeded: 13_000_000_000_000_000n,
    fees: {
      addPiecesFee: 2_000_000_000_000_000n,
      createDataSetFee: 3_000_000_000_000_000n,
      total: 5_000_000_000_000_000n,
    },
    lockups: {
      cacheMissLockup: 0n,
      cdnLockup: 0n,
      lifecycleLockup: 8_000_000_000_000_000n,
      rateDeltaPerEpoch: 120_000n,
      reserveReplenishment: 0n,
      streamingLockup: 0n,
      total: 8_000_000_000_000_000n,
    },
    needsFwssMaxApproval: true,
    rates: {
      perEpoch: 120_000n,
      perMonth: 345_600_000_000n,
    },
    ready: false,
    ...overrides,
  }
}

function quoteProvider({
  accounts = [ACCOUNT],
  chainIds = [FILECOIN_CALIBRATION_CHAIN_ID],
}: {
  accounts?: Address[]
  chainIds?: bigint[]
} = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const requests: ProviderRequest[] = []
  let accountRead = 0
  let chainRead = 0
  const provider: Eip1193Provider = {
    request: vi.fn(async (request) => {
      requests.push(request)
      if (request.method === 'eth_chainId') {
        const value = chainIds[Math.min(chainRead, chainIds.length - 1)]
        chainRead += 1
        return `0x${(value ?? 0n).toString(16)}`
      }
      if (request.method === 'eth_accounts') {
        const value = accounts[Math.min(accountRead, accounts.length - 1)]
        accountRead += 1
        return value ? [value] : []
      }
      if (request.method === 'eth_blockNumber') return '0x123'
      if (request.method === 'eth_call') return '0x'
      throw new Error(`Unexpected wallet method: ${request.method}`)
    }),
    on: vi.fn((event, listener) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    removeListener: vi.fn((event, listener) => {
      listeners.get(event)?.delete(listener)
    }),
  }
  return {
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((listener) => listener(...args))
    },
    listeners,
    provider,
    requests,
  }
}

function quoteOptions(readCosts: FilecoinStorageCostReader) {
  return {
    expectedAccount: ACCOUNT,
    expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
    readCosts,
  }
}

describe('Filecoin storage quotes', () => {
  it('returns one-copy costs through a bounded read-only wallet transport', async () => {
    const wallet = quoteProvider()
    const readCosts = vi.fn<FilecoinStorageCostReader>(async (input) => {
      expect(input).toMatchObject({
        account: ACCOUNT,
        chainId: FILECOIN_CALIBRATION_CHAIN_ID,
        dataSize: 273n,
      })
      await input.request({ method: 'eth_blockNumber' })
      await input.request({
        method: 'eth_call',
        params: [{ data: '0x1234', to: ACCOUNT }, 'latest'],
      })
      return storageCosts()
    })

    await expect(
      quoteFilecoinStorage(wallet.provider, 273, quoteOptions(readCosts)),
    ).resolves.toEqual({
      account: ACCOUNT,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      copies: 1,
      dataSize: 273n,
      depositNeeded: 13_000_000_000_000_000n,
      fees: storageCosts().fees,
      lockups: storageCosts().lockups,
      needsServiceApproval: true,
      rates: storageCosts().rates,
      ready: false,
      tokenDecimals: 18,
      tokenSymbol: 'USDFC',
      withCDN: false,
    })
    expect(wallet.requests.map(({ method }) => method)).toEqual([
      'eth_chainId',
      'eth_accounts',
      'eth_blockNumber',
      'eth_call',
      'eth_chainId',
      'eth_accounts',
    ])
    expect(
      [...wallet.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true)
  })

  it('rejects unsupported or mismatched wallet contexts before cost reads', async () => {
    const unsupported = quoteProvider()
    const unsupportedReader = vi.fn<FilecoinStorageCostReader>()
    await expect(
      quoteFilecoinStorage(unsupported.provider, 273, {
        expectedAccount: ACCOUNT,
        expectedChainId: 31_337n,
        readCosts: unsupportedReader,
      }),
    ).rejects.toThrow(/chain 31337 is unsupported/i)
    expect(unsupported.requests).toHaveLength(0)
    expect(unsupportedReader).not.toHaveBeenCalled()

    const wrongChain = quoteProvider({
      chainIds: [FILECOIN_MAINNET_CHAIN_ID],
    })
    const wrongChainReader = vi.fn<FilecoinStorageCostReader>()
    await expect(
      quoteFilecoinStorage(
        wrongChain.provider,
        273,
        quoteOptions(wrongChainReader),
      ),
    ).rejects.toThrow(/moved from expected chain 314159 to chain 314/i)
    expect(wrongChainReader).not.toHaveBeenCalled()

    const wrongAccount = quoteProvider({ accounts: [OTHER_ACCOUNT] })
    const wrongAccountReader = vi.fn<FilecoinStorageCostReader>()
    await expect(
      quoteFilecoinStorage(
        wrongAccount.provider,
        273,
        quoteOptions(wrongAccountReader),
      ),
    ).rejects.toThrow(/selected wallet account changed/i)
    expect(wrongAccountReader).not.toHaveBeenCalled()
  })

  it('refuses write, signing, and unbounded adapter behavior', async () => {
    const writeWallet = quoteProvider()
    await expect(
      quoteFilecoinStorage(
        writeWallet.provider,
        273,
        quoteOptions(async ({ request }) => {
          await request({ method: 'eth_sendTransaction', params: [] })
          return storageCosts()
        }),
      ),
    ).rejects.toThrow(/forbidden RPC method eth_sendTransaction/i)
    expect(
      writeWallet.requests.some(
        ({ method }) => method === 'eth_sendTransaction',
      ),
    ).toBe(false)

    const signingWallet = quoteProvider()
    await expect(
      quoteFilecoinStorage(
        signingWallet.provider,
        273,
        quoteOptions(async ({ request }) => {
          await request({ method: 'personal_sign', params: [] })
          return storageCosts()
        }),
      ),
    ).rejects.toThrow(/forbidden RPC method personal_sign/i)

    const malformedWallet = quoteProvider()
    await expect(
      quoteFilecoinStorage(
        malformedWallet.provider,
        273,
        quoteOptions(async ({ request }) => {
          await request({ method: 42 as never })
          return storageCosts()
        }),
      ),
    ).rejects.toThrow(/forbidden RPC method <invalid>/i)
    expect(malformedWallet.requests).toHaveLength(2)

    const noisyWallet = quoteProvider()
    await expect(
      quoteFilecoinStorage(
        noisyWallet.provider,
        273,
        quoteOptions(async ({ request }) => {
          for (
            let index = 0;
            index < MAX_FILECOIN_STORAGE_QUOTE_RPC_REQUESTS;
            index += 1
          ) {
            await request({ method: 'eth_call', params: [] })
          }
          return storageCosts()
        }),
      ),
    ).rejects.toThrow(/exceeded its wallet-read budget/i)
    expect(noisyWallet.requests).toHaveLength(
      MAX_FILECOIN_STORAGE_QUOTE_RPC_REQUESTS,
    )
  })

  it('rejects stale account, chain, and disconnect events during a quote', async () => {
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
      const wallet = quoteProvider()
      await expect(
        quoteFilecoinStorage(
          wallet.provider,
          273,
          quoteOptions(async () => {
            wallet.emit(event)
            return storageCosts()
          }),
        ),
      ).rejects.toThrow(/wallet context changed during the quote/i)
      expect(
        [...wallet.listeners.values()].every(
          (listeners) => listeners.size === 0,
        ),
      ).toBe(true)
    }
  })

  it('removes listeners when provider registration fails partway through', async () => {
    const wallet = quoteProvider()
    const addListener = wallet.provider.on?.bind(wallet.provider)
    wallet.provider.on = vi.fn((event, listener) => {
      addListener?.(event, listener)
      if (event === 'chainChanged') throw new Error('Listener failure')
    })

    await expect(
      quoteFilecoinStorage(
        wallet.provider,
        273,
        quoteOptions(async () => storageCosts()),
      ),
    ).rejects.toThrow(/listener failure/i)
    expect(
      [...wallet.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true)
  })

  it('does not replace a quote result when provider cleanup throws', async () => {
    const wallet = quoteProvider()
    wallet.provider.removeListener = vi.fn(() => {
      throw new Error('Cleanup failure')
    })

    await expect(
      quoteFilecoinStorage(
        wallet.provider,
        273,
        quoteOptions(async () => storageCosts()),
      ),
    ).resolves.toMatchObject({
      account: ACCOUNT,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      dataSize: 273n,
    })
  })

  it('brackets the cost result with fresh account and chain reads', async () => {
    const changedChain = quoteProvider({
      chainIds: [FILECOIN_CALIBRATION_CHAIN_ID, FILECOIN_MAINNET_CHAIN_ID],
    })
    await expect(
      quoteFilecoinStorage(
        changedChain.provider,
        273,
        quoteOptions(async () => storageCosts()),
      ),
    ).rejects.toThrow(/moved from expected chain 314159 to chain 314/i)

    const changedAccount = quoteProvider({
      accounts: [ACCOUNT, OTHER_ACCOUNT],
    })
    await expect(
      quoteFilecoinStorage(
        changedAccount.provider,
        273,
        quoteOptions(async () => storageCosts()),
      ),
    ).rejects.toThrow(/selected wallet account changed/i)
  })

  it('bounds stalled reads and honors cancellation', async () => {
    const stalled = quoteProvider()
    await expect(
      quoteFilecoinStorage(stalled.provider, 273, {
        ...quoteOptions(() => new Promise(() => undefined)),
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/Synapse cost read timed out/i)

    const controller = new AbortController()
    controller.abort()
    const cancelled = quoteProvider()
    await expect(
      quoteFilecoinStorage(cancelled.provider, 273, {
        ...quoteOptions(async () => storageCosts()),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/quote was cancelled/i)
  })

  it('rejects invalid archive sizes and inconsistent SDK results', async () => {
    const wallet = quoteProvider()
    const reader = vi.fn<FilecoinStorageCostReader>(async () => storageCosts())
    await expect(
      quoteFilecoinStorage(wallet.provider, 126, quoteOptions(reader)),
    ).rejects.toThrow(/prepared CAR byte length is invalid/i)
    expect(wallet.requests).toHaveLength(0)

    await expect(
      quoteFilecoinStorage(
        wallet.provider,
        273,
        quoteOptions(async () =>
          storageCosts({
            fees: {
              addPiecesFee: 2n,
              createDataSetFee: 3n,
              total: 6n,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/inconsistent service fees/i)

    await expect(
      quoteFilecoinStorage(
        wallet.provider,
        273,
        quoteOptions(async () =>
          storageCosts({
            lockups: {
              ...storageCosts().lockups,
              total: 8_000_000_000_000_001n,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/inconsistent payment lockups/i)

    await expect(
      quoteFilecoinStorage(
        wallet.provider,
        273,
        quoteOptions(async () => storageCosts({ ready: true })),
      ),
    ).rejects.toThrow(/inconsistent readiness state/i)
  })
})
