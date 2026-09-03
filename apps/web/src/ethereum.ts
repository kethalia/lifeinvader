import { getAddress, isAddress, type Address, type Hash } from 'viem'

export type ProviderRequest = {
  method: string
  params?: readonly unknown[] | object
}

export interface Eip1193Provider {
  request(args: ProviderRequest): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
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
  if (!Array.isArray(value)) {
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
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
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

  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/\s+/g, ' ').trim().slice(0, 240)
  }

  return fallback
}
