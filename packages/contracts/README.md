# Lifeinvader contracts

This workspace contains the ownerless Lifeinvader event protocol, deterministic deployment scripts, and Foundry tests.

The protocol contract will be introduced in a focused change after its event schema and identifiers are specified. The current smoke test proves that the pinned compiler and Foundry configuration run through the root Turborepo tasks.

## Commands

```bash
pnpm --filter @lifeinvader/contracts check
pnpm --filter @lifeinvader/contracts test
pnpm --filter @lifeinvader/contracts build
pnpm --filter @lifeinvader/contracts node
```

The local node listens on `127.0.0.1:8545` with chain ID `31337`. An explicit fork command will be added with the first integration that requires deployed chain state.
