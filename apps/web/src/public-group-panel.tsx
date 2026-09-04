import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Address } from 'viem'
import { describeRpcError, type Eip1193Provider } from './ethereum'
import { GroupTransactionConsole } from './group-transaction-console'
import { parseGroupIdInput } from './group-id'
import {
  synchronizeGroupDirectory,
  type GroupDirectorySnapshot,
  type GroupDirectorySynchronizer,
} from './group-directory'
import {
  useGroupMembershipReadModel,
  type GroupMembershipReadModelState,
  type UseGroupMembershipReadModelOptions,
} from './group-membership-read-model'
import { decodeMediaCid } from './media-cid'
import type { PublishedGroup } from './protocol-events'
import { PublicGroupMessagePanel } from './public-group-message-panel'
import type { WalletSession } from './wallet-session'

const MEMBER_PAGE_SIZE = 25

type GroupDirectoryState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'partial'; snapshot: GroupDirectorySnapshot }
  | { phase: 'complete'; snapshot: GroupDirectorySnapshot }
  | { message: string; phase: 'failed' }

type ScopedDirectoryState = {
  chainId: bigint
  provider: Eip1193Provider
  state: GroupDirectoryState
}

type ScopedGroupSelection = {
  chainId: bigint
  groupId: bigint
  provider: Eip1193Provider
}

const IDLE_DIRECTORY = { phase: 'idle' } as const

function shortValue(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function directoryStatus(state: GroupDirectoryState) {
  if (state.phase === 'idle') {
    return 'Not loaded. Each action reads at most one bounded RPC log range.'
  }
  if (state.phase === 'loading') {
    return 'Reading one bounded range of confirmed public groups…'
  }
  if (state.phase === 'partial') {
    const reset = state.snapshot.cacheReset
      ? 'The disposable local directory cache was reset. '
      : ''
    return `${reset}More confirmed group history remains. Indexed through block ${state.snapshot.indexedThrough?.toString() ?? 'none'} of confirmed head ${state.snapshot.safeHead?.toString() ?? 'unknown'}.`
  }
  if (state.phase === 'complete') {
    const boundary = state.snapshot.safeHead?.toString() ?? 'none yet'
    return `Caught up through confirmed block ${boundary}. Showing up to 100 newest groups.`
  }
  return state.message
}

function directoryButtonLabel(state: GroupDirectoryState) {
  if (state.phase === 'loading') return 'Reading public groups…'
  if (state.phase === 'partial') return 'Load next group range'
  if (state.phase === 'complete') return 'Check for newer groups'
  if (state.phase === 'failed') return 'Retry public groups'
  return 'Load confirmed public groups'
}

function membershipStatus(
  state: GroupMembershipReadModelState,
  selected: boolean,
) {
  if (!selected) return 'Select a public group to reconstruct its membership.'
  if (state.phase === 'idle') {
    return 'Not loaded. RPC catch-up and local projection advance only when requested.'
  }
  if (state.phase === 'synchronizing') {
    return 'Reading one bounded range of confirmed membership signals…'
  }
  if (state.phase === 'catchup') {
    const reset = state.stream.cacheReset
      ? 'The disposable membership cache was reset. '
      : ''
    return `${reset}More confirmed membership history remains. Indexed through block ${state.stream.indexedThrough?.toString() ?? 'none'} of confirmed head ${state.stream.safeHead?.toString() ?? 'unknown'}.`
  }
  if (state.phase === 'projecting') {
    return `Local ${state.projection.phase} projection processed ${state.projection.logsProcessed.toString()} signals across ${state.projection.pagesScanned.toString()} complete-block pages; ${state.projection.membersRetained.toString()} current members are retained only as unpublished local work until authentication completes.`
  }
  if (state.phase === 'complete') {
    const boundary = state.projection.safeHead?.toString() ?? 'none yet'
    return `Membership is authenticated through confirmed block ${boundary}. ${state.projection.membersRetained.toString()} current members.`
  }
  return state.message
}

function membershipButtonLabel(state: GroupMembershipReadModelState) {
  if (state.phase === 'synchronizing') return 'Reading membership signals…'
  if (state.phase === 'catchup') return 'Load next membership range'
  if (state.phase === 'projecting') {
    if (state.busy) return 'Processing membership page…'
    return state.projection.phase === 'authenticate'
      ? 'Authenticate confirmed members'
      : 'Process next local member page'
  }
  if (state.phase === 'complete') return 'Check for membership changes'
  if (state.phase === 'failed') {
    return state.retryable ? 'Retry public membership' : 'Clear site data'
  }
  return 'Load confirmed members'
}

function GroupMetadataCommitment({ group }: { group: PublishedGroup }) {
  if (group.metadataCid === '0x') return null
  try {
    const cid = decodeMediaCid(group.metadataCid)
    return (
      <span className="group-metadata-commitment">
        IPFS metadata commitment · {cid.codec} · <code>{cid.text}</code>
      </span>
    )
  } catch {
    return (
      <span className="group-metadata-commitment invalid-media-commitment">
        Invalid metadata CID bytes · <code>{group.metadataCid}</code>
      </span>
    )
  }
}

function GroupDirectoryList({
  groups,
  onSelect,
  selectedGroupId,
}: {
  groups: readonly PublishedGroup[]
  onSelect(groupId: bigint): void
  selectedGroupId?: bigint
}) {
  if (groups.length === 0) {
    return <p className="group-empty-result">No confirmed groups found.</p>
  }
  return (
    <ol className="group-directory-list">
      {groups.map((group) => {
        const selected = group.groupId === selectedGroupId
        return (
          <li key={group.groupId.toString()}>
            <button
              aria-pressed={selected}
              onClick={() => onSelect(group.groupId)}
              type="button"
            >
              <span className="group-list-heading">
                <strong>
                  {group.nameEncoding === 'utf8'
                    ? group.name || 'Unnamed public group'
                    : 'Non-UTF-8 group name'}
                </strong>
                <span>Group #{group.groupId.toString()}</span>
              </span>
              {group.nameEncoding === 'hex' ? <code>{group.name}</code> : null}
              <span className="group-list-meta" title={group.creator}>
                Created by {shortValue(group.creator)} · block{' '}
                {group.blockNumber.toString()}
              </span>
              <GroupMetadataCommitment group={group} />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export function PublicGroupPanel({
  membershipOptions,
  session,
  synchronizeDirectory = synchronizeGroupDirectory,
}: {
  membershipOptions?: UseGroupMembershipReadModelOptions
  session: WalletSession
  synchronizeDirectory?: GroupDirectorySynchronizer
}) {
  const [scopedDirectory, setScopedDirectory] = useState<ScopedDirectoryState>()
  const [selection, setSelection] = useState<ScopedGroupSelection>()
  const [groupIdInput, setGroupIdInput] = useState('')
  const [selectionError, setSelectionError] = useState<string>()
  const directoryController = useRef<AbortController | undefined>(undefined)
  const directoryBusy = useRef(false)
  const directorySequence = useRef(0)
  const connected =
    session.status === 'connected' &&
    session.provider !== undefined &&
    session.chainId !== undefined
  const provider = session.provider
  const chainId = session.chainId
  const directoryState =
    connected &&
    scopedDirectory !== undefined &&
    scopedDirectory.provider === provider &&
    scopedDirectory.chainId === chainId
      ? scopedDirectory.state
      : IDLE_DIRECTORY
  const selectedGroupId =
    connected &&
    selection !== undefined &&
    selection.provider === provider &&
    selection.chainId === chainId
      ? selection.groupId
      : undefined
  const membership = useGroupMembershipReadModel(
    session,
    selectedGroupId,
    membershipOptions,
  )
  const [memberPageIndex, setMemberPageIndex] = useState(0)
  const [memberPageStarts, setMemberPageStarts] = useState<
    readonly (Address | undefined)[]
  >([undefined])

  useEffect(() => {
    directorySequence.current += 1
    directoryController.current?.abort()
    directoryController.current = undefined
    directoryBusy.current = false
    setScopedDirectory(undefined)
    setSelection(undefined)
    setGroupIdInput('')
    setSelectionError(undefined)
    return () => {
      directorySequence.current += 1
      directoryController.current?.abort()
      directoryController.current = undefined
      directoryBusy.current = false
    }
  }, [chainId, connected, provider])

  useEffect(() => {
    setMemberPageIndex(0)
    setMemberPageStarts([undefined])
  }, [membership.state.phase, selectedGroupId])

  const loadDirectory = useCallback(() => {
    if (
      !connected ||
      provider === undefined ||
      chainId === undefined ||
      directoryBusy.current
    ) {
      return
    }
    directoryBusy.current = true
    const requestId = ++directorySequence.current
    directoryController.current?.abort()
    const controller = new AbortController()
    directoryController.current = controller
    setScopedDirectory({
      chainId,
      provider,
      state: { phase: 'loading' },
    })
    void synchronizeDirectory(provider, chainId, {
      signal: controller.signal,
    })
      .then((snapshot) => {
        if (
          controller.signal.aborted ||
          directorySequence.current !== requestId
        )
          return
        setScopedDirectory({
          chainId,
          provider,
          state: {
            phase: snapshot.caughtUp ? 'complete' : 'partial',
            snapshot,
          },
        })
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          directorySequence.current !== requestId
        )
          return
        setScopedDirectory({
          chainId,
          provider,
          state: {
            message: describeRpcError(
              error,
              'The public group directory could not be synchronized.',
            ),
            phase: 'failed',
          },
        })
      })
      .finally(() => {
        if (directorySequence.current === requestId) {
          directoryController.current = undefined
          directoryBusy.current = false
        }
      })
  }, [chainId, connected, provider, synchronizeDirectory])

  const selectGroup = useCallback(
    (groupId: bigint) => {
      if (!connected || provider === undefined || chainId === undefined) return
      setSelection({ chainId, groupId, provider })
      setGroupIdInput(groupId.toString())
      setSelectionError(undefined)
    },
    [chainId, connected, provider],
  )

  const submitGroupId = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      selectGroup(parseGroupIdInput(groupIdInput))
    } catch (error) {
      setSelectionError(
        error instanceof Error ? error.message : 'The group ID is invalid.',
      )
    }
  }

  const runMembershipStep = () => {
    if (membership.state.phase === 'projecting') {
      membership.advanceProjection()
    } else {
      membership.loadNextRange()
    }
  }

  const directorySnapshot =
    directoryState.phase === 'partial' || directoryState.phase === 'complete'
      ? directoryState.snapshot
      : undefined
  const selectedGroup = directorySnapshot?.groups.find(
    (group) => group.groupId === selectedGroupId,
  )
  const pageStart = memberPageStarts[memberPageIndex]
  const memberPage =
    membership.state.phase === 'complete'
      ? membership.readMembers({
          ...(pageStart ? { after: pageStart } : {}),
          limit: MEMBER_PAGE_SIZE,
        })
      : undefined
  const selectNextMemberPage = () => {
    if (!memberPage?.nextAfter) return
    setMemberPageStarts((current) => [
      ...current.slice(0, memberPageIndex + 1),
      memberPage.nextAfter,
    ])
    setMemberPageIndex((current) => current + 1)
  }
  const membershipDisabled =
    !connected ||
    selectedGroupId === undefined ||
    membership.state.phase === 'synchronizing' ||
    (membership.state.phase === 'projecting' && membership.state.busy) ||
    (membership.state.phase === 'failed' && !membership.state.retryable)
  const currentAccountMembership =
    membership.state.phase === 'complete' && session.account
      ? membership.isMember(session.account)
      : undefined

  return (
    <section aria-labelledby="public-groups-title" className="public-groups">
      <div className="public-groups-heading">
        <div>
          <p className="eyebrow">Communities without gatekeepers</p>
          <h2 id="public-groups-title">Public groups. Public membership.</h2>
        </div>
        <p className="group-public-warning">
          Joining, leaving, and every future group message are permanent public
          events. Membership is social metadata, never access control.
        </p>
      </div>

      <div className="group-browser">
        <div className="group-directory">
          <h3>Confirmed group directory</h3>
          <p
            aria-live="polite"
            className="group-read-status"
            id="group-directory-status"
          >
            {connected
              ? directoryStatus(directoryState)
              : 'Connect a wallet to read confirmed public groups.'}
          </p>
          <button
            aria-describedby="group-directory-status"
            disabled={!connected || directoryState.phase === 'loading'}
            onClick={loadDirectory}
            type="button"
          >
            {directoryButtonLabel(directoryState)}
          </button>
          {directorySnapshot ? (
            <>
              <GroupDirectoryList
                groups={directorySnapshot.groups}
                onSelect={selectGroup}
                selectedGroupId={selectedGroupId}
              />
              {directoryState.phase === 'partial' ? (
                <p className="group-page-note">
                  This list is partial until the confirmed head is reached.
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="group-membership-browser">
          <h3>Selected group membership</h3>
          <form className="group-selector" onSubmit={submitGroupId}>
            <label htmlFor="selected-group-id">Group ID</label>
            <div>
              <input
                aria-describedby={
                  selectionError ? 'group-selection-error' : undefined
                }
                aria-invalid={selectionError !== undefined}
                disabled={!connected}
                id="selected-group-id"
                inputMode="numeric"
                onChange={(event) => {
                  setGroupIdInput(event.currentTarget.value)
                  setSelectionError(undefined)
                }}
                placeholder="1"
                value={groupIdInput}
              />
              <button disabled={!connected} type="submit">
                Select group
              </button>
            </div>
          </form>
          {selectionError ? (
            <p
              className="group-selection-error"
              id="group-selection-error"
              role="alert"
            >
              {selectionError}
            </p>
          ) : null}
          {selectedGroupId !== undefined ? (
            <p className="selected-group-summary">
              <strong>
                {selectedGroup?.nameEncoding === 'utf8'
                  ? selectedGroup.name || 'Unnamed public group'
                  : `Group #${selectedGroupId.toString()}`}
              </strong>{' '}
              · ID {selectedGroupId.toString()}
            </p>
          ) : null}
          <p
            aria-live="polite"
            className="group-read-status"
            id="group-membership-status"
          >
            {connected
              ? membershipStatus(
                  membership.state,
                  selectedGroupId !== undefined,
                )
              : 'Connect a wallet to reconstruct public membership.'}
          </p>
          <button
            aria-describedby="group-membership-status"
            disabled={membershipDisabled}
            onClick={runMembershipStep}
            type="button"
          >
            {membershipButtonLabel(membership.state)}
          </button>

          {memberPage ? (
            <div className="confirmed-member-page">
              {session.account ? (
                <p className="current-membership">
                  Connected account:{' '}
                  <strong>
                    {currentAccountMembership
                      ? 'current member'
                      : 'not a member'}
                  </strong>
                </p>
              ) : null}
              {memberPage.members.length === 0 ? (
                <p className="group-empty-result">
                  This group has no current confirmed members.
                </p>
              ) : (
                <ol className="group-member-list">
                  {memberPage.members.map((member) => (
                    <li key={member.account}>
                      <code title={member.account}>
                        {shortValue(member.account)}
                      </code>
                      <span>
                        joined · block {member.blockNumber.toString()}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="group-member-pagination">
                <button
                  disabled={memberPageIndex === 0}
                  onClick={() =>
                    setMemberPageIndex((current) => Math.max(0, current - 1))
                  }
                  type="button"
                >
                  Previous members
                </button>
                <span>
                  Page {memberPageIndex + 1} ·{' '}
                  {memberPage.totalMembers.toString()} total
                </span>
                <button
                  disabled={memberPage.complete}
                  onClick={selectNextMemberPage}
                  type="button"
                >
                  Next members
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <GroupTransactionConsole
          onSelectGroup={selectGroup}
          selectedGroupId={selectedGroupId}
          session={session}
        />
        <PublicGroupMessagePanel
          selectedGroupId={selectedGroupId}
          session={session}
        />
      </div>
    </section>
  )
}
