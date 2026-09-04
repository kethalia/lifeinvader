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

### Browser preparation boundary

The client now has a deterministic preparation primitive for the paid path. It transforms a selected file entirely in the browser with the IPFS UnixFS importer's `unixfs-v1-2025` profile and packages the resulting DAG in a [single-root CARv1 archive](https://ipld.io/specs/transport/car/carv1/). Files up to 1 MiB retain a CIDv1 `raw` root; larger files are divided into interoperable 1 MiB raw leaves under a `dag-pb` UnixFS root. The root is the CID eventually published to Lifeinvader, while the CAR contains every block handed to the storage adapter. File name and browser-reported media type are deliberately excluded from the DAG, so renaming identical bytes cannot change their address.

Preparation does not upload, pay, pin, or publish anything. It accepts at most 32 MiB per file because this first implementation holds the generated CAR and intermediate blocks in memory. Very small inputs whose complete CAR is below the storage protocol's 127-byte minimum are rejected. A later streaming implementation can raise the browser limit without silently risking tab-wide memory exhaustion.

## Optional smart-contract payment

Users can pay for stronger persistence on chains whose storage systems expose EVM contracts. [Filecoin Pin](https://docs.filecoin.cloud/core-concepts/filecoin-pin/) is one current example: it bridges ordinary IPFS addressing to proof-backed Filecoin storage, while its browser-capable [Synapse SDK](https://github.com/FilOzone/synapse-sdk) coordinates provider selection, token payments, uploads, and on-chain storage state.

That integration belongs in an optional client adapter, not the Lifeinvader core contract:

- the user's wallet pays the storage contract or provider directly;
- the agreement is keyed or correlated by CID;
- storage receipts remain independently verifiable on their native chain;
- users can choose another provider or publish an unpaid CID;
- Lifeinvader gains no owner, fee recipient, custody, or provider allowlist.

Because v1 attributes a post to `msg.sender`, a payment router must not publish through the core contract on the user's behalf: that would make the router the recorded author. The safe v1 flow uses separate wallet transactions for storage payment and publication. A future atomic design would require a new protocol version with explicit signed-author semantics and its own security review.

The interface now exposes a read-only adapter preflight for Filecoin mainnet (chain 314) and Calibration (chain 314159). It starts only after an explicit click and performs a small, sequential, deadline-bound set of wallet reads; it never polls. The check verifies that the configured Filecoin Warm Storage Service exists, that its reported Filecoin Pay, state-view, PDP, registry, and USDFC addresses match the deployment expected by the pinned integration version, and that each required contract has bytecode. A chain ID alone is not treated as evidence of a compatible deployment.

The prepared CAR remains in tab memory when the wallet leaves the Lifeinvader publication chain. The storage panel remains visible on Filecoin even though the publication form is unavailable there, and records which chain the user must return to after storage. The app does not silently add or switch networks.

No upload or payment adapter is wired into the interface yet. Passing the preflight means only that the on-chain dependency graph is reachable; it does not mean the CAR was uploaded, pinned, funded, approved, or committed. The prepared CAR boundary is the input to the next adapter. Local integration coverage uses a pinned Anvil fork of the relevant deployed contracts; ordinary CID publication continues to use a separate local Anvil chain.
