# Browser wallet testing

Lifeinvader has an opt-in Playwright smoke test that exercises the real browser wallet boundary. It imports the public Anvil test mnemonic into a fresh temporary MetaMask profile, connects the static client, adds the local chain, permissionlessly deploys the canonical contract, publishes one post, and decodes the exact `PostPublished` log from Anvil. The test then reverts its EVM snapshot and removes the browser profile.

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
