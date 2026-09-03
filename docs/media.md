# Media commitments and paid persistence

Lifeinvader v1 records media addresses, not media bytes. A post may contain text, an IPFS CID, or both. The ownerless core contract emits the supplied binary CID in `PostPublished` and neither accepts a storage fee nor promises that the addressed content remains available.

## Supported commitments

The publishing client accepts CIDv0 and CIDv1 text, then commits canonical CIDv1 bytes. It currently permits these codecs:

- raw (`0x55`)
- dag-pb (`0x70`)
- dag-cbor (`0x71`)
- dag-json (`0x0129`)

Each CID must use a 32-byte SHA-256 multihash and fit the protocol's 128-byte binary field limit. Text input is bounded to 256 characters before parsing. These deliberately narrow rules make browser behavior predictable while supporting ordinary UnixFS files and structured manifests.

The Solidity contract only enforces the binary size bound. Another client can therefore publish malformed or unsupported bytes. The feed treats every event as untrusted: it decodes supported CIDs for display, labels invalid bytes, and never lets one bad attachment prevent other posts from rendering.

The current client does not fetch CID content. A future renderer must require an explicit user-selected IPFS transport, apply media type and byte limits before decoding, isolate active formats such as SVG or HTML, and avoid silently leaking every feed view to a hard-coded gateway.

## Addressing is not storage

A CID proves that an event committed to a content address. It does not prove that any IPFS node has the bytes or will retain them. The publishing form therefore describes its CID field as an already-uploaded address and makes no availability claim.

A useful media workflow has at least three distinct operations:

1. Prepare and upload the bytes, producing a CID.
2. Optionally purchase persistence from one or more providers.
3. Publish the CID in a Lifeinvader event.

The upload itself is off-chain, so it cannot be made atomic with an EVM transaction. A client must surface partial completion honestly—for example, storage paid but post rejected, or uploaded content not yet covered by a persistence agreement.

## Optional smart-contract payment

Users can pay for stronger persistence on chains whose storage systems expose EVM contracts. Filecoin's [programmatic storage](https://docs.filecoin.io/smart-contracts/programmatic-storage) is one current example: its browser-capable [Synapse SDK](https://github.com/FilOzone/synapse-sdk) coordinates provider selection, token payments, uploads, and proof-backed storage state.

That integration belongs in an optional client adapter, not the Lifeinvader core contract:

- the user's wallet pays the storage contract or provider directly;
- the agreement is keyed or correlated by CID;
- storage receipts remain independently verifiable on their native chain;
- users can choose another provider or publish an unpaid CID;
- Lifeinvader gains no owner, fee recipient, custody, or provider allowlist.

Because v1 attributes a post to `msg.sender`, a payment router must not publish through the core contract on the user's behalf: that would make the router the recorded author. The safe v1 flow uses separate wallet transactions for storage payment and publication. A future atomic design would require a new protocol version with explicit signed-author semantics and its own security review.

No storage adapter is implemented yet. Its eventual local integration tests should use a pinned Anvil fork of the relevant deployed contracts; ordinary CID publication continues to use a clean local Anvil chain.
