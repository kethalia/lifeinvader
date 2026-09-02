# Lifeinvader repository guidance

Lifeinvader is a static, serverless social client backed by ownerless EVM contracts. Keep changes small enough to review, preserve deterministic builds, and run the narrowest relevant checks before the full workspace checks.

## Development rules

- Use pnpm workspaces and Turborepo from the repository root.
- Keep the web application compatible with static IPFS hosting: do not add SSR, server routes, or absolute asset paths.
- Treat wallet addresses, chain identifiers, transaction hashes, block numbers, and log indexes as untrusted external data.
- Keep the core protocol ownerless, non-upgradeable, and independent of any mandatory hosted indexer or media provider.
- Never describe direct or group messages as private. Their plaintext and metadata are public blockchain data.

## Code Review Rules

### Protocol authority

- Flag any owner, administrator, proxy, pause, allowlist, fee-recipient, or privileged mutation path in the core protocol. The safe path is immutable event emission with no protocol operator.

### Static client boundary

- Flag runtime dependencies on application servers, server-side rendering, hosted databases, or mandatory vendor APIs. The safe path is a static build using wallet/RPC/IPFS transports selected in the browser.

### Chain history

- Flag unbounded `eth_getLogs` requests, full-history rescans on normal startup, or event ordering that ignores block hash and log index. The safe path is bounded, resumable, reorg-aware synchronization with an on-device cache.
