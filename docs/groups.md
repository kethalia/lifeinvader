# Deliberately public groups

Lifeinvader groups are public event channels, not private rooms. Every group name,
metadata CID, membership signal, sender, message body, media CID, and transaction
is visible in EVM logs. Joining does not grant access, leaving does not hide
history, and no creator or administrator can remove another account or message.

## Protocol semantics

`createGroup(name, metadataCid)` assigns the next positive group identifier and
emits an immutable `GroupCreated` definition. The creator field records who sent
that transaction; it grants no role. The first-party composer accepts names
containing between 1 and 96 UTF-8 bytes, while the contract's ABI-level rule is
only a 1-to-96-byte bound. A raw caller can therefore publish non-UTF-8 name
bytes. Readers preserve those bytes and display their canonical hex form rather
than letting one such definition block the directory. The optional metadata CID
is limited to 128 raw bytes.

`setGroupMembership(groupId, joined)` emits the caller's latest public join or
leave signal for a known group. Membership is social metadata only. It is neither
an authorization check nor a prerequisite for reading or sending messages.

`sendGroupMessage(groupId, body, mediaCid)` appends text, a media CID, or both to
a known group. Bodies are limited to 4,096 UTF-8 bytes and media CIDs to 128 raw
bytes. Group messages and direct messages draw from the same global message-ID
sequence, so gaps inside either channel are normal and do not imply missing
channel history.

All identifiers must be scoped by chain ID and the verified v1 protocol address.
Group `17` on one chain has no relationship to group `17` on another chain.

## Sending and confirmation

The browser helpers validate names, positive 256-bit group identifiers, message
bodies, and canonical non-empty CID bytes before opening an EIP-1193 wallet such
as MetaMask. They bind the transaction to the selected chain and account, verify
the exact Lifeinvader v1 runtime, and keep those checks active through receipt
confirmation.

The client does not predict identifiers. A create or send succeeds only when the
canonical receipt contains the exact protocol address, transaction, block,
caller, requested payload, and a positive group or message identifier assigned
by the contract. Membership confirmation likewise requires the exact group,
account, and boolean signal. Payloads copied from another receipt, unexpected
topics, and surplus ABI data cannot confirm an action.

## Reading bounded history

The low-level client exposes three event-family filters for explicit discovery:

```text
GroupCreated       [event signature]
GroupMembershipSet [event signature]
GroupMessageSent   [event signature]
```

Once a group is selected, normal membership and message reads add its indexed
group ID as topic 1. This lets the shared event indexer request one group directly
instead of downloading all group traffic and filtering it in the browser.

Strict decoders accept only logs from the predetermined protocol address with
the exact signature and topic layout. They reject zero identifiers and accounts,
invalid booleans, non-canonical topic padding or ABI data, empty or oversized
content, and malformed dynamic values. Raw on-chain CID bytes are length-checked
rather than treated as proof that content exists.

The global group directory scans only `GroupCreated`. Each explicit invocation
advances at most one bounded range, persists a chain-scoped reorganization-aware
cursor, and returns at most the newest 100 retained definitions after validating
the complete cache page and the event identifier sequence. Before reporting
catch-up it reads `nextGroupId()` at the exact confirmed safe-head block and
requires the retained event count to match. A truncated RPC response therefore
resets the disposable directory scope instead of permanently skipping groups.
An incomplete directory is marked `caughtUp: false`; callers must not present
that recent page as the complete set of groups. Cached corruption clears only
that chain's directory scope, while another chain's scope is preserved.

The selected-group message stream verifies the chosen chain and exact v1 runtime
before touching logs. Each explicit invocation scans at most one bounded range
with the exact group filter, persists a reorganization-aware cursor in disposable
IndexedDB storage, and returns at most the newest 100 retained messages. Separate
group IDs use separate cache scopes. A malformed cached page clears only that
scope and restarts from genesis; fresh malformed logs fail before cursor commit.

The selected-group membership stream applies the same chain, runtime,
confirmation, cancellation, and cache rules to the exact indexed
`GroupMembershipSet` filter. Each invocation scans at most one range and exposes
at most the newest 200 validated join or leave signals. That recent page is not a
current member list: repeated signals must be reduced across complete history.
Only a caught-up stream issues an immutable, page-local projection anchor bound
to the exact group, cache generation, revision, cursor, provider, and confirmed
checkpoint. Its authenticator brackets later cache work with canonical wallet
checks so a projection cannot publish from a copied, stale, or reorganized
anchor.

The stream rechecks its final checkpoint, confirmation depth, head, and wallet
chain after cache work. It cannot claim catch-up unless its checkpoint anchors the
twice-sampled safe head. Partial catch-up remains identifiable to the caller, and
no history is read merely because a wallet connected or a component rendered.

The membership projection reduces complete-block cache pages in chronological
order to each account's latest join or leave signal. It retains only current
members and constant-size progress for the selected group, total signal count,
exact log tail, and confirmation checkpoint. Member reads are address-ordered and
capped at 200 records per page; an address-cursor radix index keeps each read
proportional to that page instead of repeatedly sorting the entire group.
Malformed, zero-address, or cross-group input is rejected atomically, while
reference-counted active identity indexes keep each history-apply and confirmation
step independent of the total group size.

The projection deliberately does not materialize or hash a monolithic member
snapshot after each history page. Durable derived membership will use bounded
member chunks in a later local IndexedDB layer; until then, the resumable event
cache remains authoritative and projection work advances explicitly page by
page. The authenticated projection runner opens only the anchor's exact-group
cache scope and consumes one caller-requested, complete-block page per explicit
advance. It rejects cache resets, moved generations, revisions, cursors, malformed
page boundaries, mismatched totals, and mismatched tails before any result is
published.

Once scanning is complete, the runner authenticates the cache baseline, brackets
a second proof with the anchor's canonical wallet-chain checks, and confirms the
projection through the anchor checkpoint. Member reads remain unavailable until
that gate succeeds; failure or cancellation discards partial membership state.
The completed baseline can seed a later append-only scan, while the retained
members remain boundedly readable by address cursor. Membership is public social
metadata, never access control.

The React membership read model scopes that work to the selected provider,
chain, and group. It performs no eager history read: one explicit action advances
at most one RPC range, and a separate action advances at most one local cache
page. Changing the chain, provider, or group aborts synchronization and closes
the old projection. Completed member getters stay unavailable during catch-up or
projection, so partial state cannot be mistaken for authenticated state. Deep
cache corruption resets only the affected chain/group scope and requires an
explicit rebuild.

The public group browser renders this boundary without eager reads. Users can
advance the confirmed directory one range at a time, select a visible group or
enter a known positive group ID, then separately advance membership RPC and
projection work. Partial membership never appears in the member list. After
authentication, current members are shown in deterministic 25-address pages and
the connected account's public membership status is derived from the same
projection. Group metadata CIDs are labeled as commitments rather than promises
of availability.

The Anvil integration covers create, join, send, confirmed exact-group message
and membership readback, and discovery of the immutable group definition. Later
slices will add group transactions and confirmed messages to the interface
without a hosted indexer, application server, or database.

Committing a CID does not upload or pay to retain its content. Optional paid IPFS
or storage-market adapters remain separate from the ownerless core protocol; see
[`media.md`](./media.md).
