# Confirmed post feed

The first chain-derived screen is the global `PostPublished` feed. It is implemented by `apps/web/src/post-feed.ts` and `apps/web/src/post-feed-panel.tsx`; there is no feed API, hosted indexer, or database behind it.

## Read transport and scope

The initial UI reads through the connected wallet's EIP-1193 provider. This makes the selected chain explicit and avoids shipping a vendor endpoint or API key. A later transport picker can provide a separate user-selected RPC without changing the feed synchronizer.

The feed cursor starts at block zero because permissionless deterministic deployment can happen at a different height on every chain. Supported-chain metadata may later provide a verified deployment block as an optimization. Until then, progress is honest and resumable rather than assuming an unverified boundary.

Every chain uses a twelve-block confirmation depth, including chain ID `31337`. A familiar chain identifier is not proof that an endpoint is the expected local Anvil instance. Local integration tests mine the confirmation blocks explicitly.

## Work budget

One feed synchronization invocation permits exactly one bounded indexer range. Connecting a wallet performs one invocation. Publishing a confirmed post performs one more. If history remains, the interface exposes a **Load next block range** button; it does not automatically loop toward the head on page load.

Each invocation follows one compare-and-swap cycle:

1. Read the chain/filter-scoped cursor and newest cached page.
2. Run one bounded `syncEventLogs` call through the selected provider.
3. Atomically apply additions or rollback data to IndexedDB.
4. Read and strictly decode at most 50 newest cached posts.

Changing provider or chain aborts the active RPC work and clears the rendered snapshot before starting the new scope. A late result from an old scope cannot replace the new view. Cross-tab cache conflicts are surfaced for an explicit retry rather than hidden behind an unbounded retry loop.

## Presentation boundary

Posts are ordered newest first by canonical `(blockNumber, logIndex)` cache order. The interface shows author, post identifier, block number, transaction hash, text, and any raw on-chain media CID bytes. It does not currently fetch media from a gateway, paginate beyond the newest 50 cached posts, or derive comments and reactions. Those are separate reviewable slices.

The UI never labels cached data as authoritative. Cache corruption causes the disposable scope to rebuild; EVM logs remain the source of truth.
