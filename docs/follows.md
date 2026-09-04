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
account scope and is rebuilt from block zero.

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
wallet context and canonical-checkpoint proof cross the provider boundary. The
follow write helper and UI remain separate milestones, so this is not yet a
user-visible follower count.
