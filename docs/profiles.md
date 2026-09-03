# Public profiles

A Lifeinvader profile is a public, on-chain snapshot. Calling `setProfile` emits
`ProfileSet(account, displayName, bio, avatarCid)`; the contract stores no profile
record and offers no deletion mechanism.

## Snapshot semantics

Every event contains the complete profile rather than a partial update. For an
account, the latest canonical `ProfileSet` event by `(blockNumber, logIndex)` is
the derived profile. An all-empty snapshot clears the current derived profile,
but its earlier events remain permanently visible in chain history.

The v1 byte limits are:

| Field        | Maximum UTF-8 or binary bytes |
| ------------ | ----------------------------: |
| Display name |                            64 |
| Bio          |                         1,024 |
| Avatar CID   |                           128 |

The browser validates text by UTF-8 byte length. A non-empty avatar uses the
same canonical CID policy as post media; an empty avatar is valid.

## Writes and reads

Before submitting, the profile transaction helper verifies the exact
Lifeinvader v1 runtime at the predetermined address. It confirms success only
when the canonical transaction receipt contains the exact `ProfileSet` account
and payload requested by the user. Wallet network and account changes
invalidate the operation. Profile editing UI is staged separately from this
protocol foundation.

Profile history is independently queryable through the `ProfileSet` signature
and indexed account topic. The browser's global profile stream verifies the
selected chain and exact v1 runtime, scans at most one bounded RPC range per
call, strictly decodes every returned event, and commits accepted ranges to the
reorg-aware IndexedDB event cache. Its nominal 200-event recent page is only a
preview, never a complete profile projection.

Once the global cursor reaches a twice-checked confirmed safe head, the stream
can issue an immutable, provider-bound projection anchor containing the exact
cache generation, revision, and cursor. Later publication of derived state must
authenticate both that canonical provider checkpoint and the corresponding
cache proof; copied or partial-catch-up anchors are not trusted.

The pure projection core validates complete-block event pages, retains only the
latest snapshot for one to fifty requested accounts, records compatible
confirmation checkpoints, and exports canonical schema-versioned snapshots for
resumable local work. The projection runner accepts only an anchor issued by the
current page and scans its chronological cache snapshot one complete-block page
at a time. Its completed resume state contains the projection, cache baseline,
and a cache-keyed binding between them. Persisting that tuple lets the next run
authenticate the saved state and scan only events appended after its confirmed
baseline. A first run has no resume state; a rejected binding or noncanonical
baseline must be discarded and retried as a new full projection instead of
trusting saved data.

Every profile read remains withheld until the resulting full baseline and
canonical provider checkpoint have been reauthenticated. Cache movement,
corruption, reorgs, cancellation, or a wallet-context change fail closed and
discard the partial projection. A completed run returns only defensive copies;
wiring that result and its resume tuple into the UI is a separate slice. No
hosted indexer or server database is part of the protocol.

Avatar CIDs identify content; they do not pay for or prove persistence. See
[`media.md`](./media.md) for the storage boundary.
