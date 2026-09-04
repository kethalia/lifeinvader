import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  maxUint256,
  multicall3Abi,
  type Hash,
  type Hex,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  assertFilecoinStorageFundingReceipt,
  checkFilecoinStorageFundingReceipt,
  fundFilecoinStorage,
  MAX_FILECOIN_STORAGE_FUNDING_RPC_REQUESTS,
  planFilecoinStorageFunding,
  type FilecoinStorageFundingExecutor,
  type FilecoinStorageFundingPlan,
} from './filecoin-storage-funding'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_STORAGE_NETWORKS,
} from './filecoin-storage'
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import { isTransactionSubmissionUnknownError } from './protocol'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb'
const TRANSACTION_HASH = `0x${'12'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'34'.repeat(32)}` as Hash
const CALIBRATION = FILECOIN_STORAGE_NETWORKS[1]
const LOCKUP_PERIOD = 86_400n
const SIGNATURE_R = `0x${'56'.repeat(32)}` as Hex
const SIGNATURE_S = `0x${'78'.repeat(32)}` as Hex
const PERMIT_SIGNATURE = `${SIGNATURE_R}${SIGNATURE_S.slice(2)}1b` as Hex

const FUNDING_ABI = [
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'depositWithPermit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      { name: 'operator', type: 'address' },
      { name: 'rateAllowance', type: 'uint256' },
      { name: 'lockupAllowance', type: 'uint256' },
      { name: 'maxLockupPeriod', type: 'uint256' },
    ],
    name: 'depositWithPermitAndApproveOperator',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
      { name: 'rateAllowance', type: 'uint256' },
      { name: 'lockupAllowance', type: 'uint256' },
      { name: 'maxLockupPeriod', type: 'uint256' },
    ],
    name: 'setOperatorApproval',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'amount', type: 'uint256' },
    ],
    name: 'DepositRecorded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'client', type: 'address' },
      { indexed: true, name: 'operator', type: 'address' },
      { indexed: false, name: 'approved', type: 'bool' },
      { indexed: false, name: 'rateAllowance', type: 'uint256' },
      { indexed: false, name: 'lockupAllowance', type: 'uint256' },
      { indexed: false, name: 'maxLockupPeriod', type: 'uint256' },
    ],
    name: 'OperatorApprovalUpdated',
    type: 'event',
  },
] as const

function storageQuote({
  depositAmount = 13_000_000_000_000_000n,
  needsApproval = true,
}: {
  depositAmount?: bigint
  needsApproval?: boolean
} = {}): FilecoinStorageQuote {
  return {
    account: ACCOUNT,
    chainId: FILECOIN_CALIBRATION_CHAIN_ID,
    copies: 1,
    dataSize: 273n,
    depositNeeded: depositAmount,
    fees: {
      addPiecesFee: 2_000_000_000_000_000n,
      createDataSetFee: 3_000_000_000_000_000n,
      total: 5_000_000_000_000_000n,
    },
    lockups: {
      cacheMissLockup: 0n,
      cdnLockup: 0n,
      lifecycleLockup: 8_000_000_000_000_000n,
      rateDeltaPerEpoch: 120_000n,
      reserveReplenishment: 0n,
      streamingLockup: 120_000n * LOCKUP_PERIOD,
      total: 8_000_000_000_000_000n + 120_000n * LOCKUP_PERIOD,
    },
    needsServiceApproval: needsApproval,
    rates: {
      perEpoch: 120_000n,
      perMonth: 345_600_000_000n,
    },
    ready: depositAmount === 0n && !needsApproval,
    tokenDecimals: 18,
    tokenSymbol: 'USDFC',
    withCDN: false,
  }
}

function permit(plan: FilecoinStorageFundingPlan, deadline: bigint) {
  return JSON.stringify({
    domain: {
      chainId: Number(plan.chainId),
      name: 'USD for Filecoin Community',
      verifyingContract: plan.network.contracts.usdfc,
      version: '1',
    },
    message: {
      deadline: deadline.toString(),
      nonce: '0',
      owner: plan.account,
      spender: plan.network.contracts.filecoinPay,
      value: plan.depositAmount.toString(),
    },
    primaryType: 'Permit',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
  })
}

function fundingData(
  plan: FilecoinStorageFundingPlan,
  deadline?: bigint,
  signatureS: Hex = SIGNATURE_S,
) {
  if (plan.kind === 'approve') {
    return encodeFunctionData({
      abi: FUNDING_ABI,
      functionName: 'setOperatorApproval',
      args: [
        plan.network.contracts.usdfc,
        plan.network.contracts.fwss,
        true,
        maxUint256,
        maxUint256,
        plan.maxLockupPeriod,
      ],
    })
  }
  if (deadline === undefined) throw new Error('Permit deadline is required.')
  if (plan.kind === 'deposit') {
    return encodeFunctionData({
      abi: FUNDING_ABI,
      functionName: 'depositWithPermit',
      args: [
        plan.network.contracts.usdfc,
        plan.account,
        plan.depositAmount,
        deadline,
        27,
        SIGNATURE_R,
        signatureS,
      ],
    })
  }
  return encodeFunctionData({
    abi: FUNDING_ABI,
    functionName: 'depositWithPermitAndApproveOperator',
    args: [
      plan.network.contracts.usdfc,
      plan.account,
      plan.depositAmount,
      deadline,
      27,
      SIGNATURE_R,
      signatureS,
      plan.network.contracts.fwss,
      maxUint256,
      maxUint256,
      plan.maxLockupPeriod,
    ],
  })
}

function fundingLogs(plan: FilecoinStorageFundingPlan) {
  const base = {
    address: plan.network.contracts.filecoinPay,
    blockHash: BLOCK_HASH,
    blockNumber: '0x2a',
    transactionHash: TRANSACTION_HASH,
  }
  const logs: Record<string, unknown>[] = []
  if (plan.depositAmount > 0n) {
    logs.push({
      ...base,
      data: encodeAbiParameters([{ type: 'uint256' }], [plan.depositAmount]),
      topics: encodeEventTopics({
        abi: EVENT_ABI,
        eventName: 'DepositRecorded',
        args: {
          from: plan.account,
          to: plan.account,
          token: plan.network.contracts.usdfc,
        },
      }),
    })
  }
  if (plan.includesApproval) {
    logs.push({
      ...base,
      data: encodeAbiParameters(
        [
          { type: 'bool' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        [true, maxUint256, maxUint256, plan.maxLockupPeriod],
      ),
      topics: encodeEventTopics({
        abi: EVENT_ABI,
        eventName: 'OperatorApprovalUpdated',
        args: {
          client: plan.account,
          operator: plan.network.contracts.fwss,
          token: plan.network.contracts.usdfc,
        },
      }),
    })
  }
  return logs
}

function walletProvider({
  logs,
  sendError,
}: {
  logs: readonly unknown[]
  sendError?: Error
}) {
  const requests: ProviderRequest[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const provider: Eip1193Provider = {
    request: vi.fn(async (request) => {
      requests.push(request)
      if (request.method === 'eth_chainId') return '0x4cb2f'
      if (request.method === 'eth_accounts') return [ACCOUNT]
      if (request.method === 'eth_call') return '0x'
      if (request.method === 'eth_signTypedData_v4') {
        return PERMIT_SIGNATURE
      }
      if (request.method === 'eth_sendTransaction') {
        if (sendError) throw sendError
        return TRANSACTION_HASH
      }
      if (request.method === 'eth_getTransactionReceipt') {
        return {
          blockHash: BLOCK_HASH,
          blockNumber: '0x2a',
          logs,
          status: '0x1',
          transactionHash: TRANSACTION_HASH,
        }
      }
      if (request.method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      throw new Error(`Unexpected method: ${request.method}`)
    }),
    on: vi.fn((event, listener) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    removeListener: vi.fn((event, listener) => {
      listeners.get(event)?.delete(listener)
    }),
  }
  return { listeners, provider, requests }
}

function executorFor(plan: FilecoinStorageFundingPlan) {
  return vi.fn<FilecoinStorageFundingExecutor>(async ({ request }) => {
    await request({
      method: 'eth_call',
      params: [
        {
          data: encodeFunctionData({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            args: [
              [
                {
                  allowFailure: true,
                  callData: '0x1234',
                  target: plan.network.contracts.fwss,
                },
              ],
            ],
          }),
          to: plan.network.contracts.multicall3,
        },
        'latest',
      ],
    })
    const deadline = BigInt(Math.floor(Date.now() / 1_000)) + 3_600n
    if (plan.depositAmount > 0n) {
      await request({
        method: 'eth_signTypedData_v4',
        params: [plan.account, permit(plan, deadline)],
      })
    }
    const data = fundingData(plan, deadline)
    await request({
      method: 'eth_call',
      params: [
        {
          data,
          from: plan.account,
          to: plan.network.contracts.filecoinPay,
        },
        'latest',
      ],
    })
    return await request({
      method: 'eth_sendTransaction',
      params: [
        {
          chainId: '0x4cb2f',
          data,
          from: plan.account,
          to: plan.network.contracts.filecoinPay,
        },
      ],
    })
  })
}

function fundingOptions(
  plan: FilecoinStorageFundingPlan,
  executeFunding: FilecoinStorageFundingExecutor,
) {
  return {
    executeFunding,
    expectedAccount: plan.account,
    expectedChainId: plan.chainId,
    inspectStorage: vi.fn(async () => ({
      kind: 'ready' as const,
      network: CALIBRATION,
    })),
    pollIntervalMs: 1,
    receiptTimeoutMs: 1_000,
  }
}

describe('Filecoin storage funding plans', () => {
  it.each([
    [13n, true, 'deposit-and-approve'],
    [13n, false, 'deposit'],
    [0n, true, 'approve'],
  ] as const)(
    'plans deposit %s / approval %s as %s',
    (amount, approval, kind) => {
      const plan = planFilecoinStorageFunding(
        storageQuote({ depositAmount: amount, needsApproval: approval }),
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      )
      expect(plan).toMatchObject({
        account: ACCOUNT,
        chainId: FILECOIN_CALIBRATION_CHAIN_ID,
        depositAmount: amount,
        includesApproval: approval,
        kind,
        maxLockupPeriod: LOCKUP_PERIOD,
        network: CALIBRATION,
      })
      expect(Object.isFrozen(plan)).toBe(true)
      expect(Object.isFrozen(plan.network)).toBe(true)
      expect(Object.isFrozen(plan.network.contracts)).toBe(true)
    },
  )

  it('rechecks a retained hash against the original quote and exact events', async () => {
    const quote = storageQuote()
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })

    await expect(
      checkFilecoinStorageFundingReceipt(
        wallet.provider,
        TRANSACTION_HASH,
        quote,
        {
          expectedAccount: plan.account,
          expectedChainId: plan.chainId,
          pollIntervalMs: 1,
          receiptTimeoutMs: 1_000,
        },
      ),
    ).resolves.toMatchObject({ hash: TRANSACTION_HASH })
    expect(
      [...wallet.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true)
  })

  it('rejects invalid recovery timing and transaction hashes before wallet reads', async () => {
    const quote = storageQuote()
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    const options = {
      expectedAccount: plan.account,
      expectedChainId: plan.chainId,
      pollIntervalMs: 1,
      receiptTimeoutMs: 1_000,
    }

    await expect(
      checkFilecoinStorageFundingReceipt(
        wallet.provider,
        '0x1234' as Hash,
        quote,
        options,
      ),
    ).rejects.toThrow(/transaction hash is invalid/i)
    await expect(
      checkFilecoinStorageFundingReceipt(
        wallet.provider,
        TRANSACTION_HASH,
        quote,
        { ...options, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/polling interval is invalid/i)
    expect(wallet.requests).toHaveLength(0)
  })

  it('rejects ready, stale, malformed, or unsupported quotes before RPC', () => {
    expect(() =>
      planFilecoinStorageFunding(
        storageQuote({ depositAmount: 0n, needsApproval: false }),
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).toThrow(/already ready/i)
    expect(() =>
      planFilecoinStorageFunding(
        storageQuote(),
        OTHER_ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).toThrow(/different wallet context/i)
    expect(() =>
      planFilecoinStorageFunding(
        {
          ...storageQuote(),
          lockups: { ...storageQuote().lockups, streamingLockup: 1n },
        },
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).toThrow(/invalid lockup period|internally inconsistent/i)
    expect(() =>
      planFilecoinStorageFunding(storageQuote(), ACCOUNT, 31_337n),
    ).toThrow(/unsupported/i)
  })
})

describe('Filecoin storage funding transport', () => {
  it.each([
    [13n, true],
    [13n, false],
    [0n, true],
  ] as const)(
    'submits and authenticates deposit %s / approval %s',
    async (amount, approval) => {
      const quote = storageQuote({
        depositAmount: amount,
        needsApproval: approval,
      })
      const plan = planFilecoinStorageFunding(
        quote,
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      )
      const wallet = walletProvider({ logs: fundingLogs(plan) })
      const executor = executorFor(plan)
      const onSubmitted = vi.fn()

      await expect(
        fundFilecoinStorage(wallet.provider, quote, {
          ...fundingOptions(plan, executor),
          onSubmitted,
        }),
      ).resolves.toEqual({
        blockHash: BLOCK_HASH,
        blockNumber: 42n,
        hash: TRANSACTION_HASH,
      })
      expect(onSubmitted).toHaveBeenCalledWith(TRANSACTION_HASH)
      expect(
        wallet.requests.filter(
          ({ method }) => method === 'eth_sendTransaction',
        ),
      ).toHaveLength(1)
      expect(
        wallet.requests.filter(
          ({ method }) => method === 'eth_signTypedData_v4',
        ),
      ).toHaveLength(amount > 0n ? 1 : 0)
      expect(
        [...wallet.listeners.values()].every(
          (listeners) => listeners.size === 0,
        ),
      ).toBe(true)
    },
  )

  it('rejects forbidden methods and an unsimulated transaction', async () => {
    const quote = storageQuote({ depositAmount: 0n, needsApproval: true })
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          return await request({ method: 'personal_sign', params: [] })
        }),
      }),
    ).rejects.toThrow(/forbidden RPC method personal_sign/i)

    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          return await request({
            method: 'eth_sendTransaction',
            params: [
              {
                data: fundingData(plan),
                from: plan.account,
                to: plan.network.contracts.filecoinPay,
              },
            ],
          })
        }),
      }),
    ).rejects.toThrow(/did not simulate/i)
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_sendTransaction'),
    ).toHaveLength(0)
  })

  it('rejects a stale simulation block before forwarding the read', async () => {
    const quote = storageQuote({ depositAmount: 0n, needsApproval: true })
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })

    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          await request({
            method: 'eth_call',
            params: [
              {
                data: fundingData(plan),
                to: plan.network.contracts.filecoinPay,
              },
              '0x1',
            ],
          })
          return TRANSACTION_HASH
        }),
      }),
    ).rejects.toThrow(/stale read block/i)
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_call'),
    ).toHaveLength(0)
  })

  it('rejects Multicall3 batches that escape or recurse outside pinned reads', async () => {
    const quote = storageQuote({ depositAmount: 0n, needsApproval: true })
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    const readBatch = (target: `0x${string}`) =>
      encodeFunctionData({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        args: [[{ allowFailure: true, callData: '0x1234', target }]],
      })
    const executeBatch = (target: `0x${string}`) =>
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          await request({
            method: 'eth_call',
            params: [
              {
                data: readBatch(target),
                to: plan.network.contracts.multicall3,
              },
              'latest',
            ],
          })
          return TRANSACTION_HASH
        }),
      })

    await expect(executeBatch(OTHER_ACCOUNT)).rejects.toThrow(
      /unexpected contract/i,
    )
    await expect(
      executeBatch(plan.network.contracts.multicall3),
    ).rejects.toThrow(/nested a Multicall3 read/i)
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_call'),
    ).toHaveLength(0)
  })

  it('rejects changed permit and transaction terms before opening the wallet', async () => {
    const quote = storageQuote()
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    const deadline = BigInt(Math.floor(Date.now() / 1_000)) + 3_600n
    const changed = JSON.parse(permit(plan, deadline)) as {
      message: { value: string }
    }
    changed.message.value = (plan.depositAmount + 1n).toString()

    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          return await request({
            method: 'eth_signTypedData_v4',
            params: [plan.account, JSON.stringify(changed)],
          })
        }),
      }),
    ).rejects.toThrow(/changed the permit terms/i)
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_signTypedData_v4'),
    ).toHaveLength(0)

    const executor = executorFor(plan)
    const mutatingExecutor: FilecoinStorageFundingExecutor = async (input) => {
      const originalRequest = input.request
      return await executor({
        ...input,
        request: (request) => {
          if (request.method !== 'eth_sendTransaction') {
            return originalRequest(request)
          }
          const [transaction] = request.params as readonly Record<
            string,
            unknown
          >[]
          return originalRequest({
            ...request,
            params: [{ ...transaction, value: '0x1' }],
          })
        },
      })
    }
    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, mutatingExecutor),
      }),
    ).rejects.toThrow(/native FIL/i)
  })

  it('rejects calldata that substitutes a different permit signature', async () => {
    const quote = storageQuote()
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    const deadline = BigInt(Math.floor(Date.now() / 1_000)) + 3_600n
    const substitutedS = `0x${'99'.repeat(32)}` as Hex

    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          await request({
            method: 'eth_signTypedData_v4',
            params: [plan.account, permit(plan, deadline)],
          })
          const data = fundingData(plan, deadline, substitutedS)
          await request({
            method: 'eth_call',
            params: [
              {
                data,
                from: plan.account,
                to: plan.network.contracts.filecoinPay,
              },
              'latest',
            ],
          })
          return TRANSACTION_HASH
        }),
      }),
    ).rejects.toThrow(/changed its permit signature/i)
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_call'),
    ).toHaveLength(0)
  })

  it('snapshots permit parameters before asynchronous wallet checks', async () => {
    const quote = storageQuote()
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    const deadline = BigInt(Math.floor(Date.now() / 1_000)) + 3_600n
    const typedData = permit(plan, deadline)

    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          const candidate: ProviderRequest = {
            method: 'eth_signTypedData_v4',
            params: [plan.account, typedData],
          }
          const signature = request(candidate)
          candidate.method = 'personal_sign'
          candidate.params = [OTHER_ACCOUNT, 'mutated after validation']
          await signature

          const data = fundingData(plan, deadline)
          await request({
            method: 'eth_call',
            params: [
              {
                data,
                from: plan.account,
                to: plan.network.contracts.filecoinPay,
              },
              'latest',
            ],
          })
          return await request({
            method: 'eth_sendTransaction',
            params: [
              {
                data,
                from: plan.account,
                to: plan.network.contracts.filecoinPay,
              },
            ],
          })
        }),
      }),
    ).resolves.toMatchObject({ hash: TRANSACTION_HASH })
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_signTypedData_v4'),
    ).toEqual([
      {
        method: 'eth_signTypedData_v4',
        params: [plan.account, typedData],
      },
    ])
    expect(
      wallet.requests.some(({ method }) => method === 'personal_sign'),
    ).toBe(false)
  })

  it('snapshots validated transaction fields and injects the exact chain', async () => {
    const quote = storageQuote({ depositAmount: 0n, needsApproval: true })
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    const data = fundingData(plan)

    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          await request({
            method: 'eth_call',
            params: [
              {
                data,
                from: plan.account,
                to: plan.network.contracts.filecoinPay,
              },
              'latest',
            ],
          })
          const candidate: ProviderRequest = {
            method: 'eth_sendTransaction',
            params: [
              {
                data,
                from: plan.account,
                to: plan.network.contracts.filecoinPay,
              },
            ],
          }
          const submitted = request(candidate)
          candidate.params = [
            {
              data: '0x',
              from: OTHER_ACCOUNT,
              to: OTHER_ACCOUNT,
              value: '0x1',
            },
          ]
          return await submitted
        }),
      }),
    ).resolves.toMatchObject({ hash: TRANSACTION_HASH })
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_sendTransaction'),
    ).toEqual([
      {
        method: 'eth_sendTransaction',
        params: [
          {
            chainId: '0x4cb2f',
            data,
            from: plan.account,
            to: plan.network.contracts.filecoinPay,
          },
        ],
      },
    ])
  })

  it('caps dependency reads and never forwards the over-budget call', async () => {
    const quote = storageQuote({ depositAmount: 0n, needsApproval: true })
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: fundingLogs(plan) })
    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, async ({ request }) => {
          for (
            let index = 0;
            index <= MAX_FILECOIN_STORAGE_FUNDING_RPC_REQUESTS;
            index += 1
          ) {
            await request({
              method: 'eth_call',
              params: [
                { data: '0x1234', to: plan.network.contracts.fwss },
                'latest',
              ],
            })
          }
          return TRANSACTION_HASH
        }),
      }),
    ).rejects.toThrow(/request budget/i)
    expect(
      wallet.requests.filter(({ method }) => method === 'eth_call'),
    ).toHaveLength(MAX_FILECOIN_STORAGE_FUNDING_RPC_REQUESTS)
  })

  it('distinguishes rejection from an ambiguous send failure', async () => {
    const quote = storageQuote({ depositAmount: 0n, needsApproval: true })
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const executor = executorFor(plan)
    const rejection = Object.assign(new Error('User rejected.'), { code: 4001 })
    const rejectedWallet = walletProvider({
      logs: fundingLogs(plan),
      sendError: rejection,
    })
    await expect(
      fundFilecoinStorage(rejectedWallet.provider, quote, {
        ...fundingOptions(plan, executor),
      }),
    ).rejects.toBe(rejection)

    const failedWallet = walletProvider({
      logs: fundingLogs(plan),
      sendError: new Error('Transport failed.'),
    })
    const ambiguous = await fundFilecoinStorage(failedWallet.provider, quote, {
      ...fundingOptions(plan, executor),
    }).catch((error: unknown) => error)
    expect(isTransactionSubmissionUnknownError(ambiguous)).toBe(true)
  })

  it('keeps the submitted hash when exact receipt events are absent', async () => {
    const quote = storageQuote()
    const plan = planFilecoinStorageFunding(
      quote,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const wallet = walletProvider({ logs: [] })
    const onSubmitted = vi.fn()
    await expect(
      fundFilecoinStorage(wallet.provider, quote, {
        ...fundingOptions(plan, executorFor(plan)),
        onSubmitted,
      }),
    ).rejects.toThrow(/exact deposit event/i)
    expect(onSubmitted).toHaveBeenCalledWith(TRANSACTION_HASH)
  })

  it('rejects duplicate and cross-transaction funding events', () => {
    const plan = planFilecoinStorageFunding(
      storageQuote(),
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const receipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: TRANSACTION_HASH,
    }
    const logs = fundingLogs(plan)
    expect(() =>
      assertFilecoinStorageFundingReceipt([...logs, logs[0]], receipt, plan),
    ).toThrow(/one exact deposit event/i)
    expect(() =>
      assertFilecoinStorageFundingReceipt(
        logs.map((log) => ({ ...log, transactionHash: BLOCK_HASH })),
        receipt,
        plan,
      ),
    ).toThrow(/exact deposit event/i)
  })
})
