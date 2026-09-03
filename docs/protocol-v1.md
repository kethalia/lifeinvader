# Core event protocol v1

Lifeinvader v1 is an ownerless append-only event protocol. The contract has no administrator, proxy, pause switch, allowlist, treasury, or deletion path. Its only persistent state is four monotonically increasing identifier counters.

This document describes the log schema and the rules a client uses to derive a social view. It does not imply privacy: every payload and participant is public.

## Identity and ordering

An account is an EVM address. Profiles are optional and the latest canonical `ProfileSet` event for an account is its current derived profile.

Post, comment, message, and group identifiers start at one. An identifier is meaningful only inside this tuple:

```text
(chainId, protocolAddress, entityKind, identifier)
```

Clients order events by `(blockNumber, logIndex)`, the canonical block-wide log position. They validate transaction indexes as metadata but never use them to reorder events. Clients must retain block hashes for unfinalized checkpoints and roll back events displaced by a chain reorganization.

## Payload limits

Limits bound log size and make transaction cost estimable. Lengths are byte lengths, not character counts.

| Field                          | Maximum bytes |
| ------------------------------ | ------------: |
| Post, comment, or message body |         4,096 |
| Media CID                      |           128 |
| Profile display name           |            64 |
| Profile bio                    |         1,024 |
| Group name                     |            96 |

Posts, comments, and messages require a non-empty body, a non-empty media CID, or both. A media CID is the binary CID for an IPFS object, normally a manifest that describes one or more images, animated images, videos, or other attachments. The contract caps but does not parse CID bytes; clients must validate their multicodec and multihash before fetching content.

Profile snapshots may be entirely empty. An empty `ProfileSet` event tells clients to derive an empty profile without pretending the historical events disappeared.

## Publications and relationships

- `PostPublished` creates a top-level publication.
- `CommentPublished` creates a comment directly beneath a known post.
- `RepostPublished` records a repost. Repeated reposts remain in history.
- `LikeSet` records the caller's latest like or unlike state for a post or comment.
- `FollowSet` records the caller's latest follow or unfollow state for another nonzero address.
- `ProfileSet` appends a complete profile snapshot for the caller.

The core contract validates referenced post and comment identifiers against its counters. It deliberately does not maintain aggregate like, repost, or follower counts. Clients derive them from canonical logs.

## Public messaging

`DirectMessageSent` is direct only in the sense that it names a recipient. Its body, media CID, sender, recipient, and conversation are public. To derive the conversation identifier:

1. Sort the two addresses by their unsigned 160-bit numeric values.
2. Concatenate the lower address's 20 raw bytes with the higher address's 20 raw bytes, without padding or length prefixes.
3. Take the Keccak-256 hash of that 40-byte sequence.

This is equivalent to `keccak256(abi.encodePacked(lower, higher))` in Solidity. Clients may instead call the contract's pure `conversationId(address,address)` function. Either participant therefore computes the same indexed topic.

Groups are immutable public channels:

- `GroupCreated` assigns a group identifier, name, and optional metadata CID.
- `GroupMembershipSet` records the caller's latest join or leave signal.
- `GroupMessageSent` appends a message to a known group.

Group membership is not an authorization mechanism. Anyone can inspect a group, signal membership, or send a group message. There are no group administrators in v1.

Direct and group messages share one message sequence. This makes message identifiers unique within a protocol deployment while each event family remains independently queryable.

## Indexed topics

The schema uses no more than three indexed parameters per non-anonymous event. Topic positions are chosen for common bounded queries.

| Event                | Topic 1         | Topic 2    | Topic 3    |
| -------------------- | --------------- | ---------- | ---------- |
| `PostPublished`      | post ID         | author     | —          |
| `CommentPublished`   | comment ID      | post ID    | author     |
| `RepostPublished`    | post ID         | account    | —          |
| `LikeSet`            | content kind    | content ID | account    |
| `FollowSet`          | follower        | followed   | —          |
| `ProfileSet`         | account         | —          | —          |
| `DirectMessageSent`  | conversation ID | sender     | recipient  |
| `GroupCreated`       | group ID        | creator    | —          |
| `GroupMembershipSet` | group ID        | account    | —          |
| `GroupMessageSent`   | group ID        | sender     | message ID |

Clients should query only the event signatures and topic positions needed by the active screen. Requests must use bounded block ranges; topic filters are not permission to request an entire chain history in one RPC call.

## Media persistence and payment

Publishing a CID proves only that the transaction referenced those bytes. It does not prove that any provider still stores them.

The browser must upload bytes before publishing a useful CID. On chains with a compatible storage market, a separate immutable adapter can then route payment from the user to the storage provider or proof-linked deal contract. That adapter will emit its own receipt events. The core protocol does not accept a media fee because it has no operator or treasury that could turn an arbitrary payment into storage.
