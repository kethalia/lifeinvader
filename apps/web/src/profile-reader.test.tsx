import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hash } from 'viem'
import type { Eip1193Provider } from './ethereum'
import { DeferredEventCacheCorruptionError } from './event-cache'
import { parseMediaCid } from './media-cid'
import type { ProfileProjectionReader } from './profile-read-model'
import { ProfileReader } from './profile-reader'
import type {
  ProfileProjectionResumeState,
  ProfileProjectionRunSnapshot,
} from './profile-projection-run'
import type { ProfileResumeStore } from './profile-resume-store'
import type {
  ProfileProjectionAnchor,
  ProfileStreamSnapshot,
} from './profile-stream'
import type { ProfileSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

const ACCOUNT = '0x000000000000000000000000000000000000a11c' as Address
const HASH_A = `0x${'aa'.repeat(32)}` as Hash
const HASH_B = `0x${'bb'.repeat(32)}` as Hash
const ANCHOR = { chainId: 1n } as ProfileProjectionAnchor
const RESUME = { marker: 'resume' } as unknown as ProfileProjectionResumeState
const CID = parseMediaCid('QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C')!

const PROFILE: ProfileSet = {
  account: ACCOUNT,
  avatarCid: CID.bytes,
  bio: 'Nothing here is private.',
  blockHash: HASH_A,
  blockNumber: 7n,
  displayName: 'Tracey',
  logIndex: 0,
  transactionHash: HASH_B,
  transactionIndex: 0,
}

function connectedSession(provider: Eip1193Provider): WalletSession {
  return {
    account: ACCOUNT,
    chainId: 1n,
    name: 'Test Wallet',
    provider,
    status: 'connected',
  }
}

function stream(
  projectionAnchor?: ProfileProjectionAnchor,
): ProfileStreamSnapshot {
  return {
    cacheReset: false,
    caughtUp: projectionAnchor !== undefined,
    head: 20n,
    indexedThrough: 8n,
    ...(projectionAnchor ? { projectionAnchor } : {}),
    recentProfiles: [],
    safeHead: 8n,
    scannedRanges: 1,
  }
}

function projection(
  phase: ProfileProjectionRunSnapshot['phase'],
): ProfileProjectionRunSnapshot {
  return {
    chainId: 1n,
    head: 20n,
    logsProcessed: phase === 'complete' ? 1n : 0n,
    pagesScanned: phase === 'profiles' ? 0n : 1n,
    phase,
    profilesRetained: phase === 'profiles' ? 0n : 1n,
    safeHead: 8n,
  }
}

function store(): ProfileResumeStore {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  }
}

function run(
  profile: ProfileSet | undefined,
  snapshot = projection('profiles'),
): ProfileProjectionReader {
  return {
    advance: vi
      .fn()
      .mockResolvedValueOnce(projection('authenticate'))
      .mockResolvedValueOnce(projection('complete')),
    close: vi.fn(),
    getProfile: vi.fn().mockReturnValue(profile),
    resumeState: RESUME,
    snapshot,
  }
}

afterEach(cleanup)

describe('ProfileReader', () => {
  it('stays inert and explains the wallet requirement while disconnected', () => {
    const synchronize = vi.fn()
    render(
      <ProfileReader
        resumeStore={store()}
        session={{ status: 'disconnected' }}
        synchronize={synchronize}
      />,
    )

    expect(screen.getByText(/connect a wallet to reconstruct/i)).toBeTruthy()
    const button = screen.getByRole('button', {
      name: /load confirmed profile/i,
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(synchronize).not.toHaveBeenCalled()
  })

  it('makes incomplete RPC catchup visible and user-stepped', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const synchronize = vi.fn().mockResolvedValue(stream())
    render(
      <ProfileReader
        resumeStore={store()}
        session={connectedSession(provider)}
        synchronize={synchronize}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed profile/i }),
    )

    expect(
      await screen.findByText(/indexed through block 8 of confirmed head 8/i),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /load next profile range/i }),
    ).toBeTruthy()
    expect(synchronize).toHaveBeenCalledTimes(1)
  })

  it('withholds a profile until local pages and the confirmed anchor are authenticated', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const resumeStore = store()
    const projectionRun = run(PROFILE)
    render(
      <ProfileReader
        openProjection={vi.fn().mockResolvedValue(projectionRun)}
        resumeStore={resumeStore}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(stream(ANCHOR))}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed profile/i }),
    )
    const process = await screen.findByRole('button', {
      name: /process next local profile page/i,
    })
    expect(screen.queryByText('Tracey')).toBeNull()
    fireEvent.click(process)

    const authenticate = await screen.findByRole('button', {
      name: /authenticate confirmed profile/i,
    })
    expect(screen.queryByText('Tracey')).toBeNull()
    fireEvent.click(authenticate)

    expect(await screen.findByText('Tracey')).toBeTruthy()
    expect(screen.getByText('Nothing here is private.')).toBeTruthy()
    expect(screen.getByText(CID.text)).toBeTruthy()
    expect(screen.getByText(/exact through confirmed block 8/i)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /check for newer profile/i }),
    ).toBeTruthy()
    await waitFor(() =>
      expect(resumeStore.save).toHaveBeenCalledWith(1n, ACCOUNT, RESUME),
    )
  })

  it('renders an explicit clear snapshot instead of inventing an absent profile', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const cleared = {
      ...PROFILE,
      avatarCid: '0x',
      bio: '',
      displayName: '',
    } satisfies ProfileSet
    render(
      <ProfileReader
        openProjection={vi
          .fn()
          .mockResolvedValue(run(cleared, projection('complete')))}
        resumeStore={store()}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(stream(ANCHOR))}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed profile/i }),
    )

    expect(
      await screen.findByText(/latest snapshot explicitly clears/i),
    ).toBeTruthy()
    expect(screen.getByText(/block 7/i)).toBeTruthy()
    expect(screen.queryByText(/no confirmed profile snapshot/i)).toBeNull()
  })

  it('shows invalid on-chain avatar bytes without attempting to decode media', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    render(
      <ProfileReader
        openProjection={vi
          .fn()
          .mockResolvedValue(
            run({ ...PROFILE, avatarCid: '0x01' }, projection('complete')),
          )}
        resumeStore={store()}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(stream(ANCHOR))}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed profile/i }),
    )

    expect(
      await screen.findByText(/invalid avatar CID bytes committed on-chain/i),
    ).toBeTruthy()
    expect(screen.getByText('0x01')).toBeTruthy()
  })

  it('blocks repeated projection retries when bounded cache cleanup fails', async () => {
    const provider = { request: vi.fn() } as Eip1193Provider
    const projectionRun = run(PROFILE)
    vi.mocked(projectionRun.advance)
      .mockReset()
      .mockRejectedValue(new DeferredEventCacheCorruptionError())
    render(
      <ProfileReader
        openProjection={vi.fn().mockResolvedValue(projectionRun)}
        resetCache={vi.fn().mockRejectedValue(new Error('Repair too large.'))}
        resumeStore={store()}
        session={connectedSession(provider)}
        synchronize={vi.fn().mockResolvedValue(stream(ANCHOR))}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /load confirmed profile/i }),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /process next local profile page/i,
      }),
    )

    const clearData = await screen.findByRole('button', {
      name: /clear site data and reload/i,
    })
    expect((clearData as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/clear this site’s browser data/i)).toBeTruthy()
  })
})
