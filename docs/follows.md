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

The follow write helper, complete-state projection, and UI are separate
milestones. Until those land, this module is an indexing foundation rather
than a user-visible follower count.
