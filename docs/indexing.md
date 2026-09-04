# Browser event indexing

Lifeinvader derives every view from EVM logs without a hosted indexer. The browser indexer is split into two layers:

1. A transport-independent synchronization engine reads bounded canonical ranges.
2. A [disposable on-device cache](./cache.md) applies the engine's additions and rollback instructions atomically.

The first layer is implemented in `apps/web/src/event-indexer.ts`. It accepts any EIP-1193-shaped read transport, so reads do not need to remain coupled to an injected wallet.

`apps/web/src/http-rpc.ts` provides the bounded browser transport for a user-selected endpoint. Constructing it performs no request and persists nothing. It accepts HTTPS endpoints plus explicit HTTP loopback URLs for local Anvil work, omits ambient credentials and referrers, rejects redirects, and refuses every wallet or signing method before touching the network. Its allowlist is limited to the seven chain-read methods used by Lifeinvader.

One transport permits at most four active requests and 32 active-or-queued requests. Every request has one absolute 15-second deadline measured from enqueue, a 64 MiB response ceiling, and no automatic retry; an expired queued request is rejected without being sent. Responses are streamed only up to that ceiling, decoded as strict UTF-8 JSON, and accepted only when the JSON-RPC version and numeric request identifier match and exactly one of `result` or `error` is present. The provider exposes an optional cancellable request extension used by every Lifeinvader synchronization boundary, so caller cancellation and shorter operation deadlines abort the underlying HTTP fetch rather than merely abandoning its promise. Closing a transport likewise aborts active fetches and rejects queued work.

## User-selected read RPC

The endpoint selector remains inert until a connected user explicitly chooses **Verify and use RPC**. One verification shares a 15-second deadline and makes four sequential-stage reads from each side: chain ID before and after the proof, current head, and one block header. It chooses the lower reported head, trails that by twelve blocks when possible, and requires the endpoint and wallet to return the same number and hash for that common block. A reused chain ID on another fork therefore fails before the transport can enter a read model.

That match is not treated as permanent. The selected transport retains the wallet as a low-volume history anchor: every chain-identity boundary rechecks the original confirmed block against both providers, every later block fingerprint is compared with the wallet, and the usable head is the lower of the two reported heads. A deep replacement of the original checkpoint or a load-balanced endpoint moving to divergent history fails closed and requires explicit reverification. Transaction receipts for wallet-submitted posts stay on the wallet provider, while bounded log and protocol-history payloads use the selected endpoint. These checks establish fork continuity; they do not turn arbitrary JSON-RPC responses into cryptographic inclusion proofs, so the interface explicitly warns that a chosen endpoint can return false data.

The full endpoint URL exists only in React state and the selected in-memory transport. It is not written to web storage, a query string, the chain, or any Lifeinvader service; after selection, the interface clears the input and displays only the URL origin. Replacing the endpoint, changing wallet provider or chain, returning to wallet reads, or unmounting the app closes the old transport and aborts its work. The selected provider scopes and resets feed, comment, reaction, and connected-profile read models by object identity. Post, comment, reaction, and profile writes still receive the original injected wallet provider.

## Cursor identity

An event cursor is scoped to:

```text
(chainId, normalized address and topic filter, startBlock, finalityDepth)
```

The normalized filter is stored as a fixed-size hash. Topic alternatives are deduplicated and sorted before hashing, so equivalent filters share a cursor. A cursor for another filter or chain is rejected before log requests begin.

The start block and finality depth are explicit cursor inputs. Every first-party event stream obtains that input from a separately verified, bounded protocol-code discovery. The scanner never silently requests `0x0` through `latest` in one call. Changing the discovered boundary or confirmation policy selects a fresh cursor and cache rather than reinterpreting already accepted ranges.

## Protocol history boundary

`protocol-history.ts` reads code at explicit block numbers as permitted by Ethereum JSON-RPC [`eth_getCode`](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getcode), then binary-searches the empty-code to exact-v1-code transition. One attempt makes at most 64 sequential code requests under one timeout. It records the exact deployment and preceding block fingerprints, or—when deployment has not reached the configured safe head—the first block after confirmed emptiness.

Confirmed boundaries are reused only while their anchored head remains canonical. A pending boundary is deliberately rediscovered on the next explicit check: reaching the first block after confirmed emptiness does not prove where the deployment occurred. Streams that expose pending state therefore withhold log and contract-state reads until discovery can prove the deployment block itself is confirmed.

The search is bracketed by selected-chain checks and two reads of one anchored head. Boundary code is re-read before acceptance. Each adopting stream carries that head fingerprint through its bounded log scan and reauthenticates it before applying the result to IndexedDB. If it changed, the scan result is discarded without applying it. Readers with a strict one-range interaction budget, including reactions, direct messages, the global group directory, selected-group membership, and selected-group messages, fail immediately rather than repeating that range; other readers may rediscover once within their documented budget. This provides the same portable numeric-block compatibility as the event scanner while detecting a reorganization that changes the anchored ancestry. Only an RPC failure recognized as unavailable or pruned archival state is a safe optimization miss: the stream starts at genesis instead. Rate limits, transport failures, and local deadlines are propagated without starting a log scan because retrying or falling back could amplify a transient failure while the underlying wallet request may still be pending. Invalid code, a non-monotonic conflict, malformed quantities or blocks, cancellation, and context changes are not downgraded to a fallback.

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
