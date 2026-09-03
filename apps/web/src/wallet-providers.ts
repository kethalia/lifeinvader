import { useEffect, useSyncExternalStore } from 'react'
import { isEip1193Provider, type Eip1193Provider } from './ethereum'
export type DiscoveredWallet = {
  id: string
  name: string
  provider: Eip1193Provider
}
type RegisteredWallet = DiscoveredWallet & {
  source: 'eip6963' | 'legacy'
}
type Eip6963Announcement = {
  info: {
    name: string
    uuid: string
  }
  provider: Eip1193Provider
}
const EMPTY_WALLETS: readonly DiscoveredWallet[] = []
const listeners = new Set<() => void>()
let wallets: readonly RegisteredWallet[] = []
let publicSnapshot: readonly DiscoveredWallet[] = EMPTY_WALLETS
let nextWalletId = 1
let started = false
let announcementListener: ((event: Event) => void) | undefined
function isAnnouncement(value: unknown): value is Eip6963Announcement {
  if (typeof value !== 'object' || value === null) return false
  if (!('provider' in value) || !isEip1193Provider(value.provider)) return false
  if (
    !('info' in value) ||
    typeof value.info !== 'object' ||
    value.info === null
  ) {
    return false
  }
  return (
    'name' in value.info &&
    typeof value.info.name === 'string' &&
    value.info.name.length <= 1_000 &&
    value.info.name.trim().length > 0 &&
    'uuid' in value.info &&
    typeof value.info.uuid === 'string' &&
    value.info.uuid.length <= 200 &&
    value.info.uuid.length > 0
  )
}
function publishWallets(next: readonly RegisteredWallet[]) {
  wallets = next
  publicSnapshot = next.map(({ id, name, provider }) => ({
    id,
    name,
    provider,
  }))
  listeners.forEach((listener) => listener())
}
function registerWallet(
  provider: Eip1193Provider,
  rawName: string,
  source: RegisteredWallet['source'],
) {
  const name =
    rawName.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Browser wallet'
  const existingIndex = wallets.findIndex(
    (wallet) => wallet.provider === provider,
  )
  if (existingIndex >= 0) {
    const existing = wallets[existingIndex]
    if (!existing || existing.source === 'eip6963' || source === 'legacy')
      return
    const next = [...wallets]
    next[existingIndex] = { ...existing, name, source }
    publishWallets(next)
    return
  }
  publishWallets([
    ...wallets,
    {
      id: `wallet-${nextWalletId++}`,
      name,
      provider,
      source,
    },
  ])
}
function getLegacyProvider(): Eip1193Provider | undefined {
  if (typeof window === 'undefined') return undefined
  const candidate = (window as Window & { ethereum?: unknown }).ethereum
  return isEip1193Provider(candidate) ? candidate : undefined
}
export function startWalletDiscovery() {
  if (started || typeof window === 'undefined') return
  started = true
  announcementListener = (event) => {
    if (!(event instanceof CustomEvent) || !isAnnouncement(event.detail)) return
    registerWallet(event.detail.provider, event.detail.info.name, 'eip6963')
  }
  window.addEventListener('eip6963:announceProvider', announcementListener)
  const legacyProvider = getLegacyProvider()
  if (legacyProvider) registerWallet(legacyProvider, 'Browser wallet', 'legacy')
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function getSnapshot() {
  return publicSnapshot
}
export function useWalletProviders(): readonly DiscoveredWallet[] {
  const availableWallets = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_WALLETS,
  )
  useEffect(startWalletDiscovery, [])
  return availableWallets
}
export function resetWalletDiscoveryForTests() {
  if (announcementListener && typeof window !== 'undefined') {
    window.removeEventListener('eip6963:announceProvider', announcementListener)
  }
  wallets = []
  publicSnapshot = EMPTY_WALLETS
  nextWalletId = 1
  started = false
  announcementListener = undefined
  listeners.forEach((listener) => listener())
}
