import { decodeMediaCid } from './media-cid'
import {
  useProfileReadModel,
  type ProfileReadModelState,
  type UseProfileReadModelOptions,
} from './profile-read-model'
import type { ProfileSet } from './protocol-events'
import type { WalletSession } from './wallet-session'

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function profileStatus(state: ProfileReadModelState) {
  if (state.phase === 'idle') {
    return 'Not loaded. Each action reads at most one bounded RPC range or processes one bounded local-cache page.'
  }
  if (state.phase === 'synchronizing') {
    return 'Reading one bounded range of confirmed public profile events…'
  }
  if (state.phase === 'catchup') {
    const indexedThrough = state.stream.indexedThrough?.toString() ?? 'none'
    const reset = state.stream.cacheReset
      ? 'The disposable event cache was reset. '
      : ''
    return `${reset}More confirmed profile history remains. Indexed through block ${indexedThrough} of confirmed head ${state.stream.safeHead?.toString() ?? 'unknown'}.`
  }
  if (state.phase === 'projecting') {
    const resumed = state.resumed ? 'Authenticated saved progress; ' : ''
    return `${resumed}local ${state.projection.phase} projection processed ${state.projection.logsProcessed.toString()} events across ${state.projection.pagesScanned.toString()} bounded pages.`
  }
  if (state.phase === 'complete') {
    const boundary =
      state.projection.safeHead === undefined
        ? 'the currently confirmed empty range'
        : `confirmed block ${state.projection.safeHead.toString()}`
    return `This profile is exact through ${boundary}. ${
      state.resumeSaved
        ? 'Authenticated progress is saved locally for the next delta.'
        : 'The next check may need to rebuild local projection work.'
    }`
  }
  return state.message
}

function profileButtonLabel(state: ProfileReadModelState) {
  if (state.phase === 'synchronizing') return 'Reading profile events…'
  if (state.phase === 'catchup') return 'Load next profile range'
  if (state.phase === 'projecting') {
    if (state.busy) return 'Processing profile page…'
    return state.projection.phase === 'authenticate'
      ? 'Authenticate confirmed profile'
      : 'Process next local profile page'
  }
  if (state.phase === 'complete') return 'Check for newer profile'
  if (state.phase === 'failed') return 'Retry public profile'
  return 'Load confirmed profile'
}

function AvatarCommitment({ profile }: { profile: ProfileSet }) {
  if (profile.avatarCid === '0x') return null
  try {
    const cid = decodeMediaCid(profile.avatarCid)
    return (
      <div className="profile-avatar-commitment">
        <span>IPFS avatar commitment · {cid.codec}</span>
        <code>{cid.text}</code>
        <span>Address only; availability is not guaranteed.</span>
      </div>
    )
  } catch {
    return (
      <div className="profile-avatar-commitment invalid-media-commitment">
        <span>Invalid avatar CID bytes committed on-chain.</span>
        <code>{profile.avatarCid}</code>
      </div>
    )
  }
}

function ConfirmedProfile({ profile }: { profile?: ProfileSet }) {
  if (!profile) {
    return (
      <p className="profile-empty-result">
        No confirmed profile snapshot exists for this account.
      </p>
    )
  }
  const cleared =
    profile.displayName === '' &&
    profile.bio === '' &&
    profile.avatarCid === '0x'
  return (
    <article className="confirmed-profile">
      {cleared ? (
        <p className="profile-empty-result">
          The latest snapshot explicitly clears the derived profile. Earlier
          profile events remain public.
        </p>
      ) : (
        <>
          <strong>{profile.displayName || 'Unnamed public profile'}</strong>
          {profile.bio ? <p>{profile.bio}</p> : null}
          <AvatarCommitment profile={profile} />
        </>
      )}
      <p className="profile-event-meta">
        Block {profile.blockNumber.toString()} ·{' '}
        <code title={profile.transactionHash}>
          {shortValue(profile.transactionHash)}
        </code>
      </p>
    </article>
  )
}

export function ProfileReader({
  openProjection,
  resumeStore,
  session,
  synchronize,
}: UseProfileReadModelOptions & { session: WalletSession }) {
  const model = useProfileReadModel(session, {
    openProjection,
    resumeStore,
    synchronize,
  })
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined &&
    session.account !== undefined
  const disabled =
    !connected ||
    model.state.phase === 'synchronizing' ||
    (model.state.phase === 'projecting' && model.state.busy)
  const runStep = () => {
    if (model.state.phase === 'projecting') {
      model.advanceProjection()
    } else {
      model.loadNextRange()
    }
  }
  const notice =
    model.state.phase === 'projecting' || model.state.phase === 'complete'
      ? model.state.notice
      : undefined
  return (
    <section
      aria-labelledby="confirmed-profile-heading"
      aria-busy={
        model.state.phase === 'synchronizing' ||
        (model.state.phase === 'projecting' && model.state.busy)
      }
      className="profile-reader"
    >
      <h4 id="confirmed-profile-heading">Confirmed public profile</h4>
      <p
        aria-live="polite"
        className="profile-read-status"
        id="profile-read-status"
      >
        {connected
          ? profileStatus(model.state)
          : 'Connect a wallet to reconstruct this account’s public profile.'}
      </p>
      {notice ? (
        <p className="profile-cache-notice" role="status">
          {notice}
        </p>
      ) : null}
      <button
        aria-describedby="profile-read-status"
        disabled={disabled}
        onClick={runStep}
        type="button"
      >
        {profileButtonLabel(model.state)}
      </button>
      {model.state.phase === 'complete' ? (
        <ConfirmedProfile profile={model.state.profile} />
      ) : null}
    </section>
  )
}
