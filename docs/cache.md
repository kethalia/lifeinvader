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

The cache stores two record families:

- one validated synchronization cursor and monotonic revision per scope;
- normalized event logs keyed by scope and fixed-width canonical position.

The position key is `(blockNumber, transactionIndex, logIndex)`. Fixed-width hexadecimal components preserve numeric order in IndexedDB without using unsupported `bigint` keys. The log itself retains bigint quantities and is validated again after structured cloning.

Reads use a descending key cursor and stop after 50 records by default. Callers may request at most 200 records in one page. There is no `getAll` or unbounded local history load.

## Atomic synchronization

Applying a synchronization result uses one read-write transaction across cursor and log stores:

1. Compare the stored cursor and revision with the exact cache position used to start the RPC synchronization.
2. Reject the result if another synchronization advanced the cache first.
3. When `rollbackTo` is present, delete cached positions at or after that block.
4. Insert the validated canonical replacement and addition logs.
5. Store the returned cursor and incremented revision.

The transaction either commits all five effects or none. The revision prevents an ABA race when a reorg returns the cursor fields to an earlier value, so a stale tab cannot overwrite newer canonical history.

## Corruption and recovery

Persisted browser data is untrusted input. Cursor structure, scope identity, schema markers, revision, log fields, key positions, ordering, and cursor bounds are checked when records are read. Validation and any required reset happen in the same read-write transaction, so a stale corruption response cannot erase a concurrent repair. A malformed page clears its logs, stores the fresh seed cursor with an incremented revision, and asks the caller to rebuild from RPC.

If corruption is discovered while applying a batch, that same transaction resets the scope and the caller must synchronize again. Transport and quota errors are surfaced without pretending the cache committed.

Clearing IndexedDB, changing browsers, or opening the app on a new device affects performance only. It cannot remove or alter any on-chain Lifeinvader event.
