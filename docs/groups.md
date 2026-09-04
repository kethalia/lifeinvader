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

The global group directory scans only `GroupCreated`. After verifying the
selected chain and exact v1 runtime, it discovers the bounded protocol-history
boundary described in [`indexing.md`](./indexing.md) and starts a fresh cursor
there. Only a recognized unavailable or pruned archival-state rejection falls
back to genesis; rate limits, transport failures, timeouts, malformed history,
code conflicts, cancellation, and context changes fail closed without
requesting group logs. If the boundary is newer than the confirmed head, or the
chain does not have a confirmed head yet, the directory reports confirmation
pending without requesting logs or reading `nextGroupId()`. Each explicit
confirmation check rediscovers a pending boundary; the directory cannot clear
that state merely because the safe head reached the first block after earlier
confirmed emptiness. It proceeds only once the deployment block itself is
confirmed.

Each explicit invocation advances at most one bounded range, persists a
chain-scoped reorganization-aware cursor, and returns at most the newest 100
retained definitions after validating the complete cache page and the event
identifier sequence. A discovered head is reauthenticated after that one range
and before it can be applied to IndexedDB; a replaced anchor discards the result
and fails without retrying. Before reporting catch-up the directory reads
`nextGroupId()` at the exact confirmed safe-head block and requires the retained
event count to match. A truncated RPC response therefore resets the disposable
directory scope instead of permanently skipping groups. An incomplete or
confirmation-pending directory is marked `caughtUp: false`; callers must not
present that recent page as the complete set of groups. The snapshot carries an
explicit `historyBoundaryKind`, so callers do not infer deployment confirmation
from the numeric relationship between the possible start and safe head. Cached
corruption clears only that chain's directory scope, while another chain's scope
is preserved.

The selected-group message stream verifies the chosen chain and exact v1 runtime
before touching logs, then discovers the bounded protocol deployment boundary.
Only a recognized unavailable or pruned archival-state rejection falls back to
genesis; other discovery failures propagate without requesting group-message
logs. If deployment is newer than the confirmed head, or no confirmed head
exists yet, the stream reports pending confirmation without opening its event
cache. A later explicit check rediscovers that boundary rather than treating the
first block after confirmed emptiness as proof of deployment.

Each explicit invocation scans at most one bounded range with the exact group
filter, persists a reorganization-aware chain/group/start-block cursor in
disposable IndexedDB storage, and returns at most the newest 100 retained
messages. It reauthenticates the discovered head before applying the range; a
replacement discards the result without retry. Separate group IDs and discovered
starts use separate cache scopes. A malformed cached page clears only that scope
and restarts from its verified start; fresh malformed logs fail before cursor
commit. A stream without a confirmed safe head stays incomplete, and the
explicit history-boundary kind prevents the UI from mistaking numeric equality
for deployment confirmation.

The selected-group membership stream applies the same chain, runtime,
confirmation, cancellation, and cache rules to the exact indexed
`GroupMembershipSet` filter. After runtime verification it discovers the same
bounded protocol-history boundary as the directory and scopes the cursor by
chain, group, and discovered start block. Only a recognized unavailable or
pruned archival-state rejection falls back to genesis; other discovery failures
propagate without a log request. A pending deployment boundary returns no
membership signals or projection anchor and does not open the event cache. It is
rediscovered on the next explicit confirmation check, including when the safe
head has only reached the first block after earlier confirmed emptiness.

Each invocation scans at most one range and exposes at most the newest 200
validated join or leave signals. The discovered head is reauthenticated after
that range and before IndexedDB commit; replacement discards the result without
retrying the range. That recent page is not a current member list: repeated
signals must be reduced across complete history. Only a caught-up stream with a
confirmed safe head issues an immutable, page-local projection anchor bound to
the exact group, start block, cache generation, revision, cursor, provider, and
confirmed checkpoint. Its authenticator brackets later cache work with
canonical wallet checks so a projection cannot publish from a copied, stale, or
reorganized anchor.

The stream rechecks its final checkpoint, confirmation depth, head, and wallet
chain after cache work. It cannot claim catch-up unless a confirmed safe head
exists and its checkpoint anchors the twice-sampled boundary. Partial catch-up
remains identifiable to the caller, and no history is read merely because a
wallet connected or a component rendered. The snapshot carries the explicit
history-boundary kind and start block so the UI never infers deployment
confirmation from coincident block numbers.

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
cache corruption resets only the affected chain/group/start-block scope and
requires an explicit rebuild.

The public group browser renders this boundary without eager reads. Users can
advance the confirmed directory one range at a time, select a visible group or
enter a known positive group ID, then separately advance membership RPC and
projection work. It states both directory and membership history starts, keeps
pending or partial results from looking complete, and offers a confirmation
check without claiming that the first post-confirmed-empty block is necessarily
the exact deployment block. Partial membership never appears in the member list. After
authentication, current members are shown in deterministic 25-address pages and
the connected account's public membership status is derived from the same
projection. Group metadata CIDs are labeled as commitments rather than promises
of availability.

The adjacent transaction console creates groups and publishes explicit join or
leave events through the connected wallet. A directory selection feeds its
membership target, while a confirmed creation selects the identifier assigned
by the contract. It locks app-wide duplicate writes after a hash or ambiguous
broadcast, keeps old wallet contexts isolated, and clears a creation draft only
after the exact payload is authenticated in a canonical receipt. Changing the
account, chain, or provider while a wallet prompt is open turns it into a
dismissible hashless ambiguity and invalidates its late callbacks. Unknown
hashes can be retried only from the original provider, account, and chain with
the expected creation or membership event bound into receipt validation.

The selected-group message console remains inert until the user chooses a group
and explicitly advances a read or submits a write. Sending does not require
membership: the interface treats membership as public social metadata, requires
an explicit disclosure acknowledgment, and receipt-verifies the exact sender,
group, body, and canonical CID bytes. A submitted or ambiguously broadcast
message locks every app write until its outcome is resolved. A wallet-context
change makes a still-opening prompt dismissible and prevents its late result
from mutating the composer. A receipt clears only an unchanged draft for the same wallet and still
selected group. Unknown hashes are reauthenticated against the original wallet
context and exact `GroupMessageSent` payload before completion is reported.

Confirmed message reads request only the selected group's indexed topic, one
bounded range per action from the displayed verified start block. Pending and
partial catch-up are described but never rendered as a complete channel.
Changing the provider, chain, or selected group aborts the old request, while a
mismatched synchronizer result fails closed. The completed view shows at most
the newest 100 retained events in chronological display order and labels IPFS
values as availability-unproven commitments; it never fetches a gateway merely
because a CID appears in a log.

When a separate read RPC is selected, directory, selected-group membership,
projection authentication, and selected-group message reads use its
wallet-anchored provider. Replacing or clearing that provider aborts its work,
hides its state, and clears the provider-scoped group selection. Group creation,
join or leave events, message submission, ambiguous-hash recovery, and every
receipt check remain on the original injected wallet provider.

The Anvil integration covers create, join, leave, send, confirmed exact-group
message and membership readback, and discovery of the immutable group
definition. The interface uses those same browser-native helpers without a
hosted indexer, application server, or database.

Committing a CID does not upload or pay to retain its content. Optional paid IPFS
or storage-market adapters remain separate from the ownerless core protocol; see
[`media.md`](./media.md).
