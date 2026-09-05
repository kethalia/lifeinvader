# Deterministic deployment

Lifeinvader v1 is designed to occupy the same address on every supported EVM chain:

```text
0x779DEb5AD0B27BF40BDBFF3A81caB2d9049d7ad1
```

Deployment is permissionless. The sender only pays that chain's transaction fee and receives no role in the resulting contract.

## Address derivation

Lifeinvader uses the deterministic factory specified by [EIP-7997](https://eips.ethereum.org/EIPS/eip-7997):

| Component                 | Frozen value                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| Factory                   | `0x4e59b44847b379578588920cA78FbF26c0B4956C`                         |
| Factory runtime code hash | `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989` |
| Salt label                | UTF-8 `lifeinvader.protocol.v1`                                      |
| Salt                      | `0x12f1d647ac2191038e16cc3e772d7674c8f6eb825ce09650b96d6dba48179059` |
| Init-code hash            | `0xa9bdddbbb0824a6b64f118b0eeb6b2c6051394933c5593ace3ee9495f4cc805e` |
| Runtime-code hash         | `0x9289a8f9250caef94eb4c263b182f4540e50b62b713f83ab722237cfcbdb87c4` |

The address follows [EIP-1014](https://eips.ethereum.org/EIPS/eip-1014): the last 20 bytes of `keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))`.

The compiler version, EVM target, optimizer settings, metadata settings, source, and salt are therefore consensus-critical release inputs. Tests fail if the compiled creation or runtime bytecode drifts from these published hashes. A future protocol revision must use a new salt label and address rather than silently replacing v1.

## Supported-chain check

A chain is supported for first deployment only when the factory address contains the exact EIP-7997 runtime code. The deployment helper checks its code hash before sending creation calldata.

If the Lifeinvader address already contains the exact v1 runtime code, deployment is an idempotent success even if the factory is no longer available. Any other code at either expected address is a hard failure; the script never assumes that a matching address implies matching behavior.

## Foundry deployment

Start a local chain in one terminal:

```bash
pnpm --filter @lifeinvader/contracts node
```

Anvil includes the EIP-7997 factory. Its first account is unlocked, so another terminal can deploy without placing a development key in shell history:

```bash
pnpm --filter @lifeinvader/contracts deploy:protocol \
  --rpc-url http://127.0.0.1:8545 \
  --unlocked \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

For a live supported chain, replace the RPC URL and use a Foundry-supported hardware wallet or encrypted keystore option. The script checks all frozen hashes before broadcasting and can safely be run again after deployment.

The web client offers the same raw factory call through the connected wallet and performs the same factory and protocol code-hash checks before enabling that transaction.

## Pinned fork validation

Use a user-selected read RPC to reproduce a supported chain locally without sending it transactions:

```bash
anvil \
  --host 127.0.0.1 \
  --fork-url <read-rpc-url> \
  --fork-block-number <pinned-block>
```

Transactions sent to `127.0.0.1:8545` mutate only the local fork. Before testing deployment, confirm that the forked factory code hash matches the frozen value above and that the Lifeinvader address is empty or already has the expected runtime code. Pinning the block makes failures reproducible and prevents a test from silently switching historical state between runs.

For repeatable browser and storage validation, use the exact fork blocks, chain IDs, guards, and commands in [`testing.md`](./testing.md). The MetaMask fork uses local chain ID `31337`; the separate Filecoin storage fork retains `314159` for its chain-bound deployed contracts and typed signatures.
