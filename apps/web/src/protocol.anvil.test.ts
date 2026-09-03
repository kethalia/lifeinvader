// @vitest-environment node
/// <reference types="node" />

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'

import {
  parseAccounts,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import {
  deployProtocol,
  inspectProtocol,
  PROTOCOL_ADDRESS,
  publishPost,
} from './protocol'

type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}

let anvil: ChildProcess | undefined
let provider: Eip1193Provider
let stderr = ''

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local TCP port.'))
        return
      }

      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function makeHttpProvider(url: string): Eip1193Provider {
  let requestId = 0

  return {
    async request({ method, params }: ProviderRequest) {
      const response = await fetch(url, {
        body: JSON.stringify({
          id: ++requestId,
          jsonrpc: '2.0',
          method,
          params: params ?? [],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok)
        throw new Error(`Local RPC returned HTTP ${response.status}.`)

      const payload = (await response.json()) as JsonRpcResponse
      if (payload.error) {
        const error = new Error(
          payload.error.message ?? 'Local RPC request failed.',
        )
        Object.assign(error, { code: payload.error.code })
        throw error
      }
      return payload.result
    },
  }
}

async function waitForAnvil() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (anvil?.exitCode !== null) {
      throw new Error(`Anvil exited during startup. ${stderr}`)
    }

    try {
      if ((await provider.request({ method: 'eth_chainId' })) === '0x7a69')
        return
    } catch {
      // Anvil has not bound its loopback socket yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Anvil did not become ready. ${stderr}`)
}

beforeAll(async () => {
  const port = await reservePort()
  provider = makeHttpProvider(`http://127.0.0.1:${port}`)
  anvil = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  anvil.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2_000)
  })
  await waitForAnvil()
}, 10_000)

afterAll(async () => {
  if (!anvil || anvil.exitCode !== null) return

  await new Promise<void>((resolve) => {
    anvil?.once('exit', () => resolve())
    anvil?.kill('SIGTERM')
    setTimeout(resolve, 2_000)
  })
})

describe('wallet transaction helpers on Anvil', () => {
  it('deploys v1 through the canonical factory and publishes an event', async () => {
    const accounts = parseAccounts(
      await provider.request({ method: 'eth_accounts' }),
    )
    const account = accounts[0]
    expect(account).toBeDefined()
    if (!account) return

    await expect(inspectProtocol(provider)).resolves.toEqual({
      kind: 'deployable',
    })
    await expect(deployProtocol(provider, account)).resolves.toMatchObject({
      blockNumber: 1n,
    })
    await expect(inspectProtocol(provider)).resolves.toEqual({ kind: 'ready' })

    await expect(
      publishPost(provider, account, 'Local chain, globally embarrassing.'),
    ).resolves.toMatchObject({ blockNumber: 2n })

    const logs = await provider.request({
      method: 'eth_getLogs',
      params: [
        {
          address: PROTOCOL_ADDRESS,
          fromBlock: '0x0',
          toBlock: 'latest',
        },
      ],
    })
    expect(Array.isArray(logs)).toBe(true)
    const firstLog = Array.isArray(logs) ? logs[0] : undefined
    expect(firstLog).toMatchObject({
      address: PROTOCOL_ADDRESS.toLowerCase(),
      topics: [
        keccak256(toHex('PostPublished(uint256,address,string,bytes)')),
        expect.any(String),
        expect.any(String),
      ],
    })
  })
})
