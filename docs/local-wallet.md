# Local wallet workflow

The static client can use an injected EIP-1193 wallet such as MetaMask without an application server. Wallets are discovered through EIP-6963, with `window.ethereum` retained only as a compatibility fallback.

## Start a clean local chain

Run Anvil on the loopback interface in one terminal:

```bash
pnpm --filter @lifeinvader/contracts node
```

Run the static Vite client in another:

```bash
pnpm --filter @lifeinvader/web dev
```

Open the loopback URL printed by Vite, connect MetaMask, and choose **Switch to local Anvil**. The client asks the wallet to select chain ID `31337` at `http://127.0.0.1:8545`; if that network is unknown, it asks to add it first. Because development chain IDs are commonly reused, the client also compares a fixed block fingerprint through the wallet and the loopback RPC before it labels the network as local or enables local deployment. If an existing `31337` entry points elsewhere, update or remove it in the wallet first.

Import one of the development-only accounts printed by Anvil into a dedicated browser profile. Anvil keys are public test credentials: never fund them or reuse them on another network.

On a fresh chain, the client verifies the canonical CREATE2 factory before enabling **Deploy protocol here**. It enables the composer only after code at the predetermined Lifeinvader address exactly matches the frozen v1 runtime hash. Deployment and publishing both request a normal wallet confirmation and wait for an on-chain receipt.

## Test against a local fork

Stop the clean Anvil process, then start a pinned fork while retaining the same local chain ID and loopback address:

```bash
anvil \
  --host 127.0.0.1 \
  --chain-id 31337 \
  --fork-url <read-rpc-url> \
  --fork-block-number <pinned-block>
```

The wallet continues to submit only to local Anvil. Transactions mutate the disposable fork, not the upstream chain. Use a user-selected RPC URL and a reproducible block number; do not place provider secrets in committed files or shell history.

## Safety checks

The client never infers compatibility from an address alone. Before a deployment it checks the factory code hash, and before every post it checks the protocol runtime hash again. A missing factory, altered factory, or address collision disables the relevant action.

Wallet transports are used for these small interactive checks and writes. Feed synchronization will use independently configurable read-only RPC transports, bounded log ranges, and browser-local checkpoints so normal browsing does not overload the wallet RPC.
