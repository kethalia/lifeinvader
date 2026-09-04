import { getAddress, isAddress, type Address, type Hash } from 'viem'
export type ProviderRequest = {
  method: string
  params?: readonly unknown[] | object
}
export interface Eip1193Provider {
  request(args: ProviderRequest): Promise<unknown>
  requestWithSignal?(
    args: ProviderRequest,
    signal: AbortSignal,
  ): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}
export function requestProvider(
  provider: Eip1193Provider,
  request: ProviderRequest,
  signal?: AbortSignal,
) {
  return signal && provider.requestWithSignal
    ? provider.requestWithSignal(request, signal)
    : provider.request(request)
}
export const WALLET_READ_TIMEOUT_MS = 15_000
export async function beforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  timeoutError: () => Error,
  signal?: AbortSignal,
  cancellationError: () => Error = () => new Error('Operation was cancelled.'),
): Promise<T> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw timeoutError()
  if (signal?.aborted) throw cancellationError()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let handleAbort: (() => void) | undefined
  try {
    const pending: Promise<T>[] = [
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(timeoutError()), remainingMs)
      }),
    ]
    if (signal) {
      pending.push(
        new Promise<never>((_resolve, reject) => {
          handleAbort = () => reject(cancellationError())
          signal.addEventListener('abort', handleAbort, { once: true })
        }),
      )
    }
    pending.push(operation())
    return await Promise.race(pending)
  } finally {
    clearTimeout(timeout)
    if (handleAbort) signal?.removeEventListener('abort', handleAbort)
  }
}
export async function requestProviderBeforeDeadline(
  provider: Eip1193Provider,
  request: ProviderRequest,
  deadline: number,
  timeoutError: () => Error,
  signal?: AbortSignal,
  cancellationError: () => Error = () => new Error('Operation was cancelled.'),
) {
  const controller = new AbortController()
  let relayAbort: (() => void) | undefined
  try {
    return await beforeDeadline(
      () => {
        if (signal) {
          relayAbort = () => controller.abort(signal.reason)
          signal.addEventListener('abort', relayAbort, { once: true })
          if (signal.aborted) controller.abort(signal.reason)
        }
        return requestProvider(provider, request, controller.signal)
      },
      deadline,
      timeoutError,
      signal,
      cancellationError,
    )
  } finally {
    controller.abort()
    if (relayAbort) signal?.removeEventListener('abort', relayAbort)
  }
}
export function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'request' in value &&
    typeof value.request === 'function'
  )
}
export function parseAccounts(value: unknown): readonly Address[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error('The wallet returned an invalid account list.')
  }
  return value.map((account) => {
    if (typeof account !== 'string' || !isAddress(account)) {
      throw new Error('The wallet returned an invalid account address.')
    }
    return getAddress(account)
  })
}
export function parseChainId(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x[0-9a-f]+$/i.test(value)
  ) {
    throw new Error('The wallet returned an invalid chain identifier.')
  }
  return BigInt(value)
}
export function parseTransactionHash(value: unknown): Hash {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error('The wallet returned an invalid transaction hash.')
  }
  return value as Hash
}
export function getRpcErrorCode(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
  ) {
    return error.code
  }
  return undefined
}
export function describeRpcError(error: unknown, fallback: string): string {
  const code = getRpcErrorCode(error)
  if (code === 4001) return 'The wallet request was rejected.'
  if (code === -32002)
    return 'That wallet already has a request waiting for approval.'
  if (error instanceof Error && error.message.length > 0) {
    return (
      error.message.slice(0, 1_000).replace(/\s+/g, ' ').trim().slice(0, 240) ||
      fallback
    )
  }
  return fallback
}
