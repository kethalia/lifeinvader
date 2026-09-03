# Architecture baseline

This document records the boundaries that future Lifeinvader changes must preserve. Individual protocol decisions will receive focused design documents before their implementation.

## System boundary

Lifeinvader consists of three independently replaceable layers:

1. An ownerless EVM event protocol.
2. A browser indexer that derives views from canonical logs.
3. A static client that can be addressed and served by an IPFS CID.

The public chain is the source of truth. Browser storage is a disposable acceleration layer, and media storage is an optional service referenced by content identifiers.

## Core protocol

The core protocol is implemented without an owner, proxy, fee recipient, pause switch, or privileged mutation path. Social actions append events. Later actions may supersede earlier actions in the client-derived view, but cannot erase history.

The event schema supports efficient filters for the global feed, authors, referenced posts, conversations, and groups. Its payload limits, identifiers, and topic positions are specified in [`protocol-v1.md`](./protocol-v1.md).

The frozen creation bytecode and v1 salt use the canonical EIP-7997 CREATE2 factory. A chain is supported only when the expected factory code is available and the predetermined protocol address is empty or already contains the expected runtime code. Exact inputs and hashes are recorded in [`deployment.md`](./deployment.md).

## Static client

The web application uses React with Vite because it does not require a server runtime. Production assets use relative paths so a build remains usable beneath CID and gateway path prefixes. Client routes must not rely on an HTTP server fallback.

Injected wallets are discovered through EIP-6963 and submit writes through their EIP-1193 transport. The client compares exact code hashes before enabling deployment or publishing and repeats the protocol check immediately before every post. The initial [confirmed post feed](./feed.md) also reads through the connected wallet; independently configurable user-selected RPC transports can be added later. The application must not ship a mandatory vendor API key.

## Browser indexing

The browser indexer requests logs in bounded block ranges and emits canonical additions and rollback instructions. A versioned, disposable IndexedDB cache persists checkpoints and validated logs locally, or clears and rebuilds them when integrity checks fail. Screens request only the event families and indexed topics they need. A new device can always reconstruct its view from RPC without trusting a Lifeinvader service. The synchronization and rollback contract is specified in [`indexing.md`](./indexing.md), and the local transaction boundary is specified in [`cache.md`](./cache.md).

The global post feed is chain-derived and allows one bounded range per invocation. It never performs a full-history catch-up loop during normal page load. Other unfinished screens may contain fixture content only when fixtures are visibly identified and isolated from chain-derived models.

## Media

Posts may reference an IPFS root CID and an optional verifiable storage receipt. The core contract will not collect a media fee that it cannot turn into storage. Supported storage adapters should route user funds directly to storage providers or proof-linked payment contracts.

Media upload is not atomic with an EVM event: bytes must reach an IPFS or storage-provider node before a useful CID can be published. The interface must distinguish content addressing from proven persistence.

## Local validation

Contract tests use Foundry and Anvil. Browser wallet flows will be exercised against an isolated Anvil chain, including a fork when an integration depends on deployed chain contracts. No development milestone should require an IPFS deployment before the release phase.
