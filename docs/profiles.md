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
and indexed account topic. The canonical decoder and global event-family filter
are available now. A later profile projection will scan bounded block ranges,
persist reorg-aware checkpoints only on the user's device, and retain only the
latest canonical snapshot needed by its active view. No hosted indexer or
database is part of the protocol.

Avatar CIDs identify content; they do not pay for or prove persistence. See
[`media.md`](./media.md) for the storage boundary.
