import { useState, type FormEvent } from 'react'
import {
  getUtf8ByteLength,
  MAX_PROFILE_BIO_BYTES,
  MAX_PROFILE_DISPLAY_NAME_BYTES,
  type ProfilePayload,
} from './protocol'
import { MAX_MEDIA_CID_TEXT_LENGTH, parseMediaCid } from './media-cid'

export function ProfileComposer({
  disabled,
  onSubmit,
  publishing,
}: {
  disabled: boolean
  onSubmit(payload: ProfilePayload): void
  publishing: boolean
}) {
  const [avatarCidInput, setAvatarCidInput] = useState('')
  const [bio, setBio] = useState('')
  const [clearConfirmed, setClearConfirmed] = useState(false)
  const [displayName, setDisplayName] = useState('')
  let parsedAvatarCid: ReturnType<typeof parseMediaCid>
  let avatarCidError: string | undefined
  try {
    parsedAvatarCid = parseMediaCid(avatarCidInput)
  } catch (error) {
    avatarCidError =
      error instanceof Error ? error.message : 'The avatar CID is invalid.'
  }
  const bioBytes = getUtf8ByteLength(bio)
  const displayNameBytes = getUtf8ByteLength(displayName)
  const clearsProfile =
    bioBytes === 0 && displayNameBytes === 0 && avatarCidInput.length === 0
  const invalid =
    avatarCidError !== undefined ||
    displayNameBytes > MAX_PROFILE_DISPLAY_NAME_BYTES ||
    bioBytes > MAX_PROFILE_BIO_BYTES ||
    (clearsProfile && !clearConfirmed)
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || invalid) return
    onSubmit({
      avatarCid: parsedAvatarCid?.bytes ?? '0x',
      bio,
      displayName,
    })
    if (clearsProfile) setClearConfirmed(false)
  }
  return (
    <form onSubmit={handleSubmit}>
      <p className="input-help profile-snapshot-warning">
        Every submission appends the complete public profile. Blank fields
        replace earlier values; history remains visible.
      </p>
      <label htmlFor="profile-display-name">Display name</label>
      <input
        id="profile-display-name"
        aria-describedby="profile-display-name-help"
        aria-invalid={
          displayNameBytes > MAX_PROFILE_DISPLAY_NAME_BYTES ? true : undefined
        }
        disabled={disabled}
        maxLength={MAX_PROFILE_DISPLAY_NAME_BYTES}
        onChange={(event) => {
          setClearConfirmed(false)
          setDisplayName(event.target.value)
        }}
        placeholder="Publicly traded personality"
        type="text"
        value={displayName}
      />
      <p
        className={
          displayNameBytes > MAX_PROFILE_DISPLAY_NAME_BYTES
            ? 'input-help limit-exceeded'
            : 'input-help'
        }
        id="profile-display-name-help"
      >
        {displayNameBytes} / {MAX_PROFILE_DISPLAY_NAME_BYTES} UTF-8 bytes
      </p>
      <label htmlFor="profile-bio">Bio</label>
      <textarea
        id="profile-bio"
        aria-describedby="profile-bio-help"
        aria-invalid={bioBytes > MAX_PROFILE_BIO_BYTES ? true : undefined}
        disabled={disabled}
        maxLength={MAX_PROFILE_BIO_BYTES}
        onChange={(event) => {
          setBio(event.target.value)
          setClearConfirmed(false)
        }}
        placeholder="Disclose your personal brand to every node."
        rows={4}
        value={bio}
      />
      <p
        className={
          bioBytes > MAX_PROFILE_BIO_BYTES
            ? 'input-help limit-exceeded'
            : 'input-help'
        }
        id="profile-bio-help"
      >
        {bioBytes} / {MAX_PROFILE_BIO_BYTES} UTF-8 bytes
      </p>
      <label htmlFor="profile-avatar-cid">
        IPFS avatar CID (already uploaded, optional)
      </label>
      <input
        id="profile-avatar-cid"
        aria-describedby="profile-avatar-cid-help"
        aria-invalid={avatarCidError ? true : undefined}
        disabled={disabled}
        maxLength={MAX_MEDIA_CID_TEXT_LENGTH}
        onChange={(event) => {
          setAvatarCidInput(event.target.value)
          setClearConfirmed(false)
        }}
        placeholder="bafy… or Qm…"
        type="text"
        value={avatarCidInput}
      />
      <p
        className={avatarCidError ? 'input-help error-message' : 'input-help'}
        id="profile-avatar-cid-help"
      >
        {avatarCidError ??
          (parsedAvatarCid
            ? `Will commit canonical CIDv1 bytes (${parsedAvatarCid.codec}).`
            : 'This records an address only. It does not upload or guarantee storage.')}
      </p>
      {clearsProfile ? (
        <label className="profile-clear-confirmation">
          <input
            checked={clearConfirmed}
            disabled={disabled}
            onChange={(event) => setClearConfirmed(event.target.checked)}
            type="checkbox"
          />
          I understand this appends an empty profile snapshot; it does not erase
          history.
        </label>
      ) : null}
      <button
        className="button-accent"
        type="submit"
        disabled={disabled || invalid}
      >
        {publishing
          ? 'Publishing profile…'
          : clearsProfile
            ? 'Publish empty profile snapshot'
            : 'Publish profile on-chain'}
      </button>
    </form>
  )
}
