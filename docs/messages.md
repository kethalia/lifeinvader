# Deliberately public direct messages

Lifeinvader's direct messages provide addressing, not privacy. Every sender, recipient, body, media CID, and transaction is permanently visible in EVM logs. Clients must label this surface as public and must not use lock icons, secrecy claims, or private-notification language.

## Conversation identity

Two accounts share one deterministic conversation identifier. The client normalizes both EVM addresses, sorts their unsigned 160-bit values, concatenates the lower and higher 20-byte addresses, and hashes those 40 bytes with Keccak-256. This exactly mirrors `keccak256(abi.encodePacked(lower, higher))` in the v1 contract and is symmetric for the two participants.

The identifier is a grouping key, not an access-control secret. Anyone who knows or guesses both addresses can derive it.

## Reading one conversation

`DirectMessageSent` places the conversation identifier in topic 1, followed by the sender and recipient in topics 2 and 3. A selected conversation therefore uses one exact RPC filter:

```text
address = Lifeinvader v1
topics  = [DirectMessageSent signature, conversation ID]
```

That filter returns messages in both directions without an address-pair fan-out. Reads must still use bounded block ranges and locally cached, reorganization-aware checkpoints. The low-level decoder rejects logs from another contract or event family, malformed topic layouts, non-canonical address padding, mismatched conversation identifiers, zero identities, zero message identifiers, oversized payloads, and non-canonical ABI data.

The event-family-wide filter exists for future explicit indexing workflows. Normal conversation screens should use the exact conversation filter; they must not request all historical direct messages merely to display one pair.

## Bounded browser stream

The implemented conversation stream verifies the exact Lifeinvader v1 runtime and selected chain before touching logs. Each invocation accepts at most one bounded synchronization range, persists its cursor in the disposable event cache, and returns at most one recent local page ordered newest first. Repeated calls resume from that conversation's cursor; reversing the two input addresses selects the same filter and cache scope, while another pair receives an independent scope.

Only logs at least twelve blocks behind the sampled head are accepted. The stream rechecks its final checkpoint, head, and wallet chain after cache work, refuses to claim catch-up if the safe head advances, and lets the shared indexer roll back reorganized checkpoints. Fresh logs are strictly decoded before commit. A malformed cached page triggers a maintenance-capped clear of only that conversation's scope and a rebuild from chain history; if bounded repair cannot finish, the stream fails closed and the disposable site data can be cleared manually.

The recent page is a preview until `caughtUp` is true. Even after catch-up, it is not a promise that more than the retained page has been loaded into the interface. Loading older messages must be an explicit, bounded action in a later history reader.

## Sending and confirmation

The browser transaction helper accepts a nonzero recipient plus text, canonical CID bytes, or both. It applies the same byte limits as the contract before opening the wallet, binds the action to the selected chain and account, verifies the exact v1 runtime code, and submits `sendDirectMessage` through an EIP-1193 wallet such as MetaMask.

Message identifiers are allocated by the contract and are shared with group messages, so the client cannot predict the next identifier safely. Confirmation instead requires a canonical receipt log with the exact protocol address, block, transaction, conversation, sender, recipient, body, and media CID; the verifier accepts the positive identifier emitted by the chain without trying to predict it. A matching payload copied from another receipt or padded with surplus ABI data is not confirmation.

## Current boundary

The client now provides conversation derivation, strict event decoding, filters, guarded writes, receipt verification, a bounded resumable conversation stream, and local Anvil coverage. It does not yet expose a message composer or conversation history in the React interface. Those screens will consume this stream without introducing a server or hosted database.
