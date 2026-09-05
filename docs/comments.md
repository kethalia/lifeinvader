# Public comments

Lifeinvader comments are permanent public disclosures beneath an existing post. They are not stored in an application database and cannot be edited or deleted by the protocol.

## Publication

Each confirmed post card exposes one comment composer. A comment may contain UTF-8 text, an already-uploaded IPFS CID, or both. The client applies the contract's 4,096-byte text limit, parses the same narrow CID profile used for posts, and commits canonical CIDv1 bytes. It never describes a CID as an upload or availability guarantee.

Before opening the wallet, the client validates the post identifier and payload. It then binds the action to the selected provider, chain, and account; verifies the exact Lifeinvader v1 runtime; and sends `publishComment(postId, body, mediaCid)` directly to the predetermined contract. On local chain ID `31337`, the wallet endpoint must also match the loopback Anvil block fingerprint.

A receipt counts as inclusion only when its canonical block contains a `CommentPublished` log from the predetermined contract with the exact post identifier, author, body, media CID, transaction hash, block hash, and block number. The new comment identifier is assigned by the verified contract and remains visible in that indexed event.

## Recovery and drafts

The feed does not show an optimistic comment. If the wallet may have broadcast without returning a hash, or a returned hash cannot yet be verified, every transaction-producing console remains locked until the user checks the wallet or retries the receipt. The retained recovery record includes the original provider, chain, account, post, body, and media bytes, so another context cannot relabel it. Changing account, chain, or provider while the wallet prompt is open converts it to a dismissible hashless ambiguity and invalidates late callbacks from that abandoned operation.

Drafts are retained separately for each provider, chain, and account context. Each draft is also bound to the confirmed post event's block hash and log index, not only its numeric post identifier. If that exact event leaves the visible confirmed page or is replaced by a reorg, the composer becomes a paused, copyable draft with an explicit discard control instead of permitting a comment against different content.

A successful receipt clears only the exact draft revision that produced it, even if its wallet context is not currently selected. A newer draft in that or another context remains untouched. Inclusion feedback is not a claim of confirmation-depth finality.

## Read boundary

Comment history uses one separate global `CommentPublished` stream rather than mixing comment volume into the newest-post cache or launching one RPC query for every visible card. Its filter fixes the predetermined contract and event signature while retaining every indexed post identifier in the returned logs. The feed starts no comment RPC work automatically and offers the control only after its post stream catches up. The user advances one bounded global comment range per click and then advances one bounded local projection page per click.

Each explicit synchronization call verifies the selected chain and exact protocol runtime, advances at most one accepted adaptive block range, validates every comment payload, and atomically advances its own IndexedDB scope. Any bounded split retries remain inside the shared indexer's request and result limits. The stream uses the same twelve-block confirmation depth, canonical checkpoint checks, rollback behavior, request timeout, cancellation, and hard RPC/cache work limits as the other event streams.

Before creating a fresh comment cursor, the client resolves the shared bounded
protocol-history boundary. A confirmed exact-v1 deployment starts the cursor at
its deployment block. When deployment is newer than the safe head, it starts
immediately after the last confirmed empty block, performs no premature log
request, and withholds the projection until confirmation depth catches up. The
discovery head is hash-reauthenticated after the bounded comment request and
before cache mutation; a replaced result is discarded and discovery is retried
once, while a second replacement fails closed.

Only a recognized unavailable or pruned archival-state rejection falls back to
genesis. A rate limit, transport failure, local timeout, malformed history data,
conflicting code, cancellation, or wallet-context change does not. Boundaries
cached for the same provider, chain, and finality policy are reused only after
their head fingerprint is reauthenticated, avoiding redundant code-probe bursts
without trusting a reset local fork.

The returned recent-comment page is only a bounded preview. Its nominal limit is 200 logs and the shared cache may extend through the rest of the boundary block under its existing hard cap. It must never be described as a complete thread. A projection anchor is issued only after the stream catches up to one authenticated confirmed safe head.

## Bounded local projection

An anchored projection run derives exact histories for one to fifty requested post identifiers. Before it opens, the client advances at most one bounded post-feed range, requires that stream to remain caught up, and compares the complete `(postId, blockNumber, blockHash, logIndex)` scope with the rendered snapshot. The comment anchor must be at or after every visible post. A replacement post at the same numeric ID, a newly visible post, or an older comment boundary therefore fails closed and tells the user to refresh rather than attaching current comments to stale content. The stream issues its anchor as a frozen, unforgeable capability scoped to the current page lifetime; a copied, fabricated, mutated, or reload-persisted object is rejected. Each ordinary `advance()` scans at most one chronological IndexedDB page and makes no RPC request. A nominal page contains at most 200 logs; the cache may extend it through the rest of one boundary block, under the existing 5,199-log hard cap. Every global comment is decoded and its protocol-wide, gapless comment identifier is checked even when its post is not requested. Only comments for the requested posts are retained, in canonical oldest-first order.

Partial results are never published. A cache append, rollback, reset, corrupt event, invalid continuation, identifier gap, overlapping call, or closed run fails the projection and discards its derived comments. After the scan completes, one separate bounded step authenticates the cache, rechecks the original provider's chain, head, and canonical safe-head block, and authenticates the same cache baseline again. This brackets the wallet reads against concurrent local changes and proves that the issued anchor remains canonical before publication. Completed histories are therefore exact as of that displayed block.

Consumers read a completed thread through pages of at most 200 comments. A read copies only its requested page and returns an explicit next offset and total, so a viral thread cannot cause one synchronous full-history allocation. The feed renders ten comments per visible card, oldest first, with explicit previous and next controls. Changing the chain, a confirmed post event's block-hash identity, the visible post scope, or the authenticated anchor closes the old projection and clears those page offsets before any replacement history is shown.

The projection core can export and defensively restore a schema-versioned snapshot. It preserves the protocol-wide comment count and tail while retaining only comments in the exact tracked post scope. Restoration normalizes every persisted field, rejects inconsistent event, block, transaction, confirmation, and identifier metadata, and produces one canonical digest independent of input order or hex casing. During a rebuild, incremental identity indexes keep each accepted projection page proportional to that page instead of rescanning the retained thread. A digest is not authentication by itself.

A completed runner binds that digest to the authenticated comment-cache baseline and can later accept the resulting snapshot, baseline, and cache-issued proof only for the exact same tracked post identifiers. It verifies the saved global count, tail, confirmation, digest, proof, cache generation, and append-only cursor boundary before scanning only newer cache records. The replacement result is rebound only after the new baseline and wallet context are authenticated again. The read model does not persist or supply this resume tuple yet, so product loads still perform a fresh in-memory rebuild; chain-scoped persistence remains a separate slice.
