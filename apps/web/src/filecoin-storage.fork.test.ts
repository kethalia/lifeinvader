// @vitest-environment node
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  inspectFilecoinStorage,
} from './filecoin-storage'

const forkRpcUrl = process.env.LIFEINVADER_FILECOIN_FORK_RPC_URL
const describeFork = forkRpcUrl ? describe : describe.skip

type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}

function httpProvider(url: string): Eip1193Provider {
  let requestId = 0
  return {
    async request({ method, params }: ProviderRequest) {
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
})
