// @vitest-environment node
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import {
  parseAccounts,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  inspectFilecoinStorage,
} from './filecoin-storage'
import { quoteFilecoinStorage } from './filecoin-storage-quote'

const forkRpcUrl = process.env.LIFEINVADER_FILECOIN_FORK_RPC_URL
const describeFork = forkRpcUrl ? describe : describe.skip

type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}

function httpProvider(url: string, methods: string[] = []): Eip1193Provider {
  let requestId = 0
  return {
    async request({ method, params }: ProviderRequest) {
      methods.push(method)
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
    const provider = httpProvider(forkRpcUrl, methods)
    const account = parseAccounts(
      await provider.request({ method: 'eth_accounts' }),
    )[0]
    expect(account).toBeDefined()
    if (!account) return
    methods.length = 0

    const quote = await quoteFilecoinStorage(provider, 273, {
      expectedAccount: account,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
    })

    expect(quote).toMatchObject({
      account,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      copies: 1,
      dataSize: 273n,
      tokenDecimals: 18,
      tokenSymbol: 'USDFC',
      withCDN: false,
    })
    expect(quote.rates.perMonth).toBeGreaterThan(0n)
    expect(quote.fees.total).toBeGreaterThan(0n)
    expect(quote.lockups.total).toBeGreaterThan(0n)
    expect(methods.length).toBeLessThanOrEqual(16)
    expect(methods).not.toContain('eth_sendTransaction')
    expect(methods).not.toContain('eth_signTypedData_v4')
  }, 30_000)
})
