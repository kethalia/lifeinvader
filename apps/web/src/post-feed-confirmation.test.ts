import { describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters,
  padHex,
  toHex,
  type Address,
  type Hash,
} from 'viem'
import type { Eip1193Provider } from './ethereum'
import { waitForPostFeedConfirmation } from './post-feed-confirmation'
import { POST_PUBLISHED_TOPIC, PROTOCOL_ADDRESS } from './protocol'

const BLOCK_HASH = `0x${'11'.repeat(32)}` as const
const REINCLUDED_BLOCK_HASH = `0x${'22'.repeat(32)}` as const
const TRANSACTION_HASH = `0x${'33'.repeat(32)}` as const
const ACCOUNT = '0x000000000000000000000000000000000000a11c' as Address
const BODY = 'Public after every reorg.'

function postLogs() {
  return [
    {
      address: PROTOCOL_ADDRESS,
      data: encodeAbiParameters(
        [{ type: 'string' }, { type: 'bytes' }],
        [BODY, '0x'],
      ),
      topics: [
        POST_PUBLISHED_TOPIC,
        padHex(toHex(1n), { size: 32 }),
        padHex(ACCOUNT, { size: 32 }),
      ],
    },
  ]
}

function receipt(
  blockHash: Hash = BLOCK_HASH,
  blockNumber = '0x8',
  logs: unknown = postLogs(),
  status = '0x1',
) {
  return {
    blockHash,
    blockNumber,
    logs,
    status,
    transactionHash: TRANSACTION_HASH,
  }
}

function inclusion(blockNumber = 8n, blockHash = BLOCK_HASH) {
  return {
    blockHash,
    blockNumber,
    expectedPost: { author: ACCOUNT, body: BODY },
    hash: TRANSACTION_HASH,
  }
}

describe('post feed confirmation monitoring', () => {
  it('waits until the canonical inclusion is twelve blocks deep', async () => {
    const heads = [19n, 20n]
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(heads.shift() ?? 20n)
        if (method === 'eth_getTransactionReceipt') return receipt()
        if (method === 'eth_getBlockByNumber') {
          return { hash: BLOCK_HASH, number: (params as [string])[0] }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(provider.request).toHaveBeenCalledTimes(10)
  })

  it('restarts the depth check when the transaction is re-included', async () => {
    const heads = [20n, 28n]
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(heads.shift() ?? 28n)
        if (method === 'eth_getTransactionReceipt')
          return receipt(REINCLUDED_BLOCK_HASH, '0x10')
        if (method === 'eth_getBlockByNumber') {
          expect(params).toEqual(['0x10', false])
          return { hash: REINCLUDED_BLOCK_HASH, number: '0x10' }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(
      vi
        .mocked(provider.request)
        .mock.calls.filter(([request]) => request.method === 'eth_blockNumber'),
    ).toHaveLength(3)
  })

  it('detects an earlier re-inclusion after the head rolls back', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x50'
        if (method === 'eth_getTransactionReceipt') {
          return receipt(REINCLUDED_BLOCK_HASH, '0x3c')
        }
        if (method === 'eth_getBlockByNumber') {
          expect(params).toEqual(['0x3c', false])
          return { hash: REINCLUDED_BLOCK_HASH, number: '0x3c' }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(100n, BLOCK_HASH), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
  })

  it('waits through a temporary reverted replacement receipt', async () => {
    let receiptReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getTransactionReceipt') {
          receiptReads += 1
          return receipt(
            receiptReads === 1 ? REINCLUDED_BLOCK_HASH : BLOCK_HASH,
            receiptReads === 1 ? '0x10' : '0x8',
            receiptReads === 1 ? [] : postLogs(),
            receiptReads === 1 ? '0x0' : '0x1',
          )
        }
        if (method === 'eth_getBlockByNumber') {
          return { hash: BLOCK_HASH, number: (params as [string])[0] }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(receiptReads).toBe(2)
  })

  it('stops only after a reverted receipt is canonical and deep', async () => {
    let blockReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getTransactionReceipt') {
          return receipt(BLOCK_HASH, '0x8', [], '0x0')
        }
        if (method === 'eth_getBlockByNumber') {
          blockReads += 1
          return { hash: BLOCK_HASH, number: (params as [string])[0] }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/reverted in canonical history/i)
    expect(blockReads).toBe(2)
  })

  it('does not accept a receipt from a non-canonical block', async () => {
    let blockReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getTransactionReceipt') return receipt()
        if (method === 'eth_getBlockByNumber') {
          blockReads += 1
          return {
            hash: blockReads === 1 ? REINCLUDED_BLOCK_HASH : BLOCK_HASH,
            number: (params as [string])[0],
          }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(blockReads).toBe(3)
  })

  it('rechecks depth after canonical block validation', async () => {
    const heads = [20n, 19n, 20n, 20n]
    let blockReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return toHex(heads.shift() ?? 20n)
        if (method === 'eth_getTransactionReceipt') return receipt()
        if (method === 'eth_getBlockByNumber') {
          blockReads += 1
          return { hash: BLOCK_HASH, number: (params as [string])[0] }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(blockReads).toBe(3)
  })

  it('rechecks the canonical block after the fresh head', async () => {
    let blockReads = 0
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getTransactionReceipt') return receipt()
        if (method === 'eth_getBlockByNumber') {
          blockReads += 1
          return {
            hash: blockReads === 2 ? REINCLUDED_BLOCK_HASH : BLOCK_HASH,
            number: (params as [string])[0],
          }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined()
    expect(blockReads).toBe(4)
  })

  it('rejects a canonical replacement receipt without the expected post', async () => {
    const provider: Eip1193Provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_blockNumber') return '0x14'
        if (method === 'eth_getTransactionReceipt')
          return receipt(REINCLUDED_BLOCK_HASH, '0x8', [])
        if (method === 'eth_getBlockByNumber') {
          return {
            hash: REINCLUDED_BLOCK_HASH,
            number: (params as [string])[0],
          }
        }
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion(), {
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/expected post event/i)
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

    await expect(
      waitForPostFeedConfirmation(provider, 1n, inclusion()),
    ).rejects.toThrow(/chain changed/i)
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
    const pending = waitForPostFeedConfirmation(provider, 1n, inclusion(), {
      signal: controller.signal,
      timeoutMs: 1_000,
    })
    controller.abort()

    await expect(pending).rejects.toThrow(/cancelled/i)
  })
})
