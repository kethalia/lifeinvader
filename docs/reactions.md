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

The UI never presents an optimistic local value as chain truth. It reports transaction inclusion immediately, while current-like state and totals remain hidden until the independent confirmed read model completes.

## Read-model boundary

Reaction reads use two separate bounded, reorg-aware event streams and disposable cache scopes. The post-like filter fixes indexed `contentKind` to `Post`, so comment traffic never enters that stream; reposts use their own filter. Neither is mixed into the post cache's newest-50 page, where reaction volume could otherwise crowd every post out of the feed.

Each synchronization invocation scans at most one adaptive block range per filter, for at most two bounded `eth_getLogs` calls in total, and resumes from independent browser-cache cursors. It verifies the exact protocol bytecode before reading, validates every decoded event before advancing either cursor, and rechecks both confirmed checkpoints against one final wallet-chain head after both filters finish. Before issuing an anchor, it also requires both terminal checkpoints to name the same safe-head block hash, so independently load-balanced RPC reads cannot combine histories from different forks. Chain changes and caller cancellation interrupt in-flight context reads, including contract-code inspection.

The stream API exposes up to 200 recent validated signals from each cache plus independent progress. It intentionally does not expose counts: a recent page is not complete history. Only when both cursors reach one jointly verified safe head does synchronization issue a projection anchor containing their exact cache generations, revisions, and canonical cursors. Partial catch-up never produces an anchor.

## Deterministic projection core

`apps/web/src/post-reaction-projection.ts` implements the in-memory reduction rules without adding RPC work or treating recent events as lifetime totals. It consumes separately ordered post-like and repost log pages, revalidates and decodes every record, requires each later page to begin in a newer block, and caps input at the event cache's maximum 5,199-record complete-block page. A malformed later record rejects the whole page before any derived state changes.

For likes, the projection retains only active `(postId, account)` pairs and exact per-post `bigint` counts. Repeating the same state is idempotent; a transition from liked to unliked decrements once, and a later like increments once. Every canonical repost event increments its post's `bigint` total, including repeated reposts from one account, because the protocol defines reposts as append-only public actions. Account-specific queries normalize the address before checking active membership.

The core exports a schema-versioned snapshot containing canonical active-like pairs, repost totals, both last applied event positions, a jointly authenticated confirmed-through checkpoint, and a sorted block-number/hash frontier. Every bounded input page is checked against retained fingerprints in work proportional to that page. After both cache baselines authenticate, the projection run records their shared safe-head checkpoint even when one stream contains no events. Explicit snapshot creation can then remove fingerprints below both effective stream boundaries because neither stream may overlap those blocks again. The first snapshot therefore performs deliberate state-proportional serialization and compaction, while later snapshots and summary queries retain only the live frontier. Like counts are deliberately omitted and re-derived from the active pairs when restoring, so redundant persisted counters cannot disagree. Entries are normalized and numerically sorted before a domain-separated digest is computed; equivalent states therefore have one deterministic commitment regardless of insertion order. Restored progress and confirmed coverage continue to enforce complete-block delta boundaries.

The core deliberately does not claim snapshot completeness on its own; only the authenticated projection run may publish it to the feed.

## Bounded projection runs

`apps/web/src/post-reaction-projection-run.ts` connects a jointly verified synchronization anchor to the projection core. Each explicit `advance()` performs one bounded cache operation: it completes chronological like pages first, then repost pages, then authenticates both completed baselines together. It performs no RPC calls and never hides a full-history loop behind one invocation. Complete-block expansion remains capped by the cache and projection limits.

Every page must retain the anchor's exact cursor, generation, and revision. A concurrent cache update, reset, malformed page, consumed continuation, or projection error fails the run closed and discards all partially derived state. Projection scans disable inline corruption repair, so discovery aborts without an unbounded scope deletion; the next synchronization owns disposable-cache cleanup. The completed page's authenticated log count and tail must also match what the projection actually consumed.

Summaries, the canonical projection snapshot, and completed baselines throw until both streams finish and one read-only IndexedDB transaction reauthenticates both snapshots. That transaction checks each scope's proof, generation, revision, cursor, integrity summary, and edge records atomically, catching a rollback, reset, append, or corruption before publication. Once complete, a summary is exact as of the anchor's recorded safe head, and defensive copies of both authenticated baselines are available for a future delta layer. The current run intentionally performs an initial rebuild only; persisting derived state and applying append-only deltas will be a separate change.

## Feed read controls

The feed performs no reaction RPC work merely because a wallet connected. **Load reaction counts** explicitly runs one synchronization invocation: at most one bounded range for likes and one for reposts. Each exceptional reorg may inspect at most a 5,000-record changed suffix in either stream, regardless of total retained history. Canonical records can be cleared with one IndexedDB range request; malformed-key cleanup retains the fixed ceiling. If either cursor still has confirmed history remaining, the UI reports both positions and requires another **Load next reaction range** action.

Once the two cache cursors produce a shared projection anchor, no more RPC calls are needed for the initial read model. Each **Process next local reaction page** action invokes exactly one cache scan or final baseline-authentication step. Counts and current-account like state remain absent from every post card until the run completes; the displayed totals are then labeled with their exact confirmed block. A provider or chain change aborts a network read, closes an open local run, clears published totals, and ignores late results from the old context.
