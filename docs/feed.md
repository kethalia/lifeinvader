# Confirmed post feed

The first chain-derived screen is the global `PostPublished` feed. It is implemented by `apps/web/src/post-feed.ts` and `apps/web/src/post-feed-panel.tsx`; there is no feed API, hosted indexer, or database behind it.

## Read transport and scope

The initial UI reads through the connected wallet's EIP-1193 provider. This makes the selected chain explicit and avoids shipping a vendor endpoint or API key. Before any cache or log work, the synchronizer requires the exact Lifeinvader v1 runtime code at the predetermined address; an ABI-compatible event from conflicting bytecode is never presented as protocol history. A later transport picker can provide a separate user-selected RPC without changing the feed synchronizer.

The feed cursor starts at block zero because permissionless deterministic deployment can happen at a different height on every chain. Supported-chain metadata may later provide a verified deployment block as an optimization. Until then, progress is honest and resumable rather than assuming an unverified boundary.

Every chain uses a twelve-block confirmation depth, including chain ID `31337`. A familiar chain identifier is not proof that an endpoint is the expected local Anvil instance. Local integration tests mine the confirmation blocks explicitly.

## Work budget

One feed synchronization invocation permits exactly one bounded indexer range. Connecting a wallet performs one invocation. Local reorg rollback and corrupt-cache cleanup are separately capped at 5,000 stored records; an operation above that ceiling aborts atomically and requires the user to clear the site's disposable browser data rather than hiding a full-history maintenance walk behind one action. After a post receipt arrives, a separate confirmation monitor reads chain ID, head height, and the current receipt every twelve seconds, for at most 30 minutes and 240 attempts. At the target depth it brackets a fresh chain/head reading with two exact candidate-block reads and verifies the expected `PostPublished` event. Earlier and later re-inclusions both replace the candidate height; a reverted replacement is terminal only after that replacement is canonical and twelve blocks deep. The monitor triggers one feed invocation only after that canonical evidence is safe. If history remains, the interface exposes a **Load next block range** button; it does not automatically loop toward the head on page load.

Each invocation follows one compare-and-swap cycle:

1. Read the chain/filter-scoped cursor and newest cached page.
2. Run one bounded `syncEventLogs` call through the selected provider.
3. Atomically apply additions or rollback data to IndexedDB.
4. Read and strictly decode at most 50 newest cached posts, accepting the snapshot only if its generation, revision, and cursor still identify the commit from step 3.
5. Bracket a fresh chain-ID/head read with exact block-hash reads of the committed endpoint, rejecting the snapshot if that checkpoint changed or no longer has the twelve-block depth. The displayed head status is derived only from this final reading.

Changing provider or chain aborts active synchronization and confirmation monitoring and clears the rendered snapshot before starting the new scope. A late result from an old scope cannot replace the new view. Cross-tab cache conflicts—including a change between apply and the final read—are surfaced for an explicit retry rather than hidden behind an unbounded retry loop.

## Presentation boundary

Posts are ordered newest first by canonical `(blockNumber, logIndex)` cache order. The interface shows author, post identifier, block number, transaction hash, text, and supported media commitments as canonical CIDv1 text. Invalid or unsupported on-chain CID bytes are visibly isolated instead of poisoning the feed. Confirmed cards can publish comments and render exact confirmed histories after the independent comment read model completes. It does not fetch media from a gateway or paginate beyond the newest 50 cached posts. Reactions and comments use independent, explicitly stepped read models so their higher-volume logs never crowd posts out of this page or cause one RPC request per card.

Confirmed post cards can submit like, unlike, and repost events. These controls verify their exact receipt events and never display optimistic counts. Exact confirmed counts and current-like state appear only after the independent bounded read model specified in [`reactions.md`](./reactions.md) completes.

The UI never labels cached data as authoritative. Cache corruption causes the disposable scope to rebuild; EVM logs remain the source of truth.
