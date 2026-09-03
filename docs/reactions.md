# Post reactions and reposts

Lifeinvader v1 treats every reaction as another public transaction. There is no mutable like counter or repost table in the contract.

## Write behavior

The confirmed-post feed exposes three explicit controls:

- **Like** emits `LikeSet(Post, postId, account, true)`.
- **Unlike** emits `LikeSet(Post, postId, account, false)`.
- **Repost** emits `RepostPublished(postId, account)`.

Unlike is not deletion. It appends a new public event, and a derived view may treat the latest canonical `LikeSet` event for `(content kind, content ID, account)` as that account's current signal. Reposts are append-only actions; repeated reposts remain visible in history.

Before each write, the client rechecks the connected chain, selected account, and exact protocol runtime code. A successful receipt is accepted only when its canonical block contains the expected event from the predetermined contract with the exact post, account, like value, transaction hash, block hash, and block number.

If submission may have reached the wallet but no hash comes back, controls in that wallet context remain locked until the user checks wallet activity and acknowledges the ambiguity. If a hash returns but receipt verification becomes unavailable, they remain locked until the user checks or explicitly dismisses that hash. This avoids casually duplicating a repost whose status is unknown. Recovery records retain and display their original account, chain, and provider context; switching context does not mislabel them or lock unrelated chain activity.

The current UI reports transaction inclusion but does not claim a like state, count, or repost total. No optimistic local value is presented as chain truth.

## Read-model boundary

Reaction reads will use a separate bounded, reorg-aware event stream and disposable cache scope. They must not be mixed into the post cache's newest-50 page: a busy reaction stream could otherwise crowd every post out of the feed.

Likewise, issuing one historical `eth_getLogs` query per visible post would multiply RPC load. A later reducer should consume bounded global `LikeSet` and `RepostPublished` ranges, retain only validated canonical state, and expose honest synchronization progress. Counts are complete only after that independent stream catches up to its confirmed head.
