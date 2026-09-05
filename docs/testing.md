# Browser wallet testing

Lifeinvader has an opt-in Playwright smoke test that exercises the real browser wallet boundary. It imports the public Anvil test mnemonic into a fresh temporary MetaMask profile, connects the static client, adds the local chain, permissionlessly deploys the canonical contract, publishes one post and comment, then likes and unlikes that comment. It advances local confirmation depth and the explicit bounded comment-history controls before reacting, and decodes the exact `PostPublished`, `CommentPublished`, and `LikeSet` logs from Anvil. The comment and post deliberately share numeric ID `1` so the test also checks that comment reactions use their distinct content kind. The test then reverts its EVM snapshot and removes the browser profile.

The smoke test is not part of `pnpm test`. It needs Chrome extension support and an official unpacked MetaMask release, while the default suite remains deterministic on headless development and CI machines. In Hive, run this validation from a `browser-testing` workspace rather than installing a browser in the software workspace.

## Prerequisites

- Install the workspace dependencies with `pnpm install`.
- Install Playwright's pinned Chromium build with `pnpm --filter @lifeinvader/web exec playwright install chromium` on a browser-capable machine.
- Download an official MetaMask Chrome 13.x release, verify its published provenance or checksum, and unpack it outside the repository.
- Start a fresh Anvil instance at `http://127.0.0.1:8545` with chain ID `31337`.
- Start the web client at `http://127.0.0.1:4173`.

For example, run the local services in separate terminals:

```bash
anvil --host 127.0.0.1 --port 8545 --chain-id 31337
pnpm --filter @lifeinvader/web dev -- --host 127.0.0.1 --port 4173
```

Then run the smoke test with the absolute extension path:

```bash
LIFEINVADER_METAMASK_EXTENSION_PATH=/absolute/path/to/metamask \
  pnpm --filter @lifeinvader/web test:metamask
```

`LIFEINVADER_APP_URL` can override the default client URL, but the test accepts only an unauthenticated HTTP loopback URL. The RPC remains fixed at the same `http://127.0.0.1:8545` endpoint that the client asks MetaMask to add. The test refuses to proceed unless that RPC identifies itself as Anvil, reports chain ID `31337`, exposes the known first Anvil account, has the canonical deterministic deployment factory, and has no code at the Lifeinvader protocol address.

The mnemonic and password used by this test are public disposable fixtures. Never fund that account, reuse its mnemonic, point the test at a live chain, or substitute a personal browser profile. The workflow does not deploy the app to IPFS and does not upload media.

## MetaMask on a pinned Ethereum fork

The same smoke test can exercise actual Ethereum state through a local Anvil fork. Start a **fresh, dedicated** node in place of the ordinary Anvil command above:

```bash
anvil --host 127.0.0.1 --port 8545 --chain-id 31337 \
  --fork-url https://eth.drpc.org \
  --fork-block-number 25893044
```

Then explicitly enable the pinned-fork preflight:

```bash
LIFEINVADER_METAMASK_FORK=ethereum \
LIFEINVADER_METAMASK_EXTENSION_PATH=/absolute/path/to/metamask \
  pnpm --filter @lifeinvader/web test:metamask
```

The local chain deliberately reports `31337`, not mainnet chain ID `1`. The preflight checks Anvil's identity, configured fork block, unchanged current head, exact block hash, and disposable account before the smoke test creates a snapshot or opens a wallet. The test then deploys and sends every transaction to the loopback fork only. It waits for MetaMask's cached block head to observe each explicitly mined confirmation range before reading history, and restores the original snapshot afterward.

## Filecoin storage on a pinned Calibration fork

The opt-in storage suite exercises the deployed storage-contract graph, an exact one-copy quote, provider-registry reads, and an ERC-2612 permit plus Filecoin Pay funding/approval transaction. It seeds USDFC through the token's configured mint authority **inside the local fork snapshot**, verifies the resulting balance, and restores the snapshot after the test. It does not contact a storage provider to upload bytes.

Use a separate fresh Anvil instance; this integration must retain Calibration chain ID `314159`:

```bash
anvil --host 127.0.0.1 --port 18546 --chain-id 314159 \
  --fork-url https://api.calibration.node.glif.io/rpc/v1 \
  --fork-block-number 4040324
```

```bash
LIFEINVADER_FILECOIN_FORK_RPC_URL=http://127.0.0.1:18546 \
  pnpm --filter @lifeinvader/web exec vitest run src/filecoin-storage.fork.test.ts
```

The suite accepts only an unauthenticated HTTP root URL at `127.0.0.1` or `[::1]`; hostnames, external addresses, credentials, paths, queries, and fragments are rejected before any request. Each request has a five-second timeout and refuses redirects. The same five-read Anvil preflight runs before the suite and again immediately before the mutating funding test. A mismatched chain, fork block/hash, missing fixture account, or already-advanced head stops the run before snapshots, impersonation, balance changes, or transactions.

The fixtures are frozen in `apps/web/src/test-local-fork.ts`:

| Workflow              | Upstream block | Expected block hash                                                  | Local chain ID |
| --------------------- | -------------: | -------------------------------------------------------------------- | -------------: |
| MetaMask / Ethereum   |       25893044 | `0x0cd7a0fd59c11855d61e45b1c9bdfb58342d23a29bf090b48736ed1550cd1d3f` |          31337 |
| Storage / Calibration |        4040324 | `0x4fbb4afdef3a029023584a476e49d5dc33591e11417efc460131f413609716db` |         314159 |

The public upstream endpoints receive read requests from Anvil, never wallet signatures or transactions. Another archival RPC may be substituted while keeping the exact pinned block and hash. Availability of these public endpoints is not guaranteed. Treat the local node and its configuration as trusted test infrastructure; the preflight is an accident guard, not authentication against a malicious localhost proxy. Never use a personal wallet profile or a shared node containing work you need to preserve.
