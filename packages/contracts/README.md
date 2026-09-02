# Lifeinvader contracts

This workspace contains the ownerless Lifeinvader event protocol and its Foundry tests. Deterministic deployment scripts will land in a focused milestone.

`src/Lifeinvader.sol` emits bounded, query-friendly events for publications, relationships, profiles, deliberately public direct messages, and public group chats. The contract has no privileged roles or payment receiver. See [`docs/protocol-v1.md`](../../docs/protocol-v1.md) for the derivation rules and topic layout.

## Commands

```bash
pnpm --filter @lifeinvader/contracts check
pnpm --filter @lifeinvader/contracts test
pnpm --filter @lifeinvader/contracts build
pnpm --filter @lifeinvader/contracts node
```

The local node listens on `127.0.0.1:8545` with chain ID `31337`. An explicit fork command will be added with the first integration that requires deployed chain state.
