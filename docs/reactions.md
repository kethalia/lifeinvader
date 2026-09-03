# Post reactions and reposts

Lifeinvader v1 treats every reaction as another public transaction. There is no mutable like counter or repost table in the contract.

## Write behavior

The confirmed-post feed exposes three explicit controls:

- **Like** emits `LikeSet(Post, postId, account, true)`.
- **Unlike** emits `LikeSet(Post, postId, account, false)`.
- **Repost** emits `RepostPublished(postId, account)`.

Unlike is not deletion. It appends a new public event, and a derived view may treat the latest canonical `LikeSet` event for `(content kind, content ID, account)` as that account's current signal. Reposts are append-only actions; repeated reposts remain visible in history.

Before each write, the client rechecks the connected chain, selected account, and exact protocol runtime code. A successful receipt is accepted only when its canonical block contains the expected event from the predetermined contract with the exact post, account, like value, transaction hash, block hash, and block number.

If submission may have reached the wallet but no hash comes back, controls in that wallet context remain locked until the user checks wallet activity and acknowledges the ambiguity. If a hash returns but receipt verification becomes unavailable, they remain locked until the user checks or explicitly dismisses that hash. This avoids casually duplicating a repost whose status is unknown. Recovery records retain and display their original account, chain, and provider context; switching context does not mislabel them or lock unrelated chain activity. Pending operations use the same context keys, so a stalled RPC in one context cannot freeze another or clear its busy state when it eventually settles. The publish console also keeps recovery records independently, so beginning a write on another chain cannot erase an unresolved post or deployment. A late completion is retained under its original context, but it cannot replace another chain's confirmation target or clear a draft edited since that write began.

The current UI reports transaction inclusion but does not claim a like state, count, or repost total. No optimistic local value is presented as chain truth.

## Read-model boundary

Reaction reads use two separate bounded, reorg-aware event streams and disposable cache scopes. The post-like filter fixes indexed `contentKind` to `Post`, so comment traffic never enters that stream; reposts use their own filter. Neither is mixed into the post cache's newest-50 page, where reaction volume could otherwise crowd every post out of the feed.

Each synchronization invocation scans at most one adaptive block range per filter, for at most two bounded `eth_getLogs` calls in total, and resumes from independent browser-cache cursors. It verifies the exact protocol bytecode before reading, validates every decoded event before advancing either cursor, and rechecks both confirmed checkpoints against one final wallet-chain head after both filters finish. Chain changes and caller cancellation interrupt in-flight context reads, including contract-code inspection.

The stream API exposes up to 200 recent validated signals from each cache plus independent progress. It intentionally does not expose counts: a recent page is not complete history. A later reorg-safe reducer will consume the cached global streams and may call a total complete only after the corresponding cursor reaches its confirmed head.
