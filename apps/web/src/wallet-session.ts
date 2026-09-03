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
      const accounts = parseAccounts(
        await wallet.provider.request({ method: 'eth_requestAccounts' }),
      )
      const chainId = parseChainId(
        await wallet.provider.request({ method: 'eth_chainId' }),
      )
      const account = accounts[0]

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
      const accounts = parseAccounts(
        await provider.request({ method: 'eth_accounts' }),
      )
      const chainId = parseChainId(
        await provider.request({ method: 'eth_chainId' }),
      )
      const account = accounts[0]

      setSession((current) => ({
        ...current,
        account,
        chainId,
        error: account
          ? undefined
          : 'Select an account in the wallet to continue.',
        status: account ? 'connected' : 'disconnected',
      }))
    } catch (error) {
      setSession((current) => ({
        ...current,
        error: describeRpcError(error, 'Wallet state could not be refreshed.'),
        status: 'disconnected',
      }))
    }
  }, [session.provider])

  useEffect(() => {
    const provider = session.provider
    if (!provider?.on) return

    const handleAccounts = (value: unknown) => {
      try {
        const account = parseAccounts(value)[0]
        setSession((current) => ({
          ...current,
          account,
          error: account ? undefined : 'The wallet disconnected every account.',
          status: account ? 'connected' : 'disconnected',
        }))
      } catch (error) {
        setSession((current) => ({
          ...current,
          error: describeRpcError(
            error,
            'The wallet emitted invalid account data.',
          ),
          status: 'disconnected',
        }))
      }
    }

    const handleChain = (value: unknown) => {
      try {
        const chainId = parseChainId(value)
        setSession((current) => ({ ...current, chainId, error: undefined }))
      } catch (error) {
        setSession((current) => ({
          ...current,
          account: undefined,
          chainId: undefined,
          error: describeRpcError(
            error,
            'The wallet emitted an invalid chain identifier.',
          ),
          status: 'disconnected',
        }))
      }
    }

    const handleDisconnect = () => {
      setSession((current) => ({
        ...current,
        account: undefined,
        error: 'The wallet disconnected.',
        status: 'disconnected',
      }))
    }

    provider.on('accountsChanged', handleAccounts)
    provider.on('chainChanged', handleChain)
    provider.on('disconnect', handleDisconnect)

    return () => {
      provider.removeListener?.('accountsChanged', handleAccounts)
      provider.removeListener?.('chainChanged', handleChain)
      provider.removeListener?.('disconnect', handleDisconnect)
    }
  }, [session.provider])

  return { connect, refresh, session }
}
