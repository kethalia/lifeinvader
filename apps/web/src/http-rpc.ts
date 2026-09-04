import type { Eip1193Provider, ProviderRequest } from './ethereum'

export const HTTP_RPC_REQUEST_TIMEOUT_MS = 15_000
export const MAX_HTTP_RPC_ENDPOINT_LENGTH = 4_096
export const MAX_HTTP_RPC_REQUEST_BYTES = 64 * 1024
export const MAX_HTTP_RPC_RESPONSE_BYTES = 64 * 1024 * 1024
export const MAX_HTTP_RPC_CONCURRENT_REQUESTS = 4
export const MAX_HTTP_RPC_OUTSTANDING_REQUESTS = 32

const READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getTransactionReceipt',
])

export type HttpRpcEndpoint = {
  readonly origin: string
  readonly url: string
}

export type HttpRpcProvider = Eip1193Provider & {
  close(): void
  readonly endpoint: HttpRpcEndpoint
}

export type HttpRpcProviderOptions = {
  fetcher?: typeof fetch
  maximumResponseBytes?: number
  maxConcurrentRequests?: number
  maxOutstandingRequests?: number
  timeoutMs?: number
}

type PendingRequest = {
  body: string
  controller?: AbortController
  deadline: number
  handleAbort?: () => void
  id: number
  reject(error: unknown): void
  resolve(value: unknown): void
  settled: boolean
  signal?: AbortSignal
  timeout?: ReturnType<typeof setTimeout>
}

export class HttpRpcResponseError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'HttpRpcResponseError'
    this.code = code
    this.data = data
  }
}

function invalidEndpoint(reason: string, options?: ErrorOptions) {
  return new Error(`Cannot use RPC endpoint: ${reason}`, options)
}

function rpcFailure(reason: string, options?: ErrorOptions) {
  return new Error(`HTTP RPC request failed: ${reason}`, options)
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  )
}

export function parseHttpRpcEndpoint(input: string): HttpRpcEndpoint {
  if (input.length > MAX_HTTP_RPC_ENDPOINT_LENGTH) {
    throw invalidEndpoint('the URL is too long.')
  }
  const candidate = input.trim()
  if (candidate === '') throw invalidEndpoint('enter an endpoint URL.')
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    throw invalidEndpoint('control characters are not allowed.')
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch (cause) {
    throw invalidEndpoint('the URL is invalid.', { cause })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidEndpoint('use an HTTPS URL.')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw invalidEndpoint('use HTTPS except for a loopback development node.')
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidEndpoint('URL credentials are not allowed.')
  }
  if (url.hash !== '') {
    throw invalidEndpoint('URL fragments are not sent to RPC servers.')
  }

  return Object.freeze({ origin: url.origin, url: url.href })
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new Error(`The HTTP RPC ${label} is invalid.`)
  }
  return selected
}

function encodeRequest(request: ProviderRequest, id: number) {
  const method = request.method
  const params = request.params
  if (typeof method !== 'string' || !READ_METHODS.has(method)) {
    throw new Error('HTTP RPC transport refuses non-read method.')
  }
  if (params !== undefined && (typeof params !== 'object' || params === null)) {
    throw new Error('HTTP RPC request parameters are invalid.')
  }

  let body: string
  try {
    body = JSON.stringify({
      id,
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  } catch (cause) {
    throw rpcFailure('the request could not be encoded.', { cause })
  }
  if (new TextEncoder().encode(body).byteLength > MAX_HTTP_RPC_REQUEST_BYTES) {
    throw rpcFailure('the encoded request exceeds the local byte limit.')
  }
  return body
}

function readContentLength(response: Response, maximumBytes: number) {
  const value = response.headers.get('content-length')
  if (value === null) return
  if (!/^[0-9]+$/.test(value)) {
    throw rpcFailure('the server returned an invalid content length.')
  }
  if (BigInt(value) > BigInt(maximumBytes)) {
    throw rpcFailure(
      `the response exceeds the ${maximumBytes.toString()}-byte limit.`,
    )
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  abort: () => void,
) {
  if (!response.body) throw rpcFailure('the response has no readable body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (
        !ArrayBuffer.isView(chunk.value) ||
        chunk.value.BYTES_PER_ELEMENT !== 1
      ) {
        throw rpcFailure('the server returned malformed response bytes.')
      }
      const nextTotal = total + chunk.value.byteLength
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maximumBytes) {
        throw rpcFailure(
          `the response exceeds the ${maximumBytes.toString()}-byte limit.`,
        )
      }
      chunks.push(chunk.value)
      total = nextTotal
    }
  } catch (error) {
    abort()
    void reader.cancel().catch(() => undefined)
    throw error
  }
  if (total === 0) throw rpcFailure('the server returned an empty response.')

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decodeResponse(bytes: Uint8Array, id: number) {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw rpcFailure('the server returned invalid JSON.', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw rpcFailure('the server returned an invalid JSON-RPC envelope.')
  }
  const envelope = value as Record<string, unknown>
  if (envelope.jsonrpc !== '2.0' || envelope.id !== id) {
    throw rpcFailure('the server returned a mismatched JSON-RPC response.')
  }
  const hasResult = Object.hasOwn(envelope, 'result')
  const hasError = Object.hasOwn(envelope, 'error')
  if (hasResult === hasError) {
    throw rpcFailure('the server returned an ambiguous JSON-RPC response.')
  }
  if (hasResult) return envelope.result

  const error = envelope.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    throw rpcFailure('the server returned an invalid JSON-RPC error.')
  }
  const details = error as Record<string, unknown>
  if (
    !Number.isSafeInteger(details.code) ||
    typeof details.message !== 'string'
  ) {
    throw rpcFailure('the server returned an invalid JSON-RPC error.')
  }
  const message =
    details.message.replace(/\s+/g, ' ').trim().slice(0, 240) ||
    'The RPC server rejected the request.'
  throw new HttpRpcResponseError(details.code as number, message, details.data)
}

export function createHttpRpcProvider(
  endpointInput: string,
  options: HttpRpcProviderOptions = {},
): HttpRpcProvider {
  const endpoint = parseHttpRpcEndpoint(endpointInput)
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    HTTP_RPC_REQUEST_TIMEOUT_MS,
    60_000,
    'timeout',
  )
  const maximumResponseBytes = positiveInteger(
    options.maximumResponseBytes,
    MAX_HTTP_RPC_RESPONSE_BYTES,
    MAX_HTTP_RPC_RESPONSE_BYTES,
    'response byte limit',
  )
  const maxConcurrentRequests = positiveInteger(
    options.maxConcurrentRequests,
    MAX_HTTP_RPC_CONCURRENT_REQUESTS,
    MAX_HTTP_RPC_CONCURRENT_REQUESTS,
    'concurrency limit',
  )
  const maxOutstandingRequests = positiveInteger(
    options.maxOutstandingRequests,
    MAX_HTTP_RPC_OUTSTANDING_REQUESTS,
    MAX_HTTP_RPC_OUTSTANDING_REQUESTS,
    'queue limit',
  )
  if (maxOutstandingRequests < maxConcurrentRequests) {
    throw new Error('The HTTP RPC queue limit is below its concurrency limit.')
  }

  let active = 0
  let closed = false
  let nextId = 1
  const queued: PendingRequest[] = []
  const running = new Set<PendingRequest>()

  const settle = (
    pending: PendingRequest,
    outcome: { error: unknown } | { value: unknown },
  ) => {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timeout)
    if (pending.handleAbort) {
      pending.signal?.removeEventListener('abort', pending.handleAbort)
    }
    if ('error' in outcome) pending.reject(outcome.error)
    else pending.resolve(outcome.value)
  }

  const removeQueued = (pending: PendingRequest) => {
    const index = queued.indexOf(pending)
    if (index >= 0) queued.splice(index, 1)
  }

  const interrupt = (
    pending: PendingRequest,
    error: Error,
    reason?: unknown,
  ) => {
    if (pending.settled) return
    pending.controller?.abort(reason)
    settle(pending, { error })
    if (!running.has(pending)) {
      removeQueued(pending)
      pump()
    }
  }

  const pump = () => {
    while (!closed && active < maxConcurrentRequests) {
      const pending = queued.shift()
      if (!pending) return
      if (pending.settled) continue
      if (Date.now() >= pending.deadline) {
        settle(pending, { error: new Error('HTTP RPC request timed out.') })
        continue
      }
      active += 1
      running.add(pending)
      const controller = new AbortController()
      pending.controller = controller
      void (async () => {
        try {
          const response = await fetcher(endpoint.url, {
            body: pending.body,
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
            signal: controller.signal,
          })
          if (pending.settled) {
            controller.abort()
            void response.body?.cancel().catch(() => undefined)
            return
          }
          if (!response.ok) {
            controller.abort()
            void response.body?.cancel().catch(() => undefined)
            throw rpcFailure(`the server returned HTTP ${response.status}.`)
          }
          try {
            readContentLength(response, maximumResponseBytes)
          } catch (error) {
            controller.abort()
            void response.body?.cancel().catch(() => undefined)
            throw error
          }
          const bytes = await readBoundedResponse(
            response,
            maximumResponseBytes,
            () => controller.abort(),
          )
          if (!pending.settled) {
            settle(pending, { value: decodeResponse(bytes, pending.id) })
          }
        } catch (error) {
          if (!pending.settled) {
            settle(pending, {
              error:
                error instanceof Error &&
                (error.message.startsWith('HTTP RPC request failed:') ||
                  error instanceof HttpRpcResponseError)
                  ? error
                  : rpcFailure('the network request did not complete.', {
                      cause: error instanceof Error ? error : undefined,
                    }),
            })
          }
        } finally {
          running.delete(pending)
          active -= 1
          pump()
        }
      })()
    }
  }

  const schedule = (request: ProviderRequest, signal?: AbortSignal) => {
    if (signal?.aborted) {
      return Promise.reject(new Error('HTTP RPC request was cancelled.'))
    }
    if (closed) {
      return Promise.reject(new Error('The HTTP RPC transport was closed.'))
    }
    const id = nextId
    nextId += 1
    let body: string
    try {
      body = encodeRequest(request, id)
    } catch (error) {
      return Promise.reject(error)
    }
    if (queued.length + running.size >= maxOutstandingRequests) {
      return Promise.reject(
        new Error(
          'The HTTP RPC transport is busy. Wait for a bounded request to finish.',
        ),
      )
    }
    const deadline = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        body,
        deadline,
        id,
        reject,
        resolve,
        settled: false,
        signal,
      }
      pending.timeout = setTimeout(
        () =>
          interrupt(
            pending,
            new Error('HTTP RPC request timed out.'),
            'deadline',
          ),
        Math.max(0, deadline - Date.now()),
      )
      queued.push(pending)
      if (signal) {
        pending.handleAbort = () =>
          interrupt(
            pending,
            new Error('HTTP RPC request was cancelled.'),
            signal.reason,
          )
        signal.addEventListener('abort', pending.handleAbort, { once: true })
        if (signal.aborted) pending.handleAbort()
      }
      pump()
    })
  }

  const provider: HttpRpcProvider = {
    close() {
      if (closed) return
      closed = true
      const error = new Error('The HTTP RPC transport was closed.')
      for (const pending of queued.splice(0)) {
        settle(pending, { error })
      }
      for (const pending of running) {
        pending.controller?.abort()
        settle(pending, { error })
      }
    },
    endpoint,
    request(request) {
      return schedule(request)
    },
    requestWithSignal(request, signal) {
      return schedule(request, signal)
    },
  }

  return Object.freeze(provider)
}
