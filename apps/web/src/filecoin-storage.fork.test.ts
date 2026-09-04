// @vitest-environment node
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from 'viem'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_STORAGE_NETWORKS,
  inspectFilecoinStorage,
} from './filecoin-storage'
import { fundFilecoinStorage } from './filecoin-storage-funding'
import { quoteFilecoinStorage } from './filecoin-storage-quote'

const forkRpcUrl = process.env.LIFEINVADER_FILECOIN_FORK_RPC_URL
const describeFork = forkRpcUrl ? describe : describe.skip
const UNUSED_QUOTE_ACCOUNT = getAddress(
  '0x000000000000000000000000000000000000a11c',
)
const FUNDED_ANVIL_ACCOUNT = getAddress(
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
)
const CALIBRATION_USDFC = FILECOIN_STORAGE_NETWORKS[1].contracts.usdfc
const FIXTURE_USDFC_AMOUNT = 1_000_000_000_000_000_000n

const USDFC_FIXTURE_ABI = [
  {
    inputs: [],
    name: 'borrowerOperationsAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

type JsonRpcResponse = {
  error?: { code?: number; message?: string }
  result?: unknown
}

async function rpc(
  url: string,
  method: string,
  params: readonly unknown[] = [],
) {
  const response = await fetch(url, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Local fork RPC returned HTTP ${response.status}.`)
  }
  const payload = (await response.json()) as JsonRpcResponse
  if (payload.error) {
    throw new Error(payload.error.message ?? 'Local fork RPC request failed.')
  }
  return payload.result
}

async function readUsdfcBalance(url: string, account: Address) {
  const result = await rpc(url, 'eth_call', [
    {
      data: encodeFunctionData({
        abi: USDFC_FIXTURE_ABI,
        functionName: 'balanceOf',
        args: [account],
      }),
      to: CALIBRATION_USDFC,
    },
    'latest',
  ])
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) {
    throw new Error('Local fork RPC returned an invalid USDFC balance.')
  }
  return decodeFunctionResult({
    abi: USDFC_FIXTURE_ABI,
    data: result as Hex,
    functionName: 'balanceOf',
  })
}

async function seedUsdfc(url: string, account: Address, amount: bigint) {
  const borrowerResult = await rpc(url, 'eth_call', [
    {
      data: encodeFunctionData({
        abi: USDFC_FIXTURE_ABI,
        functionName: 'borrowerOperationsAddress',
      }),
      to: CALIBRATION_USDFC,
    },
    'latest',
  ])
  if (
    typeof borrowerResult !== 'string' ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(borrowerResult)
  ) {
    throw new Error('Local fork RPC returned invalid USDFC authority data.')
  }
  const borrowerOperations = getAddress(
    decodeFunctionResult({
      abi: USDFC_FIXTURE_ABI,
      data: borrowerResult as Hex,
      functionName: 'borrowerOperationsAddress',
    }),
  )
  const balanceBefore = await readUsdfcBalance(url, account)
  await rpc(url, 'anvil_impersonateAccount', [borrowerOperations])
  try {
    await rpc(url, 'anvil_setBalance', [
      borrowerOperations,
      '0x56bc75e2d63100000',
    ])
    const hash = await rpc(url, 'eth_sendTransaction', [
      {
        chainId: `0x${FILECOIN_CALIBRATION_CHAIN_ID.toString(16)}`,
        data: encodeFunctionData({
          abi: USDFC_FIXTURE_ABI,
          functionName: 'mint',
          args: [account, amount],
        }),
        from: borrowerOperations,
        to: CALIBRATION_USDFC,
      },
    ])
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) {
      throw new Error('Local fork RPC did not return the fixture mint hash.')
    }
    await rpc(url, 'evm_mine')
    const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash])
    if (
      typeof receipt !== 'object' ||
      receipt === null ||
      !('status' in receipt) ||
      receipt.status !== '0x1'
    ) {
      throw new Error('Local fork RPC did not confirm the fixture mint.')
    }
  } finally {
    await rpc(url, 'anvil_stopImpersonatingAccount', [borrowerOperations])
  }
  const balanceAfter = await readUsdfcBalance(url, account)
  if (balanceAfter !== balanceBefore + amount) {
    throw new Error('Local fork RPC did not seed the expected USDFC balance.')
  }
  return balanceAfter
}

function httpProvider(
  url: string,
  methods: string[] = [],
  selectedAccount?: Address,
): Eip1193Provider {
  let requestId = 0
  return {
    async request({ method, params }: ProviderRequest) {
      methods.push(method)
      if (method === 'eth_accounts' && selectedAccount) {
        return [selectedAccount]
      }
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
      if (!response.ok) {
        throw new Error(`Local fork RPC returned HTTP ${response.status}.`)
      }
      const payload = (await response.json()) as JsonRpcResponse
      if (payload.error) {
        const error = new Error(
          payload.error.message ?? 'Local fork RPC request failed.',
        )
        Object.assign(error, { code: payload.error.code })
        throw error
      }
      return payload.result
    },
  }
}

describeFork('Filecoin storage inspection on a pinned Anvil fork', () => {
  it('verifies the live Calibration deployment graph', async () => {
    if (!forkRpcUrl) return
    const provider = httpProvider(forkRpcUrl)

    await expect(inspectFilecoinStorage(provider)).resolves.toMatchObject({
      kind: 'ready',
      network: {
        chainId: FILECOIN_CALIBRATION_CHAIN_ID,
        id: 'filecoin-calibration',
      },
    })
  }, 20_000)

  it('quotes one current non-CDN copy without sending a transaction', async () => {
    if (!forkRpcUrl) return
    const methods: string[] = []
    const provider = httpProvider(forkRpcUrl, methods, UNUSED_QUOTE_ACCOUNT)

    const quote = await quoteFilecoinStorage(provider, 273, {
      expectedAccount: UNUSED_QUOTE_ACCOUNT,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
    })

    expect(quote).toEqual({
      account: UNUSED_QUOTE_ACCOUNT,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      copies: 1,
      dataSize: 273n,
      depositNeeded: 620_000_000_647_923_200n,
      fees: {
        addPiecesFee: 11_000_000_000_000_000n,
        createDataSetFee: 25_000_000_000_000_000n,
        total: 36_000_000_000_000_000n,
      },
      lockups: {
        cacheMissLockup: 0n,
        cdnLockup: 0n,
        lifecycleLockup: 500_000_000_000_000_000n,
        rateDeltaPerEpoch: 1_388_888_896_388n,
        reserveReplenishment: 0n,
        streamingLockup: 120_000_000_647_923_200n,
        total: 620_000_000_647_923_200n,
      },
      needsServiceApproval: true,
      rates: {
        perEpoch: 1_388_888_896_388n,
        perMonth: 120_000_000_648_014_975n,
      },
      ready: false,
      tokenDecimals: 18,
      tokenSymbol: 'USDFC',
      withCDN: false,
    })
    expect(methods.length).toBeLessThanOrEqual(16)
    expect(methods).not.toContain('eth_sendTransaction')
    expect(methods).not.toContain('eth_signTypedData_v4')
  }, 30_000)

  it('funds and approves one quote through an authenticated transaction', async () => {
    if (!forkRpcUrl) return
    const snapshot = await rpc(forkRpcUrl, 'evm_snapshot')
    if (typeof snapshot !== 'string' || !/^0x[0-9a-f]+$/i.test(snapshot)) {
      throw new Error('Local fork RPC returned an invalid snapshot identifier.')
    }
    const methods: string[] = []
    const provider = httpProvider(forkRpcUrl, methods, FUNDED_ANVIL_ACCOUNT)
    try {
      const walletBalance = await seedUsdfc(
        forkRpcUrl,
        FUNDED_ANVIL_ACCOUNT,
        FIXTURE_USDFC_AMOUNT,
      )
      const quote = await quoteFilecoinStorage(provider, 273, {
        expectedAccount: FUNDED_ANVIL_ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      })
      expect(quote.ready).toBe(false)
      expect(quote.depositNeeded > 0n || quote.needsServiceApproval).toBe(true)
      expect(walletBalance).toBeGreaterThanOrEqual(quote.depositNeeded)
      const submitted: string[] = []

      const receipt = await fundFilecoinStorage(provider, quote, {
        expectedAccount: FUNDED_ANVIL_ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
        onSubmitted: (hash) => submitted.push(hash),
        pollIntervalMs: 10,
        receiptTimeoutMs: 30_000,
      })
      expect(submitted).toEqual([receipt.hash])
      expect(
        methods.filter((method) => method === 'eth_sendTransaction'),
      ).toHaveLength(1)
      expect(
        methods.filter((method) => method === 'eth_signTypedData_v4'),
      ).toHaveLength(quote.depositNeeded > 0n ? 1 : 0)

      const refreshed = await quoteFilecoinStorage(provider, 273, {
        expectedAccount: FUNDED_ANVIL_ACCOUNT,
        expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      })
      expect(refreshed).toMatchObject({
        depositNeeded: 0n,
        needsServiceApproval: false,
        ready: true,
      })
    } finally {
      if ((await rpc(forkRpcUrl, 'evm_revert', [snapshot])) !== true) {
        throw new Error('Local fork RPC did not restore the funding snapshot.')
      }
    }
  }, 60_000)
})
