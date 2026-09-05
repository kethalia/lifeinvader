// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPinnedAnvilFork,
  CALIBRATION_FORK_FIXTURE,
  createLocalTestRpc,
  ETHEREUM_WALLET_FORK_FIXTURE,
  type LocalForkFixture,
} from './test-local-fork'

afterEach(() => vi.unstubAllGlobals())

function fixtureResponses(
  fixture: LocalForkFixture = CALIBRATION_FORK_FIXTURE,
) {
  const blockNumber = `0x${fixture.blockNumber.toString(16)}`
  return {
    anvil_nodeInfo: {
      currentBlockHash: fixture.blockHash,
      currentBlockNumber: blockNumber,
      environment: { chainId: fixture.chainId },
      forkConfig: { forkBlockNumber: fixture.blockNumber },
    },
    eth_accounts: [fixture.account.toUpperCase()],
    eth_chainId: `0x${fixture.chainId.toString(16)}`,
    eth_getBlockByNumber: { hash: fixture.blockHash, number: blockNumber },
    web3_clientVersion: 'anvil/v1.7.1',
  }
}

describe('local test RPC transport', () => {
  it.each([
    'https://api.calibration.node.glif.io/rpc/v1',
    'http://192.0.2.1:8545',
    'https://127.0.0.1:8545',
    'http://localhost:8545',
    'http://127.0.0.1.example:8545',
    'http://user:secret@127.0.0.1:8545',
    'http://127.0.0.1:8545/proxy',
    'http://127.0.0.1:8545/?upstream=live',
    'http://127.0.0.1:8545/#fragment',
    'not a URL',
  ])('rejects a non-local or ambiguous endpoint before fetch: %s', (url) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(() => createLocalTestRpc(url)).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['http://127.0.0.1:8545', 'http://[::1]:18546/'])(
    'uses bounded non-redirecting requests for %s',
    async (url) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ id: 1, jsonrpc: '2.0', result: '0x1' }),
        )
        .mockResolvedValueOnce(
          Response.json({ id: 2, jsonrpc: '2.0', result: null }),
        )
      vi.stubGlobal('fetch', fetcher)
      const rpc = createLocalTestRpc(url)
      await expect(rpc('eth_chainId')).resolves.toBe('0x1')
      await expect(
        rpc('eth_getBlockByNumber', ['0x1', false]),
      ).resolves.toBeNull()
      expect(fetcher).toHaveBeenNthCalledWith(1, new URL(url).toString(), {
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
        }),
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
      expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
        id: 2,
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: ['0x1', false],
      })
    },
  )

  it.each([
    [],
    null,
    { id: 2, jsonrpc: '2.0', result: '0x1' },
    { id: 1, jsonrpc: '1.0', result: '0x1' },
    { id: 1, jsonrpc: '2.0' },
    { id: 1, jsonrpc: '2.0', error: null },
    { id: 1, jsonrpc: '2.0', result: '0x1', error: {} },
  ])(
    'rejects malformed or conflicting JSON-RPC replies: %j',
    async (payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)))
      await expect(
        createLocalTestRpc('http://127.0.0.1:8545')('eth_chainId'),
      ).rejects.toThrow()
    },
  )

  it('preserves RPC errors and rejects HTTP failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: 1,
          jsonrpc: '2.0',
          error: { code: -32000, message: 'execution reverted' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const rpc = createLocalTestRpc('http://127.0.0.1:8545')
    await expect(rpc('eth_call')).rejects.toMatchObject({
      code: -32000,
      message: 'execution reverted',
    })
    await expect(rpc('eth_chainId')).rejects.toThrow('HTTP 503')
  })
})

describe('pinned Anvil fork preflight', () => {
  it.each([CALIBRATION_FORK_FIXTURE, ETHEREUM_WALLET_FORK_FIXTURE])(
    'authenticates chain $chainId and block $blockNumber using only five reads',
    async (fixture) => {
      const responses = fixtureResponses(fixture)
      const rpc = vi.fn(
        async (method: string) => responses[method as keyof typeof responses],
      )
      await expect(assertPinnedAnvilFork(rpc, fixture)).resolves.toBeUndefined()
      expect(rpc.mock.calls).toEqual([
        ['web3_clientVersion'],
        ['eth_chainId'],
        ['anvil_nodeInfo'],
        [
          'eth_getBlockByNumber',
          [`0x${fixture.blockNumber.toString(16)}`, false],
        ],
        ['eth_accounts'],
      ])
    },
  )

  it.each([
    ['web3_clientVersion', 'geth/v1.0'],
    ['web3_clientVersion', null],
    ['eth_chainId', '0x1'],
    ['anvil_nodeInfo', {}],
    [
      'anvil_nodeInfo',
      { ...fixtureResponses().anvil_nodeInfo, currentBlockNumber: '0x3da685' },
    ],
    [
      'anvil_nodeInfo',
      {
        ...fixtureResponses().anvil_nodeInfo,
        currentBlockHash: `0x${'00'.repeat(32)}`,
      },
    ],
    [
      'anvil_nodeInfo',
      { ...fixtureResponses().anvil_nodeInfo, environment: { chainId: 1 } },
    ],
    [
      'anvil_nodeInfo',
      {
        ...fixtureResponses().anvil_nodeInfo,
        forkConfig: { forkBlockNumber: 4_040_323 },
      },
    ],
    [
      'anvil_nodeInfo',
      {
        ...fixtureResponses().anvil_nodeInfo,
        forkConfig: { forkBlockNumber: '4040324' },
      },
    ],
    ['eth_getBlockByNumber', null],
    [
      'eth_getBlockByNumber',
      { ...fixtureResponses().eth_getBlockByNumber, number: '0x3da685' },
    ],
    [
      'eth_getBlockByNumber',
      {
        ...fixtureResponses().eth_getBlockByNumber,
        hash: `0x${'00'.repeat(32)}`,
      },
    ],
    ['eth_accounts', []],
    ['eth_accounts', null],
    ['eth_accounts', ['0x0000000000000000000000000000000000000001']],
  ])(
    'rejects the first substituted %s response without later calls',
    async (method, value) => {
      const responses: Record<string, unknown> = {
        ...fixtureResponses(),
        [method as string]: value,
      }
      const rpc = vi.fn(async (requested: string) => responses[requested])
      await expect(
        assertPinnedAnvilFork(rpc, CALIBRATION_FORK_FIXTURE),
      ).rejects.toThrow()
      expect(rpc.mock.lastCall?.[0]).toBe(method)
      expect(rpc.mock.calls.length).toBeLessThanOrEqual(5)
    },
  )
})
