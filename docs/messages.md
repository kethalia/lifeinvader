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

## Sending and confirmation

The browser transaction helper accepts a nonzero recipient plus text, canonical CID bytes, or both. It applies the same byte limits as the contract before opening the wallet, binds the action to the selected chain and account, verifies the exact v1 runtime code, and submits `sendDirectMessage` through an EIP-1193 wallet such as MetaMask.

Message identifiers are allocated by the contract and are shared with group messages, so the client cannot predict the next identifier safely. Confirmation instead requires a canonical receipt log with the exact protocol address, block, transaction, conversation, sender, recipient, body, and media CID, then accepts and returns the positive identifier emitted by the chain. A matching payload copied from another receipt or padded with surplus ABI data is not confirmation.

## Current boundary

This slice provides conversation derivation, strict event decoding, filters, guarded writes, receipt verification, and local Anvil coverage. It does not yet expose a message composer or conversation history in the React interface. Those screens will build on a bounded, resumable conversation stream rather than introducing a server or database.
