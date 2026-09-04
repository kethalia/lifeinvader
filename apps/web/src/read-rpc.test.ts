import { describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import type { HttpRpcProvider } from './http-rpc'
import { verifyReadRpcProvider } from './read-rpc'

const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const

function provider(
  responses: Partial<Record<string, unknown>>,
): Eip1193Provider {
  return {
    request: vi.fn(async ({ method }: ProviderRequest) => {
      if (method in responses) return responses[method]
      throw new Error(`Unexpected RPC method: ${method}`)
    }),
  }
}

function httpProvider(
  responses: Partial<Record<string, unknown>>,
  requestWithSignal?: HttpRpcProvider['requestWithSignal'],
): HttpRpcProvider {
  return Object.freeze({
    close: vi.fn(),
    endpoint: Object.freeze({
      origin: 'https://rpc.example',
      url: 'https://rpc.example/private-key',
    }),
    request: vi.fn(async ({ method }: ProviderRequest) => {
      if (method in responses) return responses[method]
      throw new Error(`Unexpected RPC method: ${method}`)
    }),
    ...(requestWithSignal ? { requestWithSignal } : {}),
  })
}

function matchingResponses(head = '0x64') {
  return {
    eth_blockNumber: head,
    eth_chainId: '0x1',
    eth_getBlockByNumber: { hash: BLOCK_HASH, number: '0x58' },
  }
}

describe('read RPC verification', () => {
  it('matches a shared confirmed block without exposing the endpoint path', async () => {
    const wallet = provider(matchingResponses())
    const endpoint = httpProvider(matchingResponses('0x70'))

    await expect(verifyReadRpcProvider(wallet, 1n, endpoint)).resolves.toEqual({
      blockHash: BLOCK_HASH,
      blockNumber: 88n,
      chainId: 1n,
      endpointOrigin: 'https://rpc.example',
    })
    expect(wallet.request).toHaveBeenCalledTimes(4)
    expect(endpoint.request).toHaveBeenCalledTimes(4)
    expect(wallet.request).toHaveBeenCalledWith({
      method: 'eth_getBlockByNumber',
      params: ['0x58', false],
    })
  })

  it('rejects an endpoint on a different chain before reading its head', async () => {
    const wallet = provider(matchingResponses())
    const endpoint = httpProvider({
      ...matchingResponses(),
      eth_chainId: '0x89',
    })

    await expect(verifyReadRpcProvider(wallet, 1n, endpoint)).rejects.toThrow(
      /endpoint reports chain 137.*wallet reports chain 1/i,
    )
    expect(endpoint.request).toHaveBeenCalledTimes(1)
  })

  it('rejects a same-chain endpoint on different block history', async () => {
    const wallet = provider(matchingResponses())
    const endpoint = httpProvider({
      ...matchingResponses(),
      eth_getBlockByNumber: {
        hash: `0x${'cd'.repeat(32)}`,
        number: '0x58',
      },
    })

    await expect(verifyReadRpcProvider(wallet, 1n, endpoint)).rejects.toThrow(
      /does not match wallet history at block 88/i,
    )
  })

  it('uses genesis when neither provider has twelve confirmed blocks', async () => {
    const responses = {
      eth_blockNumber: '0x5',
      eth_chainId: '0x1',
      eth_getBlockByNumber: { hash: BLOCK_HASH, number: '0x0' },
    }
    const wallet = provider(responses)
    const endpoint = httpProvider(responses)

    await expect(verifyReadRpcProvider(wallet, 1n, endpoint)).resolves.toEqual(
      expect.objectContaining({ blockNumber: 0n }),
    )
    expect(endpoint.request).toHaveBeenCalledWith({
      method: 'eth_getBlockByNumber',
      params: ['0x0', false],
    })
  })

  it('snapshots block fields before validating provider objects', async () => {
    let hashReads = 0
    let numberReads = 0
    const block = Object.defineProperties(
      {},
      {
        hash: {
          get() {
            hashReads += 1
            return hashReads === 1 ? BLOCK_HASH : `0x${'cd'.repeat(32)}`
          },
        },
        number: {
          get() {
            numberReads += 1
            return numberReads === 1 ? '0x58' : '0x57'
          },
        },
      },
    )
    const wallet = provider({
      ...matchingResponses(),
      eth_getBlockByNumber: block,
    })
    const endpoint = httpProvider(matchingResponses())

    await expect(verifyReadRpcProvider(wallet, 1n, endpoint)).resolves.toEqual(
      expect.objectContaining({ blockHash: BLOCK_HASH, blockNumber: 88n }),
    )
    expect(hashReads).toBe(1)
    expect(numberReads).toBe(1)
  })

  it('propagates cancellation into the endpoint request', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const wallet = provider({ eth_chainId: '0x1' })
    const requestWithSignal = vi.fn(
      (_request: ProviderRequest, signal: AbortSignal) => {
        receivedSignal = signal
        return new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    )
    const endpoint = httpProvider({}, requestWithSignal)
    const verification = verifyReadRpcProvider(wallet, 1n, endpoint, {
      signal: controller.signal,
    })

    controller.abort()

    await expect(verification).rejects.toThrow(/cancelled/i)
    expect(receivedSignal?.aborted).toBe(true)
    expect(requestWithSignal).toHaveBeenCalled()
    expect(endpoint.request).not.toHaveBeenCalled()
  })

  it('rejects malformed quantities and mismatched block numbers', async () => {
    await expect(
      verifyReadRpcProvider(
        provider({ ...matchingResponses(), eth_blockNumber: '0x01' }),
        1n,
        httpProvider(matchingResponses()),
      ),
    ).rejects.toThrow(/wallet block number is invalid/i)

    await expect(
      verifyReadRpcProvider(
        provider(matchingResponses()),
        1n,
        httpProvider({
          ...matchingResponses(),
          eth_getBlockByNumber: { hash: BLOCK_HASH, number: '0x57' },
        }),
      ),
    ).rejects.toThrow(/endpoint returned an unexpected block/i)
  })

  it('rejects a wallet context that changed before verification', async () => {
    await expect(
      verifyReadRpcProvider(
        provider({ ...matchingResponses(), eth_chainId: '0x2' }),
        1n,
        httpProvider(matchingResponses()),
      ),
    ).rejects.toThrow(/wallet chain changed during verification/i)
  })

  it('rechecks both chain identifiers after the history proof', async () => {
    let chainReads = 0
    const responses: Partial<Record<string, unknown>> = matchingResponses()
    const wallet: Eip1193Provider = {
      request: vi.fn(async ({ method }: ProviderRequest) => {
        if (method === 'eth_chainId') {
          chainReads += 1
          return chainReads === 1 ? '0x1' : '0x2'
        }
        if (method in responses) return responses[method]
        throw new Error(`Unexpected RPC method: ${method}`)
      }),
    }

    await expect(
      verifyReadRpcProvider(wallet, 1n, httpProvider(responses)),
    ).rejects.toThrow(/chain changed during verification/i)
  })
})
