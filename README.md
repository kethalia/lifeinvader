# Lifeinvader

Lifeinvader is a deliberately public, permissionless social network. Its static client is designed to run from IPFS, while posts and social interactions are reconstructed directly from EVM event logs.

The project is an unofficial parody inspired by the fictional social network in Grand Theft Auto V. It is not affiliated with or endorsed by Rockstar Games or Take-Two Interactive, and it does not use their artwork or game assets.

## Product principles

- No Lifeinvader application server or hosted database.
- No protocol owner, administrator, upgrade key, or deletion authority.
- Posts, comments, reposts, reactions, follows, public direct messages, and group messages are on-chain actions.
- "Direct messages" are intentionally public. The interface must never imply otherwise.
- Media is content-addressed; paid persistence will be handled through optional storage-market integrations without turning the core protocol into a treasury.
- RPC history is fetched in bounded ranges through the wallet or an explicitly selected in-memory endpoint whose confirmed block fingerprints remain wallet-checked, then cached only on the user's device.

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

The current app discovers injected wallets, verifies or permissionlessly deploys the predetermined protocol, publishes posts and comments with optional canonical IPFS CID commitments, and reconstructs a confirmed global feed from a verified deployment boundary through bounded RPC reads. Every implemented public-history view can use the wallet transport or a user-supplied HTTP endpoint after a one-click chain and confirmed-block match; the original checkpoint and later block fingerprints remain wallet-checked, the URL remains in tab memory, and all writes stay on the wallet. An optional user-selected gateway can retrieve individual media attachments only after an explicit click; the client bounds and signature-checks the response, verifies raw blocks directly, and reconstructs Lifeinvader-prepared UnixFS roots before rendering from a temporary blob URL. The post composer can deterministically prepare an IPFS-rooted CAR in the browser, verify the supported Filecoin storage-contract graph, read an account-bound one-copy USDFC estimate through a capped Synapse transport, and explicitly fund that account after a fresh unchanged quote and approval disclosure. Its provider-upload stage can then store that exact CAR with one explicit compatible provider, constrain the two typed authorizations, authenticate the provider-submitted receipt and CID metadata, and persist ambiguous or data-set-only recovery without claiming that indexing completed. The wallet console reopens those bounded browser-local checkpoints after reload, locks all writes while any remain, and checks the newest provider hash only from its original account and chain. Funding, storage, IPFS indexing, and publication retain independent recovery states rather than being presented as one atomic action. It writes explicit like, unlike, and repost events, and derives exact confirmed reaction totals plus visible comment histories through user-stepped RPC and local-cache work; reaction and comment cursors use the same verified protocol-history boundary as posts. Its wallet console also publishes verified complete profile snapshots and reconstructs the connected account's current confirmed profile from the same bounded protocol-history boundary through authenticated, resumable local projections. The client derives exact pairwise conversation identifiers, submits and receipt-verifies deliberately public direct messages, and reconstructs one selected conversation from that verified boundary through explicit bounded RPC steps; incomplete history stays hidden until the stream catches up. Its group browser discovers confirmed definitions from that verified boundary, reconstructs exact-group public membership, creates ownerless groups, publishes explicit join or leave events, sends receipt-verified public group messages, and reconstructs only the selected group's confirmed channel. Its follow browser applies exact incoming and outgoing filters to any selected account, starts fresh cursors at a bounded and verified protocol-history boundary when the RPC supports historical state, exposes address-paginated relationships only after complete authenticated local projection, and submits follow or unfollow events only through exact canonical receipts. Reads advance only through user-requested bounded RPC and authenticated local-projection steps, while writes remain locked until their exact canonical receipt or ambiguous wallet outcome is resolved. Feed behavior and its deliberate work budget are documented in [`docs/feed.md`](./docs/feed.md); follow indexing is documented in [`docs/follows.md`](./docs/follows.md), profile snapshots are documented in [`docs/profiles.md`](./docs/profiles.md), direct-message behavior is documented in [`docs/messages.md`](./docs/messages.md), public-group semantics are documented in [`docs/groups.md`](./docs/groups.md), comment behavior is documented in [`docs/comments.md`](./docs/comments.md), reaction semantics are documented in [`docs/reactions.md`](./docs/reactions.md), and the distinction between a CID and paid persistence is documented in [`docs/media.md`](./docs/media.md).

## Protocol address

On supported EVM chains, Lifeinvader v1 deterministically deploys to `0x779DEb5AD0B27BF40BDBFF3A81caB2d9049d7ad1`. Deployment is permissionless and grants the sender no role. The frozen CREATE2 inputs and local deployment workflow are documented in [`docs/deployment.md`](./docs/deployment.md).

The project is under active construction. Nothing has been deployed to an EVM network or IPFS.
