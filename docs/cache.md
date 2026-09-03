# Disposable browser event cache

Lifeinvader uses IndexedDB only as a local acceleration layer. It is not a hosted database, is never authoritative, and is not required to reconstruct the social graph. The canonical EVM log history remains the source of truth.

The initial cache implementation is `apps/web/src/event-cache.ts`.

## Version and scope

The IndexedDB database has an explicit schema version. An upgrade deletes the old object stores and creates the current schema instead of attempting to preserve derived data across incompatible versions.

Each independent event stream uses this scope:

```text
(cache schema, chainId, filterId, startBlock, finalityDepth)
```

The filter identifier commits to the normalized contract address and topics. Changing the contract, event family, deployment boundary, chain, or confirmation policy therefore selects another cache rather than silently reusing incompatible data.

## Stored records

The cache stores three record families:

- one independently persisted normalized event filter, generation token, baseline-authentication key, monotonic revision, and committed log-chain summary per scope;
- one validated synchronization cursor per scope;
- normalized event logs keyed by scope and fixed-width canonical position, each carrying its one-based ordinal and cumulative digest.

Each cache instance is bound to a normalized address/topic filter. The persisted copy is revalidated against that filter before cached logs are returned. The generation is a random 256-bit value created with browser Web Crypto. It stays stable while its independent scope record is valid. Separating it from the cursor means cursor-record loss cannot recreate an old compare-and-swap token; if the scope record itself is corrupt, recovery rotates to a fresh generation.

The position key is `(blockNumber, logIndex)`, because `logIndex` is the canonical block-wide event order. Fixed-width hexadecimal components preserve numeric order in IndexedDB without using unsupported `bigint` keys. A unique `(scope, blockNumber, logIndex)` identity index prevents the same EVM log from being stored under an alternate corrupted position. A separate scope index reaches every record for rollback validation and full cleanup even if corruption changes both canonical key copies or changes `position` to another valid IndexedDB key type. The log itself retains bigint quantities and is validated again after structured cloning; transaction indexes must remain monotonic with log indexes, map one-to-one to transaction hashes within each block, and never determine event order.

Reads use a descending key cursor and return 50 records by default. Callers may request at most 200 records in one page. The cursor continues through the complete block crossing the page boundary, capped by the maximum accepted synchronization batch, and reads one record from the preceding block as an ordering sentinel. These validation records are not returned. There is no `getAll` or unbounded local history load.

Reducers use a separate chronological scan. A request targets at most 200 oldest-first records, extends through the complete boundary block, and inspects one record from the following block as a sentinel. The boundary extension is hard-capped by the maximum 5,000-log synchronization batch, so a returned reducer page contains at most 5,199 records. Its continuation binds the exact cache generation, revision, cursor, starting boundary, last complete-block position, ordinal, and cumulative digest. It is also an exact, one-use continuation for a random in-memory scan session; substituting fields from another valid page, replaying a consumed continuation, reopening the cache, or changing the cache between pages requires restarting the bounded scan. Each cache instance retains at most 16 pending scan sessions.

A completed scan returns an authenticated baseline for a later append-only delta. The proof commits to the complete cursor, generation, revision, count, digest, and final position using a random per-scope key that is persisted but never exposed through the cache API, so it survives reopening the cache while caller-constructed canonical prefixes are rejected. Arbitrary caller-selected block boundaries are not accepted. Before using a proved baseline, the cache verifies that its terminal checkpoint remains in the current canonical checkpoint window and that the last record below its block boundary still matches the baseline's committed ordinal and digest. If the proof fails, its checkpoint has been reorganized, or the checkpoint has aged out, the caller must run a fresh full scan. A bounded set of completed scopes can also be reauthenticated together in one read-only transaction; this checks both scope positions, proofs, integrity summaries, and edge records against one atomic database snapshot. Every page advances the persisted hash chain through its returned records and validation sentinel. At local EOF, the observed count, digest, and final position must equal the scope summary before the page can claim completion. Missing anchors, missing records, encountered malformed records, noncanonical edge keys, filter violations, and inconsistent block or transaction metadata therefore cannot turn a partial local history into a complete result.

Normal scan work is proportional to the bounded page plus a constant number of edge and anchor reads. It performs no full-scope `count`, `getAll`, or unbounded local history load. A caller that must preserve this bound even after detecting corruption sets `resetOnCorruption: false`; the scan then aborts without deleting records and leaves cleanup to a later synchronization or explicit maintenance operation.

## Atomic synchronization

Applying a synchronization result uses one read-write transaction across scope, cursor, and log stores:

1. Compare the stored generation, revision, and cursor with the exact cache position used to start the RPC synchronization.
2. Reject the result if another synchronization advanced the cache first.
3. When `rollbackTo` is present, delete cached positions at or after that block.
4. Insert the validated canonical replacement and addition logs while extending their ordinal/digest chain.
5. Store the returned cursor, committed final count/digest/position, and incremented revision.

The transaction either commits all five effects or none. An explicit reorg rollback performs an exceptional local integrity walk through the scope index, validates every ordinal and cumulative digest plus each bounded block group, records the retained prefix summary, and deletes records according to their validated embedded block number. Replacement logs extend that retained prefix, so later bounded scans can verify the rewritten history without recounting it. This rollback is capped at 5,000 visited records; callers may select a lower cap, but never a higher one. If the stored count already exceeds the cap, or an inconsistent count hides an extra record, the transaction aborts without changing the cache and tells the user to clear the site's disposable browser data before starting bounded synchronization again.

The complete scope walk does not run during normal startup and prevents independently corrupted position and identity keys from hiding an orphaned event below both rollback seek boundaries. Full resets and explicit clears use the same scope index so malformed primary-key types cannot escape cleanup, and their deletion walks share the same hard cap. A repair that would exceed it also aborts atomically instead of stalling one UI action. The generation and revision prevent an ABA race when a reorg returns the cursor fields to an earlier value, so a stale tab cannot overwrite newer canonical history.

## Corruption and recovery

Persisted browser data is untrusted input. Filter membership, cursor structure, scope identity, schema markers, generation, baseline key, revision, log fields, key positions, ordering, cursor bounds, event identity, cumulative ordinal/digest integrity, and block-hash consistency are checked when records are read. Revision zero is valid only for a scope with no cursor and no logs. Each `(blockNumber, logIndex)` pair is unique. Logs from the same block must share a hash, agree with any checkpoint for that block, and still match the bound address/topic filter. When reset-on-corruption is enabled, validation and any required reset happen in the same read-write transaction, so a stale corruption response cannot erase a concurrent repair. Cursor or log corruption clears every indexed record in the scope, stores the fresh seed cursor, and increments the independent revision. Corrupt independent scope metadata instead rotates the generation and baseline key, ensuring recovery never recreates a previously issued token or proof. Strictly bounded projection scans disable that repair path, fail closed, and retain the corrupt records until the synchronization layer performs recovery outside the projection step.

If corruption is discovered while applying a batch, that same transaction resets the scope and the caller must synchronize again. Transport and quota errors are surfaced without pretending the cache committed.

Clearing IndexedDB, changing browsers, or opening the app on a new device affects performance only. It cannot remove or alter any on-chain Lifeinvader event.
