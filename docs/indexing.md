# Browser event indexing

Lifeinvader derives every view from EVM logs without a hosted indexer. The browser indexer is split into two layers:

1. A transport-independent synchronization engine reads bounded canonical ranges.
2. A [disposable on-device cache](./cache.md) applies the engine's additions and rollback instructions atomically.

The first layer is implemented in `apps/web/src/event-indexer.ts`. It accepts any EIP-1193-shaped read transport, so a later UI can use a user-selected HTTP RPC without coupling reads to an injected wallet.

## Cursor identity

An event cursor is scoped to:

```text
(chainId, normalized address and topic filter, startBlock, finalityDepth)
```

The normalized filter is stored as a fixed-size hash. Topic alternatives are deduplicated and sorted before hashing, so equivalent filters share a cursor. A cursor for another filter or chain is rejected before log requests begin.

The start block and finality depth are explicit cursor inputs. Post, comment, follow, and profile streams now obtain that input from a separately verified, bounded protocol-code discovery; other event families continue to use block zero while the optimization is integrated incrementally. The scanner never silently requests `0x0` through `latest` in one call. Changing the discovered boundary or confirmation policy selects a fresh cursor and cache rather than reinterpreting already accepted ranges.

## Protocol history boundary

`protocol-history.ts` reads code at explicit block numbers as permitted by Ethereum JSON-RPC [`eth_getCode`](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getcode), then binary-searches the empty-code to exact-v1-code transition. One attempt makes at most 64 sequential code requests under one timeout. It records the exact deployment and preceding block fingerprints, or—when deployment has not reached the configured safe head—the first block after confirmed emptiness.

The search is bracketed by selected-chain checks and two reads of one anchored head. Boundary code is re-read before acceptance. Each adopting stream carries that head fingerprint through its bounded log scan and reauthenticates it before applying the result to IndexedDB. If it changed, the scan result is discarded and boundary discovery is retried once; repeated movement fails without applying either result. This provides the same portable numeric-block compatibility as the event scanner while detecting a reorganization that changes the anchored ancestry. A settled provider rejection on a historical code request is a safe optimization miss: the stream starts at genesis instead. A local deadline is propagated without starting a log scan because the underlying wallet request may still be pending. Invalid code, a non-monotonic conflict, malformed quantities or blocks, cancellation, and context changes are not downgraded to a fallback.

## Bounded synchronization

`syncEventLogs` limits work in several independent dimensions:

- A log request covers no more than 10,000 blocks, with a 2,000-block initial range.
- One invocation attempts at most four ranges by default and sixteen at the hard limit.
- One range accepts at most 2,000 logs and one invocation returns at most 5,000 logs.
- An accepted range verifies at most 32 distinct log-bearing blocks by default (128 at the hard limit). Denser ranges are split before header reads begin.
- Log data, topic counts, topic alternatives, quantities, hashes, indexes, cursor checkpoints, time, and rollback probes are all bounded before expensive processing.
- Requests and log-bearing block checks are sequential within a range. There is no fan-out across historical ranges.

When an RPC explicitly reports that a block range or result set is too large, the engine halves the range and retries within the same attempt budget. Rate-limit and transport errors are returned to the caller instead of being mistaken for range pressure and amplified through retries. Sparse successful ranges grow gradually up to the configured and hard limits.

The engine returns `caughtUp: false` when its work budget ends before the safe head. A caller schedules another bounded invocation rather than turning one page load into an unbounded history scan.

The entire invocation shares one timeout and supports `AbortSignal` cancellation. Wallet chain changes and disconnects interrupt any in-flight RPC request and invalidate the invocation. Provider and cancellation listeners are always removed when synchronization settles.

## Canonical snapshots and rollback

The default safe head trails the reported head by twelve blocks. Chain integrations may choose a different finality depth when creating the cursor, including zero for isolated Anvil testing. If a sampled safe head is temporarily behind the cursor's newest checkpoint, synchronization fails without issuing a rollback. This protects the cache from a lagging load-balanced RPC node; a later sample can resume normally.

For each range, the engine:

1. Reads the range-end block fingerprint.
2. Requests and locally validates matching logs with explicit `fromBlock`, `toBlock`, address, and topics.
3. Reads the canonical header for every distinct log-bearing block under the configured bound.
4. Rechecks the preceding checkpoint when one exists.
5. Reads the range-end fingerprint again.
6. Accepts the range only when both end fingerprints match, the previous checkpoint remains canonical, and every log hash matches its canonical block.

The accepted endpoint becomes a checkpoint. A final checkpoint validation is the last RPC read before the result is returned. This catches a reorganization during parsing, adaptation, or an otherwise unaccepted final attempt.

On resume, the newest checkpoint is compared with the current canonical block. A different hash rolls back checkpoints until a common canonical endpoint is found. A `null` block response is treated as unavailable history and fails without rollback because absence is not evidence of a reorg. `rollbackTo` tells the cache to delete every stored log at or after that block before applying the returned logs. If the bounded rollback search cannot find a common checkpoint, the cursor resets to `startBlock` and requests a full cache rebuild.

Only the latest 64 checkpoints are retained. Their newest canonical hash commits to the earlier ancestry. A reorganization deeper than the retained window therefore causes a safe rebuild instead of trusting unverifiable cached history.

## Untrusted RPC data

RPC responses are treated as external input. Quantities must use canonical bounded hexadecimal encoding. Hashes, addresses, data, topics, block membership, transaction indexes, log indexes, removal state, filter membership, and duplicate positions are validated locally. A positional wildcard still requires that topic position to exist. Logs are sorted by the block-wide canonical event order:

```text
(blockNumber, logIndex)
```

Within a block, transaction indexes must be monotonic with that order. One transaction index must map to one transaction hash and one hash must map back to one index. Transaction positions are retained as validated metadata but never control reducer order.

Malformed or mismatched responses fail the invocation without mutating the input cursor. The cache layer must likewise treat persisted cursor and log records as disposable and versioned.

The request shapes follow the [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getlogs) `eth_getLogs` and `eth_getBlockByNumber` definitions. [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898) hash-bound state reads do not apply to multi-block `eth_getLogs` ranges, so the engine uses explicit before/after block fingerprints instead.
