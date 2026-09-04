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

The feed never fetches CID content automatically and ships no mandatory gateway. A user may enter a fixed-origin HTTPS gateway URL template containing exactly one `{cid}` placeholder (loopback HTTP is allowed for development), then request one attachment at a time. Saving that template performs no network request. Each click bypasses the HTTP cache, omits credentials and referrer data, rejects redirects, streams at most 32 MiB into the tab, identifies supported image or video bytes from their signatures instead of a gateway-supplied media type, and creates only a temporary blob URL. The gateway still receives the browser's IP address, requested CID, and page origin, which the interface discloses before loading. SVG, HTML, and other active or document formats are not rendered.

Verified retrieval supports CIDv1 `raw` attachments and the deterministic `dag-pb` files produced by Lifeinvader's own preparation flow. Raw blocks are checked by recomputing SHA-256 over the complete bounded response. For a prepared `dag-pb` file, the client dynamically loads the UnixFS importer, reconstructs the file with the same `unixfs-v1-2025` profile, and requires that root to equal the on-chain CID before decoding any media. This detects substituted path-gateway responses without downloading the importer for ordinary raw attachments.

This is deliberately not a generic DAG verifier. A valid UnixFS file built with another chunking or layout profile will be refused even if it contains the same bytes, while `dag-cbor` and `dag-json` commitments remain visible but are never fetched. General structured DAG support requires a later bounded block/CAR traversal that verifies every link instead of trusting a path gateway's decoded response.

## Addressing is not storage

A CID proves that an event committed to a content address. A successfully rendered raw or Lifeinvader-prepared UnixFS attachment additionally proves that the bytes returned for that click reproduce the address. Neither fact proves that any IPFS node will retain the bytes. The publishing form therefore describes its CID field as an already-uploaded address and makes no availability claim.

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

The interface now exposes a read-only adapter preflight for Filecoin mainnet (chain 314) and Calibration (chain 314159). It starts only after an explicit click and performs a small, sequential, deadline-bound set of wallet reads; it never polls. The check verifies that the configured Filecoin Warm Storage Service exists, that its reported Filecoin Pay, state-view, PDP, registry, and USDFC addresses match the deployment expected by the pinned integration version, and that each required contract—including the Multicall3 helper used by Synapse—has bytecode. A chain ID alone is not treated as evidence of a compatible deployment.

After a successful preflight, another explicit click can ask the pinned browser-capable Synapse SDK for a one-copy estimate. This initial quote deliberately assumes one new data set, one CAR piece, and no paid CDN. It reports the current monthly service rate, one-time data-set and piece fees, required payment lockup, additional USDFC deposit, and whether the wallet still needs the maximum FWSS service approval. One-time fees are paid from the lifecycle reserve represented in the lockup, so they are not added again to the deposit estimate. The result is bound to the exact account, chain, and CAR byte length; fresh account and chain reads bracket it, wallet context events invalidate it, the whole operation has a 30-second deadline, and at most 16 allowlisted read RPC calls can reach the wallet. The adapter transport rejects transaction and signing methods.

The quote incorporates current Filecoin Pay state and can become stale as rates, balances, approvals, or chain state change. It is an estimate to refresh before funding, not a reservation. Reading it sends no transaction, signature, approval, deposit, or bytes to a storage provider.

The funding adapter can fund that exact account-level quote. It repeats the deployment preflight, derives the Filecoin Pay action from the quote, and confines the pinned Synapse SDK to bounded reads, at most one ERC-2612 `Permit` signature, and exactly one simulated-then-submitted Filecoin Pay transaction. The permit is limited to the quoted USDFC deposit and exact Filecoin Pay spender. If FWSS approval is required, Synapse deliberately grants its standard maximum rate and lockup allowances with the quoted default lockup period; this is an account-level service approval, not a payment scoped to one CAR. The transaction guard rejects a changed account, chain, recipient, native FIL value, deposit amount, permit signature, operator, or approval term before forwarding the transaction to the wallet.

A funding result is accepted only after its receipt belongs to a canonical block and contains exactly one matching `DepositRecorded` and/or `OperatorApprovalUpdated` event from the pinned Filecoin Pay contract. A wallet rejection remains distinguishable from a transport failure for which submission may have begun, and a returned transaction hash is retained for later receipt recovery. Funding still does not upload the CAR, select a provider, create a data set, bind payment to the root CID, or publish a Lifeinvader post.

The prepared CAR remains in tab memory when the wallet leaves the Lifeinvader publication chain. The storage panel remains visible on Filecoin even though the publication form is unavailable there, and records which chain the user must return to after storage. The app does not silently add or switch networks.

The interface exposes account funding only after the user acknowledges the deposit, maximum-approval, and no-upload boundaries. It rereads every quote field immediately before loading the transaction adapter; any change stops the flow and requires a new review. While an unresolved write owns the shared app boundary, every transaction-producing console and the prepared CAR remain locked across account, chain, and provider changes, but wallet connection and receipt-recovery controls stay available. A known transaction hash survives wallet-context changes and can be checked again from its original account and chain; a no-hash ambiguous attempt requires an explicit wallet-activity check before the user clears the lock. After an authenticated receipt, the account quote is refreshed.

Funding still is not upload. Passing the preflight, reading a quote, or confirming the deposit and approval does not mean the CAR was sent to a provider, pinned, placed in a data set, or bound to its CID. The funding primitive has deterministic tests for deposit-only, approval-only, and combined actions, plus a snapshot-and-revert test that executes the real Synapse permit and transaction against a pinned Calibration Anvil fork. Ordinary CID publication continues to use a separate local Anvil chain.
