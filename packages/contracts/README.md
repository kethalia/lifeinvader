# Lifeinvader contracts

This workspace contains the ownerless Lifeinvader event protocol, deterministic deployment helper, and Foundry tests.

`src/Lifeinvader.sol` emits bounded, query-friendly events for publications, relationships, profiles, deliberately public direct messages, and public group chats. The contract has no privileged roles or payment receiver. See [`docs/protocol-v1.md`](../../docs/protocol-v1.md) for the derivation rules and topic layout.

Lifeinvader v1 deterministically deploys to `0x779DEb5AD0B27BF40BDBFF3A81caB2d9049d7ad1` through the EIP-7997 factory. See [`docs/deployment.md`](../../docs/deployment.md) for the frozen hashes, supported-chain checks, and local command.

## Commands

```bash
pnpm --filter @lifeinvader/contracts check
pnpm --filter @lifeinvader/contracts test
pnpm --filter @lifeinvader/contracts build
pnpm --filter @lifeinvader/contracts node
pnpm --filter @lifeinvader/contracts deploy:protocol <signer and RPC options>
```

The local node listens on `127.0.0.1:8545` with chain ID `31337`. The deployment guide also includes a pinned-fork workflow for integrations that depend on deployed chain state.
