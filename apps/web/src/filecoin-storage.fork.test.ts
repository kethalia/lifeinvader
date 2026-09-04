// @vitest-environment node
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  inspectFilecoinStorage,
} from './filecoin-storage'
import { quoteFilecoinStorage } from './filecoin-storage-quote'

const forkRpcUrl = process.env.LIFEINVADER_FILECOIN_FORK_RPC_URL
const describeFork = forkRpcUrl ? describe : describe.skip
const UNUSED_QUOTE_ACCOUNT = getAddress(
  '0x000000000000000000000000000000000000a11c',
)

type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}

function httpProvider(
  url: string,
  methods: string[] = [],
  selectedAccount?: Address,
): Eip1193Provider {
  let requestId = 0
  return {
    async request({ method, params }: ProviderRequest) {
      methods.push(method)
      if (method === 'eth_accounts' && selectedAccount) {
        return [selectedAccount]
      }
      const response = await fetch(url, {
        body: JSON.stringify({
          id: ++requestId,
          jsonrpc: '2.0',
          method,
          params: params ?? [],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(`Local fork RPC returned HTTP ${response.status}.`)
      }
      const payload = (await response.json()) as JsonRpcResponse
      if (payload.error) {
        const error = new Error(
          payload.error.message ?? 'Local fork RPC request failed.',
        )
        Object.assign(error, { code: payload.error.code })
        throw error
      }
      return payload.result
    },
  }
}

describeFork('Filecoin storage inspection on a pinned Anvil fork', () => {
  it('verifies the live Calibration deployment graph', async () => {
    if (!forkRpcUrl) return
    const provider = httpProvider(forkRpcUrl)

    await expect(inspectFilecoinStorage(provider)).resolves.toMatchObject({
      kind: 'ready',
      network: {
        chainId: FILECOIN_CALIBRATION_CHAIN_ID,
        id: 'filecoin-calibration',
      },
    })
  }, 20_000)

  it('quotes one current non-CDN copy without sending a transaction', async () => {
    if (!forkRpcUrl) return
    const methods: string[] = []
    const provider = httpProvider(forkRpcUrl, methods, UNUSED_QUOTE_ACCOUNT)

    const quote = await quoteFilecoinStorage(provider, 273, {
      expectedAccount: UNUSED_QUOTE_ACCOUNT,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
    })

    expect(quote).toEqual({
      account: UNUSED_QUOTE_ACCOUNT,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      copies: 1,
      dataSize: 273n,
      depositNeeded: 620_000_000_647_923_200n,
      fees: {
        addPiecesFee: 11_000_000_000_000_000n,
        createDataSetFee: 25_000_000_000_000_000n,
        total: 36_000_000_000_000_000n,
      },
      lockups: {
        cacheMissLockup: 0n,
        cdnLockup: 0n,
        lifecycleLockup: 500_000_000_000_000_000n,
        rateDeltaPerEpoch: 1_388_888_896_388n,
        reserveReplenishment: 0n,
        streamingLockup: 120_000_000_647_923_200n,
        total: 620_000_000_647_923_200n,
      },
      needsServiceApproval: true,
      rates: {
        perEpoch: 1_388_888_896_388n,
        perMonth: 120_000_000_648_014_975n,
      },
      ready: false,
      tokenDecimals: 18,
      tokenSymbol: 'USDFC',
      withCDN: false,
    })
    expect(methods.length).toBeLessThanOrEqual(16)
    expect(methods).not.toContain('eth_sendTransaction')
    expect(methods).not.toContain('eth_signTypedData_v4')
  }, 30_000)
})
