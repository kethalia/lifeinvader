# Public follow streams

`FollowSet(follower, followed, following)` is an append-only public signal. A
`true` event makes the pair active in a derived view; a later `false` event for
the same ordered pair makes it inactive. Neither event erases the earlier one,
and the protocol stores no follower list or aggregate count.

Self-follows and either zero address are impossible in Lifeinvader v1. The web
decoder nevertheless enforces those invariants, requires exactly two indexed
address topics and one canonical ABI boolean word, and rejects malformed cache
or RPC data before it can enter a projection.

## Exact account filters

Follower and following views use separate filters rather than scanning the
global event family:

```text
following(account): [FollowSet topic, account]
followers(account): [FollowSet topic, null, account]
```

The wildcard is only the follower position of the exact incoming-account
query. Each direction has a distinct filter identity and therefore a distinct
disposable IndexedDB cursor and log scope. Decoded records are checked against
the selected account again after retrieval and after cache reads.

## Bounded synchronization

One synchronization call performs at most one bounded log range. It verifies
the selected chain before and after protocol inspection, requires the exact v1
runtime code at the predetermined address, and rechecks retained block
fingerprints around cache mutation. A result is considered caught up only when
its cursor reaches the twelve-block safe head and that head is represented by
the final canonical checkpoint.

Before a fresh follow cursor is created, the client resolves a conservative
protocol-history boundary through `protocol-history.ts`. It anchors one head by
hash, checks the exact v1 runtime-code hash, and performs a sequential binary
search capped at 64 historical `eth_getCode` probes. A confirmed result is
accepted only when the deployment block contains v1, its preceding block is
empty, and the original head is still canonical. If deployment is newer than
the twelve-block boundary, the cursor starts immediately after the last block
proven empty so it cannot skip a confirmed event.

Successful results are reused in memory for the same provider, chain, and
confirmation policy only after the cached head hash is reauthenticated. This
prevents a reset local fork that reuses chain ID `31337` from inheriting a stale
boundary. The same anchored head is checked again after the bounded log request
and before its cache mutation. A replaced anchor discards that result and
retries discovery once; a second replacement fails without applying the stale
result. If an RPC explicitly cannot serve historical code, the optimization
falls back to block zero; malformed data, conflicting historical code, a chain
change, or a replaced anchor fails closed. Code probes are sequential and do
not fan out alongside the one bounded log request.

The stream returns at most the newest 200 validated signals as a preview. That
preview is not enough to calculate relationship state. Once caught up, the
stream instead issues an immutable, page-local projection anchor containing
the exact cache generation, revision, cursor, account, direction, head, and
safe head. A later projection must authenticate that capability and scan the
complete cache in bounded local pages before exposing active relationships or
counts.

Changing the provider or chain aborts in-flight work. External cancellation
also interrupts wallet and cache authentication and removes temporary wallet
listeners. A malformed cached page is cleared only for its exact directional
account and discovered-start scope, then rebuilt from that same safe boundary.

## Deterministic relationship projection

`FollowProjection` reduces complete, strictly ordered pages for one normalized
account and one direction. Outgoing projections key active relationships by the
followed account; incoming projections key them by the follower. Every decoded
event is checked against that selected scope before a page can mutate state,
and the latest signal for each ordered pair wins.

Active relationships are indexed by address, so reads return stable ascending
pages without sorting or copying the entire result set. Each read is capped at
200 relationships. Progress records the signal count, active count, last log,
and monotonic confirmed checkpoint, while results and progress are returned as
defensive copies. Resetting clears only derived state and preserves the selected
account and direction.

The projection intentionally accepts only later complete-block pages. It does
not trust or consume the recent stream preview, and it exposes no global count.

## Authenticated projection runs

A projection run accepts only the exact immutable anchor issued by the current
page. It reconstructs that anchor's filter from the account and direction,
checks the cursor scope and safe-head boundary, and scans at most one bounded
local-cache page per explicit `advance()` call. A dense block stays intact even
when it exceeds the requested page size.

When scanning reaches the frozen tail, the runner compares the complete log
count and last position with the cache baseline. It then authenticates that
baseline, brackets provider chain/head/checkpoint verification with another
exact cache proof, and only afterward marks the projection complete. Completed
relationship pages, final counts, projection progress, and the reusable
baseline cannot be read before that point; the run snapshot exposes only
explicitly provisional work counters. Cache changes, reorgs, chain changes,
malformed pages, cancellation, or closure discard all partial derived state.

Projection steps do not request more logs from the RPC endpoint; only the final
wallet context and canonical-checkpoint proof cross the provider boundary.

## React read lifecycle

The follow read model remains idle until it has a connected wallet provider, a
valid nonzero account to browse, and an explicit direction. Each user action
either synchronizes one bounded RPC range or advances one bounded local
projection page. Catch-up previews remain visibly incomplete; relationship
lookups and pages return no value until the authenticated projection reaches
`complete`.

Read-model state is bound to the provider object, chain, normalized account, and
direction. Changing any of them aborts in-flight stream work, closes an active
projection, and ignores late results. A deferred corruption error resets only
that exact directional account cache before offering a retry; if IndexedDB
cannot be reset, the current page reports that browser data must be cleared.

## Receipt-authenticated writes

The browser submits `setFollow(followed, following)` only after rejecting an
invalid, zero, or self target and binding the action to the click-time wallet
account and chain. A transaction is not reported as successful merely because
it was mined: its canonical receipt must contain the exact v1 `FollowSet` event
for the selected follower, followed account, and boolean state. Wallet
rejections remain retryable, while an ambiguous provider failure preserves the
possibility that the transaction was broadcast.

## Visible account browser

The lazy-loaded follow panel accepts any nonzero EVM account and exposes exact
incoming or outgoing relationships only after the stream catches up and the
complete local projection authenticates. Each explicit click performs one
bounded RPC range or one bounded local projection step. Completed results are
read in address-ordered pages of at most 25 relationships.

The same panel lets the connected account publish an explicit follow or
unfollow for another address. It keeps pending, ambiguous, unknown, reverted,
and confirmed outcomes attached to the wallet context that created them. A
confirmed write does not bypass the twelve-block read depth; the user must wait
for confirmation and explicitly refresh the relevant account view.
