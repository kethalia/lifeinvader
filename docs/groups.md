# Deliberately public groups

Lifeinvader groups are public event channels, not private rooms. Every group name,
metadata CID, membership signal, sender, message body, media CID, and transaction
is visible in EVM logs. Joining does not grant access, leaving does not hide
history, and no creator or administrator can remove another account or message.

## Protocol semantics

`createGroup(name, metadataCid)` assigns the next positive group identifier and
emits an immutable `GroupCreated` definition. The creator field records who sent
that transaction; it grants no role. Names contain between 1 and 96 UTF-8 bytes,
and the optional metadata CID is limited to 128 raw bytes.

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
the complete cache page. An incomplete directory is marked `caughtUp: false`;
callers must not present that recent page as the complete set of groups. Cached
corruption clears only that chain's directory scope, while another chain's scope
is preserved.

The selected-group message stream verifies the chosen chain and exact v1 runtime
before touching logs. Each explicit invocation scans at most one bounded range
with the exact group filter, persists a reorganization-aware cursor in disposable
IndexedDB storage, and returns at most the newest 100 retained messages. Separate
group IDs use separate cache scopes. A malformed cached page clears only that
scope and restarts from genesis; fresh malformed logs fail before cursor commit.

The stream rechecks its final checkpoint, confirmation depth, head, and wallet
chain after cache work. It cannot claim catch-up unless its checkpoint anchors the
twice-sampled safe head. Partial catch-up remains identifiable to the caller, and
no history is read merely because a wallet connected or a component rendered.
The Anvil integration covers create, join, send, and confirmed exact-group
readback as well as discovery of the immutable group definition. Later slices
will add membership projections and the React interface without a hosted
indexer, application server, or database.

Committing a CID does not upload or pay to retain its content. Optional paid IPFS
or storage-market adapters remain separate from the ownerless core protocol; see
[`media.md`](./media.md).
