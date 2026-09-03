# Lifeinvader

Lifeinvader is a deliberately public, permissionless social network. Its static client is designed to run from IPFS, while posts and social interactions are reconstructed directly from EVM event logs.

The project is an unofficial parody inspired by the fictional social network in Grand Theft Auto V. It is not affiliated with or endorsed by Rockstar Games or Take-Two Interactive, and it does not use their artwork or game assets.

## Product principles

- No Lifeinvader application server or hosted database.
- No protocol owner, administrator, upgrade key, or deletion authority.
- Posts, comments, reposts, reactions, follows, public direct messages, and group messages are on-chain actions.
- "Direct messages" are intentionally public. The interface must never imply otherwise.
- Media is content-addressed; paid persistence will be handled through optional storage-market integrations without turning the core protocol into a treasury.
- RPC history is fetched in bounded ranges and cached only on the user's device.

## Workspace

This repository is a pnpm and Turborepo monorepo.

```text
apps/web/           Static React and Vite client
packages/contracts/ Ownerless event protocol and Foundry tests
docs/               Protocol and architecture decisions
```

### Prerequisites

- Node.js 24 or newer
- pnpm 11.21.0 (Corepack can install the pinned version)
- Foundry 1.7 or newer

### Commands

```bash
corepack enable
pnpm install
pnpm check
pnpm test
pnpm build
```

Run the web client with `pnpm dev`. Contract-only commands can be run with `pnpm --filter @lifeinvader/contracts test`.

The current client discovers injected wallets, verifies or permissionlessly deploys the predetermined protocol, publishes text and optional canonical IPFS CID commitments, reconstructs a confirmed global feed through bounded wallet-RPC reads, and writes explicit like, unlike, and repost events for confirmed posts. Feed behavior and its deliberate work budget are documented in [`docs/feed.md`](./docs/feed.md); reaction semantics are documented in [`docs/reactions.md`](./docs/reactions.md), and the distinction between a CID and paid persistence is documented in [`docs/media.md`](./docs/media.md).

## Protocol address

On supported EVM chains, Lifeinvader v1 deterministically deploys to `0x779DEb5AD0B27BF40BDBFF3A81caB2d9049d7ad1`. Deployment is permissionless and grants the sender no role. The frozen CREATE2 inputs and local deployment workflow are documented in [`docs/deployment.md`](./docs/deployment.md).

The project is under active construction. Nothing has been deployed to an EVM network or IPFS.
