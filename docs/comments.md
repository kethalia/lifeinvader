# Public comments

Lifeinvader comments are permanent public disclosures beneath an existing post. They are not stored in an application database and cannot be edited or deleted by the protocol.

## Publication

Each confirmed post card exposes one comment composer. A comment may contain UTF-8 text, an already-uploaded IPFS CID, or both. The client applies the contract's 4,096-byte text limit, parses the same narrow CID profile used for posts, and commits canonical CIDv1 bytes. It never describes a CID as an upload or availability guarantee.

Before opening the wallet, the client validates the post identifier and payload. It then binds the action to the selected provider, chain, and account; verifies the exact Lifeinvader v1 runtime; and sends `publishComment(postId, body, mediaCid)` directly to the predetermined contract. On local chain ID `31337`, the wallet endpoint must also match the loopback Anvil block fingerprint.

A receipt counts as inclusion only when its canonical block contains a `CommentPublished` log from the predetermined contract with the exact post identifier, author, body, media CID, transaction hash, block hash, and block number. The new comment identifier is assigned by the verified contract and remains visible in that indexed event.

## Recovery and drafts

The feed does not show an optimistic comment. If the wallet may have broadcast without returning a hash, or a returned hash cannot yet be verified, other post writes in that wallet context remain locked until the user checks the wallet or retries the receipt. The retained recovery record includes the original provider, chain, account, post, body, and media bytes, so another context cannot relabel it.

Drafts are retained separately for each provider, chain, and account context. Each draft is also bound to the confirmed post event's block hash and log index, not only its numeric post identifier. If that exact event leaves the visible confirmed page or is replaced by a reorg, the composer becomes a paused, copyable draft with an explicit discard control instead of permitting a comment against different content.

A successful receipt clears only the exact draft revision that produced it, even if its wallet context is not currently selected. A newer draft in that or another context remains untouched. Inclusion feedback is not a claim of confirmation-depth finality.

## Read boundary

Comment history is not rendered yet. The read foundation uses one separate global `CommentPublished` stream rather than mixing comment volume into the newest-post cache or launching one RPC query for every visible card. Its filter fixes the predetermined contract and event signature while retaining every indexed post identifier in the returned logs.

Each explicit synchronization call verifies the selected chain and exact protocol runtime, advances at most one accepted adaptive block range, validates every comment payload, and atomically advances its own IndexedDB scope. Any bounded split retries remain inside the shared indexer's request and result limits. The stream uses the same twelve-block confirmation depth, canonical checkpoint checks, rollback behavior, request timeout, cancellation, and hard RPC/cache work limits as the other event streams.

The returned recent-comment page is only a bounded preview. Its nominal limit is 200 logs and the shared cache may extend through the rest of the boundary block under its existing hard cap. It must never be described as a complete thread. A projection anchor is issued only after the stream catches up to one authenticated confirmed safe head; a later read-model slice will use bounded local pages to derive complete comment lists for visible posts.
