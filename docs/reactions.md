# Post reactions and reposts

Lifeinvader v1 treats every reaction as another public transaction. There is no mutable like counter or repost table in the contract.

## Write behavior

The confirmed-post feed exposes three explicit controls:

- **Like** emits `LikeSet(Post, postId, account, true)`.
- **Unlike** emits `LikeSet(Post, postId, account, false)`.
- **Repost** emits `RepostPublished(postId, account)`.

Unlike is not deletion. It appends a new public event, and a derived view may treat the latest canonical `LikeSet` event for `(content kind, content ID, account)` as that account's current signal. Reposts are append-only actions; repeated reposts remain visible in history.

Before each write, the client rechecks the connected chain, selected account, and exact protocol runtime code. A successful receipt is accepted only when its canonical block contains the expected event from the predetermined contract with the exact post, account, and like value. If a wallet returns a transaction hash but receipt verification becomes unavailable, all post-action controls remain locked until the user checks or explicitly dismisses that hash. This avoids casually duplicating a repost whose status is unknown.

The current UI reports transaction inclusion but does not claim a like state, count, or repost total. No optimistic local value is presented as chain truth.

## Read-model boundary

Reaction reads will use a separate bounded, reorg-aware event stream and disposable cache scope. They must not be mixed into the post cache's newest-50 page: a busy reaction stream could otherwise crowd every post out of the feed.

Likewise, issuing one historical `eth_getLogs` query per visible post would multiply RPC load. A later reducer should consume bounded global `LikeSet` and `RepostPublished` ranges, retain only validated canonical state, and expose honest synchronization progress. Counts are complete only after that independent stream catches up to its confirmed head.
