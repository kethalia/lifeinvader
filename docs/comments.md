# Public comments

Lifeinvader comments are permanent public disclosures beneath an existing post. They are not stored in an application database and cannot be edited or deleted by the protocol.

## Publication

Each confirmed post card exposes one comment composer. A comment may contain UTF-8 text, an already-uploaded IPFS CID, or both. The client applies the contract's 4,096-byte text limit, parses the same narrow CID profile used for posts, and commits canonical CIDv1 bytes. It never describes a CID as an upload or availability guarantee.

Before opening the wallet, the client validates the post identifier and payload. It then binds the action to the selected provider, chain, and account; verifies the exact Lifeinvader v1 runtime; and sends `publishComment(postId, body, mediaCid)` directly to the predetermined contract. On local chain ID `31337`, the wallet endpoint must also match the loopback Anvil block fingerprint.

A receipt counts as inclusion only when its canonical block contains a `CommentPublished` log from the predetermined contract with the exact post identifier, author, body, media CID, transaction hash, block hash, and block number. The new comment identifier is assigned by the verified contract and remains visible in that indexed event.

## Recovery and drafts

The feed does not show an optimistic comment. If the wallet may have broadcast without returning a hash, or a returned hash cannot yet be verified, other post writes in that wallet context remain locked until the user checks the wallet or retries the receipt. The retained recovery record includes the original provider, chain, account, post, body, and media bytes, so another context cannot relabel it.

A successful receipt clears only the exact draft revision that produced it. Editing a newer draft or changing wallet context prevents a late completion from erasing that work. Inclusion feedback is not a claim of confirmation-depth finality.

## Read boundary

Comment history is not rendered yet. Its read model will be a separate bounded, reorg-aware event stream rather than mixing comment volume into the newest-post cache or launching one RPC query for every visible card.
