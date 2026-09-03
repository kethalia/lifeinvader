import { describe, expect, it, vi } from 'vitest'
import { toHex } from 'viem'
import type { Eip1193Provider } from './ethereum'
import { waitForPostFeedConfirmation } from './post-feed-confirmation'

describe('post feed confirmation monitoring', () => {
  it('waits until the inclusion block is twelve blocks deep', async () => {
    const heads = [19n, 20n]
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(heads.shift() ?? 20n)
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, 8n, {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(provider.request).toHaveBeenCalledTimes(4)
  })

  it('rejects a changed wallet chain and removes provider listeners', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193Provider = {
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x2'
        if (method === 'eth_blockNumber') return '0x20'
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(waitForPostFeedConfirmation(provider, 1n, 8n)).rejects.toThrow(
      /chain changed/i,
    )
    expect(provider.removeListener).toHaveBeenCalledWith(
      'chainChanged',
      expect.any(Function),
    )
    expect(provider.removeListener).toHaveBeenCalledWith(
      'disconnect',
      expect.any(Function),
    )
    expect(listeners.size).toBe(0)
  })

  it('interrupts pending wallet reads when cancelled', async () => {
    const provider = {
      request: vi.fn(() => new Promise<unknown>(() => undefined)),
    } satisfies Eip1193Provider
    const controller = new AbortController()
    const pending = waitForPostFeedConfirmation(provider, 1n, 8n, {
      signal: controller.signal,
      timeoutMs: 1_000,
    })
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/i)
  })
})
