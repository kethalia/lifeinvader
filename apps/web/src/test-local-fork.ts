// Test-only transport and fixtures. Never import this module from app code.
export type LocalTestRpc = (
  method: string,
  params?: readonly unknown[],
) => Promise<unknown>

export type LocalForkFixture = {
  account: string
  blockHash: string
  blockNumber: number
  chainId: number
}

export const CALIBRATION_FORK_FIXTURE = Object.freeze({
  account: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  blockHash:
    '0x4fbb4afdef3a029023584a476e49d5dc33591e11417efc460131f413609716db',
  blockNumber: 4_040_324,
  chainId: 314_159,
}) satisfies LocalForkFixture

export const ETHEREUM_WALLET_FORK_FIXTURE = Object.freeze({
  account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  blockHash:
    '0x0cd7a0fd59c11855d61e45b1c9bdfb58342d23a29bf090b48736ed1550cd1d3f',
  blockNumber: 25_893_044,
  // The browser's deliberately local wallet network, not Ethereum mainnet.
  chainId: 31_337,
}) satisfies LocalForkFixture

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function createLocalTestRpc(value: string): LocalTestRpc {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Test RPC must be an unauthenticated HTTP loopback root URL.',
    )
  }
  const endpoint = url.toString()
  let requestId = 0
  return async (method, params = []) => {
    const id = ++requestId
    const response = await fetch(endpoint, {
      body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      throw new Error(`Local test RPC returned HTTP ${response.status}.`)
    }
    const payload = record(await response.json())
    if (payload.jsonrpc !== '2.0' || payload.id !== id) {
      throw new Error('Local test RPC returned a mismatched response.')
    }
    if (Object.hasOwn(payload, 'error')) {
      const { message, code } = record(payload.error)
      const error = new Error(
        typeof message === 'string' ? message : 'Local test RPC failed.',
      )
      if (typeof code === 'number') Object.assign(error, { code })
      throw error
    }
    if (!Object.hasOwn(payload, 'result')) {
      throw new Error('Local test RPC returned no result.')
    }
    return payload.result
  }
}

export async function assertPinnedAnvilFork(
  rpc: LocalTestRpc,
  fixture: LocalForkFixture,
) {
  const client = await rpc('web3_clientVersion')
  if (typeof client !== 'string' || !/^anvil\//i.test(client)) {
    throw new Error('Fork tests require an isolated Anvil instance.')
  }
  const chainId = `0x${fixture.chainId.toString(16)}`
  if ((await rpc('eth_chainId')) !== chainId) {
    throw new Error('The local fork has the wrong chain ID.')
  }
  const info = record(await rpc('anvil_nodeInfo'))
  const fork = record(info.forkConfig)
  const environment = record(info.environment)
  const blockNumber = `0x${fixture.blockNumber.toString(16)}`
  if (
    fork.forkBlockNumber !== fixture.blockNumber ||
    environment.chainId !== fixture.chainId ||
    info.currentBlockNumber !== blockNumber ||
    info.currentBlockHash !== fixture.blockHash
  ) {
    throw new Error('Start a fresh Anvil fork at the documented pinned block.')
  }
  const block = record(await rpc('eth_getBlockByNumber', [blockNumber, false]))
  if (block.number !== blockNumber || block.hash !== fixture.blockHash) {
    throw new Error('The local fork does not match the pinned block hash.')
  }
  const accounts = await rpc('eth_accounts')
  if (
    !Array.isArray(accounts) ||
    !accounts.some(
      (account) =>
        typeof account === 'string' &&
        account.toLowerCase() === fixture.account.toLowerCase(),
    )
  ) {
    throw new Error('The disposable Anvil fixture account is unavailable.')
  }
}
