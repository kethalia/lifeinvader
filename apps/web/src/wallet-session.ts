import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'

import {
  describeRpcError,
  parseAccounts,
  parseChainId,
  type Eip1193Provider,
} from './ethereum'
import type { DiscoveredWallet } from './wallet-providers'

export type WalletSession = {
  account?: Address
  chainId?: bigint
  error?: string
  name?: string
  provider?: Eip1193Provider
  status: 'disconnected' | 'connecting' | 'connected'
}

const INITIAL_SESSION: WalletSession = { status: 'disconnected' }

async function readConnection(provider: Eip1193Provider) {
  let revision = 0
  const trackChange = () => {
    revision += 1
  }
  provider.on?.('accountsChanged', trackChange)
  provider.on?.('chainChanged', trackChange)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshotRevision = revision
      const [accountsValue, chainIdValue] = await Promise.all([
        provider.request({ method: 'eth_accounts' }),
        provider.request({ method: 'eth_chainId' }),
      ])
      if (snapshotRevision === revision) {
        return {
          account: parseAccounts(accountsValue)[0],
          chainId: parseChainId(chainIdValue),
        }
      }
    }
    throw new Error('Wallet state kept changing. Try again.')
  } finally {
    provider.removeListener?.('accountsChanged', trackChange)
    provider.removeListener?.('chainChanged', trackChange)
  }
}

export function useWalletSession() {
  const [session, setSession] = useState<WalletSession>(INITIAL_SESSION)
  const requestSequence = useRef(0)

  const connect = useCallback(async (wallet: DiscoveredWallet) => {
    const requestId = ++requestSequence.current
    setSession({
      name: wallet.name,
      provider: wallet.provider,
      status: 'connecting',
    })

    try {
      await wallet.provider.request({ method: 'eth_requestAccounts' })
      const { account, chainId } = await readConnection(wallet.provider)
      if (!account)
        throw new Error('Select an account in the wallet to continue.')
      if (requestId !== requestSequence.current) return
      setSession({
        account,
        chainId,
        name: wallet.name,
        provider: wallet.provider,
        status: 'connected',
      })
    } catch (error) {
      if (requestId !== requestSequence.current) return
      setSession({
        error: describeRpcError(error, 'The wallet could not be connected.'),
        name: wallet.name,
        provider: wallet.provider,
        status: 'disconnected',
      })
    }
  }, [])

  const refresh = useCallback(async () => {
    const provider = session.provider
    if (!provider) return

    try {
      const { account, chainId } = await readConnection(provider)

      setSession((current) =>
        current.provider === provider
          ? {
              ...current,
              account,
              chainId,
              error: account
                ? undefined
                : 'Select an account in the wallet to continue.',
              status: account ? 'connected' : 'disconnected',
            }
          : current,
      )
    } catch (error) {
      setSession((current) =>
        current.provider === provider
          ? {
              ...current,
              error: describeRpcError(
                error,
                'Wallet state could not be refreshed.',
              ),
              status: 'disconnected',
            }
          : current,
      )
    }
  }, [session.provider])

  useEffect(() => {
    const provider = session.provider
    if (!provider?.on) return
    const update = (changes: Partial<WalletSession>) =>
      setSession((current) =>
        current.provider === provider ? { ...current, ...changes } : current,
      )

    const handleAccounts = (value: unknown) => {
      try {
        const account = parseAccounts(value)[0]
        update({
          account: undefined,
          error: account ? undefined : 'The wallet disconnected every account.',
          status: 'disconnected',
        })
        if (account) void refresh()
      } catch (error) {
        update({
          account: undefined,
          error: describeRpcError(
            error,
            'The wallet emitted invalid account data.',
          ),
          status: 'disconnected',
        })
      }
    }

    const handleChain = (value: unknown) => {
      try {
        const chainId = parseChainId(value)
        update({ chainId, error: undefined })
      } catch (error) {
        update({
          account: undefined,
          chainId: undefined,
          error: describeRpcError(
            error,
            'The wallet emitted an invalid chain identifier.',
          ),
          status: 'disconnected',
        })
      }
    }

    const handleDisconnect = () => {
      update({
        account: undefined,
        chainId: undefined,
        error: 'The wallet disconnected.',
        status: 'disconnected',
      })
    }

    provider.on('accountsChanged', handleAccounts)
    provider.on('chainChanged', handleChain)
    provider.on('disconnect', handleDisconnect)

    return () => {
      provider.removeListener?.('accountsChanged', handleAccounts)
      provider.removeListener?.('chainChanged', handleChain)
      provider.removeListener?.('disconnect', handleDisconnect)
    }
  }, [refresh, session.provider])

  return { connect, refresh, session }
}
