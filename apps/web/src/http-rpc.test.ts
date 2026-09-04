import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHttpRpcProvider,
  HttpRpcResponseError,
  parseHttpRpcEndpoint,
} from './http-rpc'

function requestId(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { id: number }).id
}

function rpcResponse(
  init: RequestInit | undefined,
  payload: { error?: unknown; result?: unknown },
  options: { contentLength?: string; status?: number } = {},
) {
  const body = JSON.stringify({
    id: requestId(init),
    jsonrpc: '2.0',
    ...payload,
  })
  return new Response(body, {
    headers: {
      'content-length': options.contentLength ?? String(body.length),
      'content-type': 'application/json',
    },
    status: options.status ?? 200,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HTTP RPC endpoint parsing', () => {
  it('accepts HTTPS and explicit loopback development URLs', () => {
    expect(parseHttpRpcEndpoint(' https://rpc.example/v1?key=public ')).toEqual(
      {
        origin: 'https://rpc.example',
        url: 'https://rpc.example/v1?key=public',
      },
    )
    expect(parseHttpRpcEndpoint('http://127.0.0.1:8545')).toEqual({
      origin: 'http://127.0.0.1:8545',
      url: 'http://127.0.0.1:8545/',
    })
    expect(parseHttpRpcEndpoint('http://localhost:8545/rpc').url).toBe(
      'http://localhost:8545/rpc',
    )
    expect(parseHttpRpcEndpoint('http://[::1]:8545').origin).toBe(
      'http://[::1]:8545',
    )
    expect(Object.isFrozen(parseHttpRpcEndpoint('https://rpc.example'))).toBe(
      true,
    )
  })

  it.each([
    ['', /enter an endpoint/i],
    ['not a URL', /URL is invalid/i],
    ['ftp://rpc.example', /use an HTTPS URL/i],
    ['http://rpc.example', /HTTPS except for a loopback/i],
    ['https://user:secret@rpc.example', /credentials/i],
    ['https://rpc.example/#secret', /fragments/i],
    ['https://rpc.example/\nheader', /control characters/i],
  ])('rejects unsafe endpoint %s', (endpoint, message) => {
    expect(() => parseHttpRpcEndpoint(endpoint)).toThrow(message)
  })
})

describe('bounded HTTP RPC provider', () => {
  it('sends an isolated JSON-RPC POST and returns only its matching result', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        rpcResponse(init, { result: '0x123' }),
    )
    const provider = createHttpRpcProvider('https://rpc.example/v1', {
      fetcher,
    })

    await expect(
      provider.request({
        method: 'eth_getBlockByNumber',
        params: ['0x123', false],
      }),
    ).resolves.toBe('0x123')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://rpc.example/v1')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      method: 'POST',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(Object.isFrozen(provider)).toBe(true)
    expect(Object.isFrozen(provider.endpoint)).toBe(true)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_getBlockByNumber',
      params: ['0x123', false],
    })
    provider.close()
  })

  it.each([
    'eth_accounts',
    'eth_requestAccounts',
    'eth_sendTransaction',
    'wallet_switchEthereumChain',
    'personal_sign',
  ])(
    'refuses wallet method %s without contacting the endpoint',
    async (method) => {
      const fetcher = vi.fn()
      const provider = createHttpRpcProvider('https://rpc.example', { fetcher })

      await expect(provider.request({ method })).rejects.toThrow(
        /refuses non-read method/i,
      )
      expect(fetcher).not.toHaveBeenCalled()
      provider.close()
    },
  )

  it('rejects malformed or oversized request parameters before fetching', async () => {
    const fetcher = vi.fn()
    const provider = createHttpRpcProvider('https://rpc.example', { fetcher })

    await expect(
      provider.request({
        method: 'eth_call',
        params: 1 as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/parameters are invalid/i)
    await expect(
      provider.request({
        method: 'eth_call',
        params: [{ data: `0x${'00'.repeat(64 * 1024)}` }],
      }),
    ).rejects.toThrow(/encoded request exceeds/i)
    expect(fetcher).not.toHaveBeenCalled()
    provider.close()
  })

  it('returns standards-shaped RPC errors without losing their numeric code', async () => {
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher: vi.fn(async (_input, init) =>
        rpcResponse(init, {
          error: {
            code: -32005,
            data: { limit: 1_000 },
            message: '  range   too large  ',
          },
        }),
      ),
    })

    const error = await provider
      .request({ method: 'eth_getLogs', params: [{}] })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(HttpRpcResponseError)
    expect(error).toMatchObject({
      code: -32005,
      data: { limit: 1_000 },
      message: 'range too large',
    })
    provider.close()
  })

  it.each([
    [{ jsonrpc: '2.0', id: 999, result: '0x1' }, /mismatched/i],
    [{ jsonrpc: '1.0', id: 1, result: '0x1' }, /mismatched/i],
    [{ jsonrpc: '2.0', id: 1 }, /ambiguous/i],
    [{ jsonrpc: '2.0', id: 1, result: '0x1', error: null }, /ambiguous/i],
    [{ jsonrpc: '2.0', id: 1, error: 'nope' }, /invalid JSON-RPC error/i],
    [[], /invalid JSON-RPC envelope/i],
  ] as const)(
    'rejects malformed JSON-RPC envelope %#',
    async (body, message) => {
      const provider = createHttpRpcProvider('https://rpc.example', {
        fetcher: vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              headers: { 'content-type': 'application/json' },
            }),
        ),
      })

      await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
        message,
      )
      provider.close()
    },
  )

  it('rejects invalid JSON and invalid UTF-8', async () => {
    const responses = [
      new Response('{'),
      new Response(new Uint8Array([0xc3, 0x28])),
    ]
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher: vi.fn(async () => responses.shift()!),
    })

    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /invalid JSON/i,
    )
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /invalid JSON/i,
    )
    provider.close()
  })

  it('cancels HTTP failures and responses rejected by their declared size', async () => {
    const httpCancel = vi.fn()
    const sizeCancel = vi.fn()
    const malformedLengthCancel = vi.fn()
    const responses = [
      {
        body: new ReadableStream({ cancel: httpCancel }),
        headers: new Headers(),
        ok: false,
        status: 503,
      },
      {
        body: new ReadableStream({ cancel: sizeCancel }),
        headers: new Headers({ 'content-length': '5' }),
        ok: true,
        status: 200,
      },
      {
        body: new ReadableStream({ cancel: malformedLengthCancel }),
        headers: new Headers({ 'content-length': 'many' }),
        ok: true,
        status: 200,
      },
    ] as Response[]
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher: vi.fn(async () => responses.shift()!),
      maximumResponseBytes: 4,
    })

    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /HTTP 503/i,
    )
    expect(httpCancel).toHaveBeenCalledTimes(1)
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /exceeds the 4-byte limit/i,
    )
    expect(sizeCancel).toHaveBeenCalledTimes(1)
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /invalid content length/i,
    )
    expect(malformedLengthCancel).toHaveBeenCalledTimes(1)
    provider.close()
  })

  it('cancels a streaming response as soon as it crosses the byte limit', async () => {
    const cancel = vi.fn()
    const response = {
      body: new ReadableStream<Uint8Array>({
        cancel,
        start(controller) {
          controller.enqueue(new Uint8Array(5))
        },
      }),
      headers: new Headers(),
      ok: true,
      status: 200,
    } as Response
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher: vi.fn(async () => response),
      maximumResponseBytes: 4,
    })

    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /exceeds the 4-byte limit/i,
    )
    expect(cancel).toHaveBeenCalledTimes(1)
    provider.close()
  })

  it('bounds active work and rejects requests beyond the finite queue', async () => {
    const pending: Array<{
      init?: RequestInit
      resolve(response: Response): void
    }> = []
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => pending.push({ init, resolve })),
    )
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher,
      maxConcurrentRequests: 2,
      maxOutstandingRequests: 3,
    })
    const first = provider.request({ method: 'eth_chainId' })
    const second = provider.request({ method: 'eth_blockNumber' })
    const third = provider.request({ method: 'eth_getCode', params: [] })

    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(
      provider.request({ method: 'eth_getLogs', params: [{}] }),
    ).rejects.toThrow(/transport is busy/i)

    pending[0]!.resolve(rpcResponse(pending[0]!.init, { result: '0x1' }))
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3))
    pending[1]!.resolve(rpcResponse(pending[1]!.init, { result: '0x2' }))
    pending[2]!.resolve(rpcResponse(pending[2]!.init, { result: '0x3' }))
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      '0x1',
      '0x2',
      '0x3',
    ])
    provider.close()
  })

  it('times out and aborts a stalled network request', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher,
      timeoutMs: 25,
    })
    const request = provider.request({ method: 'eth_chainId' })
    const expectation = expect(request).rejects.toThrow(/request timed out/i)

    await vi.advanceTimersByTimeAsync(25)

    await expectation
    expect(requestSignal?.aborted).toBe(true)
    provider.close()
  })

  it('closes active and queued work and refuses later requests', async () => {
    let requestSignal: AbortSignal | undefined
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>(() => {
          requestSignal = init?.signal ?? undefined
        }),
    )
    const provider = createHttpRpcProvider('https://rpc.example', {
      fetcher,
      maxConcurrentRequests: 1,
      maxOutstandingRequests: 2,
    })
    const active = provider.request({ method: 'eth_chainId' })
    const queued = provider.request({ method: 'eth_blockNumber' })
    const activeExpectation = expect(active).rejects.toThrow(/was closed/i)
    const queuedExpectation = expect(queued).rejects.toThrow(/was closed/i)

    provider.close()

    await activeExpectation
    await queuedExpectation
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /was closed/i,
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(requestSignal?.aborted).toBe(true)
  })

  it('rejects unsafe construction limits', () => {
    expect(() =>
      createHttpRpcProvider('https://rpc.example', {
        maxConcurrentRequests: 0,
      }),
    ).toThrow(/concurrency limit is invalid/i)
    expect(() =>
      createHttpRpcProvider('https://rpc.example', {
        maxConcurrentRequests: 2,
        maxOutstandingRequests: 1,
      }),
    ).toThrow(/queue limit is below/i)
    expect(() =>
      createHttpRpcProvider('https://rpc.example', {
        maximumResponseBytes: 64 * 1024 * 1024 + 1,
      }),
    ).toThrow(/response byte limit is invalid/i)
  })
})
