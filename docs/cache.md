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

- one independently persisted normalized event filter, generation token, and monotonic revision per scope;
- one validated synchronization cursor per scope;
- normalized event logs keyed by scope and fixed-width canonical position.

Each cache instance is bound to a normalized address/topic filter. The persisted copy is revalidated against that filter before cached logs are returned. The generation is a random 256-bit value created with browser Web Crypto. It stays stable while its independent scope record is valid. Separating it from the cursor means cursor-record loss cannot recreate an old compare-and-swap token; if the scope record itself is corrupt, recovery rotates to a fresh generation.

The position key is `(blockNumber, logIndex)`, because `logIndex` is the canonical block-wide event order. Fixed-width hexadecimal components preserve numeric order in IndexedDB without using unsupported `bigint` keys. A unique `(scope, blockNumber, logIndex)` identity index prevents the same EVM log from being stored under an alternate corrupted position. A separate scope index reaches every record for rollback validation and full cleanup even if corruption changes both canonical key copies or changes `position` to another valid IndexedDB key type. The log itself retains bigint quantities and is validated again after structured cloning; transaction indexes must remain monotonic with log indexes, map one-to-one to transaction hashes within each block, and never determine event order.

Reads use a descending key cursor and return 50 records by default. Callers may request at most 200 records in one page. The cursor continues through the complete block crossing the page boundary, capped by the maximum accepted synchronization batch, and reads one record from the preceding block as an ordering sentinel. These validation records are not returned. There is no `getAll` or unbounded local history load.

Reducers use a separate chronological scan. A request targets at most 200 oldest-first records, extends through the complete boundary block, and inspects one record from the following block as a sentinel. The boundary extension is hard-capped by the maximum 5,000-log synchronization batch, so a returned reducer page contains at most 5,199 records. A scan may start at an explicit block boundary for an append-only delta. Its continuation binds the exact cache generation, revision, cursor, start block, and last complete-block position; any cache update between pages rejects that continuation instead of mixing histories. Missing anchors, encountered malformed records, noncanonical key types, filter violations, and inconsistent block or transaction metadata reset the disposable scope. No scan calls `getAll` or loads an unbounded local history.

## Atomic synchronization

Applying a synchronization result uses one read-write transaction across scope, cursor, and log stores:

1. Compare the stored generation, revision, and cursor with the exact cache position used to start the RPC synchronization.
2. Reject the result if another synchronization advanced the cache first.
3. When `rollbackTo` is present, delete cached positions at or after that block.
4. Insert the validated canonical replacement and addition logs.
5. Store the returned cursor and incremented revision.

The transaction either commits all five effects or none. An explicit reorg rollback performs an exceptional local integrity walk through the scope index, validates each bounded block group, and deletes records according to their validated embedded block number. That complete scope walk does not run during normal startup and prevents independently corrupted position and identity keys from hiding an orphaned event below both rollback seek boundaries. Full resets and explicit clears use the same scope index so malformed primary-key types cannot escape cleanup. The generation and revision prevent an ABA race when a reorg returns the cursor fields to an earlier value, so a stale tab cannot overwrite newer canonical history.

## Corruption and recovery

Persisted browser data is untrusted input. Filter membership, cursor structure, scope identity, schema markers, generation, revision, log fields, key positions, ordering, cursor bounds, event identity, and block-hash consistency are checked when records are read. Revision zero is valid only for a scope with no cursor and no logs. Each `(blockNumber, logIndex)` pair is unique. Logs from the same block must share a hash, agree with any checkpoint for that block, and still match the bound address/topic filter. Validation and any required reset happen in the same read-write transaction, so a stale corruption response cannot erase a concurrent repair. Cursor or log corruption clears every indexed record in the scope, stores the fresh seed cursor, and increments the independent revision. Corrupt independent scope metadata instead rotates the generation, ensuring recovery never recreates a previously issued token.

If corruption is discovered while applying a batch, that same transaction resets the scope and the caller must synchronize again. Transport and quota errors are surfaced without pretending the cache committed.

Clearing IndexedDB, changing browsers, or opening the app on a new device affects performance only. It cannot remove or alter any on-chain Lifeinvader event.
