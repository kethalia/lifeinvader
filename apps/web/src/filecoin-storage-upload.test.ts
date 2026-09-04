import { CID } from 'multiformats/cid'
import {
  bytesToHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hash,
  type Hex,
} from 'viem'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Eip1193Provider, ProviderRequest } from './ethereum'
import {
  assertFilecoinStorageUploadReceipt,
  checkFilecoinStorageUploadReceipt,
  FILECOIN_STORAGE_DATA_SET_METADATA,
  isFilecoinStorageSubmissionUnknownError,
  MAX_FILECOIN_STORAGE_UPLOAD_RPC_REQUESTS,
  planFilecoinStorageUpload,
  uploadFilecoinStorage,
  type FilecoinStorageUploadCheckpoint,
  type FilecoinStorageUploadExecutor,
} from './filecoin-storage-upload'
import {
  FILECOIN_CALIBRATION_CHAIN_ID,
  FILECOIN_STORAGE_NETWORKS,
} from './filecoin-storage'
import type { FilecoinStorageQuote } from './filecoin-storage-quote'
import { preparePaidMediaCar, type PreparedMediaCar } from './paid-media-car'

const ACCOUNT = '0x000000000000000000000000000000000000a11c'
const OTHER_ACCOUNT = '0x000000000000000000000000000000000000b0bb'
const SERVICE_PROVIDER = '0x0000000000000000000000000000000000005e11'
const PROVIDER_ID = 17n
const DATA_SET_ID = 29n
const PIECE_ID = 41n
const CLIENT_DATA_SET_ID = 53n
const TX_HASH = `0x${'12'.repeat(32)}` as Hash
const REPLACEMENT_HASH = `0x${'23'.repeat(32)}` as Hash
const BLOCK_HASH = `0x${'34'.repeat(32)}` as Hash
const SIGNATURE = `0x${'56'.repeat(65)}` as Hex
const CALIBRATION = FILECOIN_STORAGE_NETWORKS[1]
const PIECE_CID_TEXT =
  'bafkzcibduukaynfuioybwrsevewtttso22ucohqntpc5h7crizsaw5h7gxd74eav'
const PIECE_CID = CID.parse(PIECE_CID_TEXT)

const PROVIDER_READ_ABI = [
  {
    inputs: [
      { name: 'providerId', type: 'uint256' },
      { name: 'productType', type: 'uint8' },
    ],
    name: 'getProviderWithProduct',
    outputs: [],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const APPROVAL_READ_ABI = [
  {
    inputs: [{ name: 'providerId', type: 'uint256' }],
    name: 'isProviderApproved',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'dataSetId', type: 'uint256' },
      { indexed: true, name: 'providerId', type: 'uint256' },
      { indexed: false, name: 'pdpRailId', type: 'uint256' },
      { indexed: false, name: 'cacheMissRailId', type: 'uint256' },
      { indexed: false, name: 'cdnRailId', type: 'uint256' },
      { indexed: false, name: 'payer', type: 'address' },
      { indexed: false, name: 'serviceProvider', type: 'address' },
      { indexed: false, name: 'payee', type: 'address' },
      { indexed: false, name: 'metadataKeys', type: 'string[]' },
      { indexed: false, name: 'metadataValues', type: 'string[]' },
    ],
    name: 'DataSetCreated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'dataSetId', type: 'uint256' },
      { indexed: true, name: 'pieceId', type: 'uint256' },
      {
        components: [{ name: 'data', type: 'bytes' }],
        indexed: false,
        name: 'pieceCid',
        type: 'tuple',
      },
      { indexed: false, name: 'keys', type: 'string[]' },
      { indexed: false, name: 'values', type: 'string[]' },
    ],
    name: 'PieceAdded',
    type: 'event',
  },
] as const

const TYPES = {
  AddPieces: [
    { name: 'clientDataSetId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'pieceData', type: 'Cid[]' },
    { name: 'pieceMetadata', type: 'PieceMetadata[]' },
  ],
  Cid: [{ name: 'data', type: 'bytes' }],
  CreateDataSet: [
    { name: 'clientDataSetId', type: 'uint256' },
    { name: 'payee', type: 'address' },
    { name: 'metadata', type: 'MetadataEntry[]' },
  ],
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  MetadataEntry: [
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
  ],
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  PieceMetadata: [
    { name: 'pieceIndex', type: 'uint256' },
    { name: 'metadata', type: 'MetadataEntry[]' },
  ],
  SchedulePieceRemovals: [
    { name: 'clientDataSetId', type: 'uint256' },
    { name: 'pieceIds', type: 'uint256[]' },
  ],
  TerminateService: [{ name: 'dataSetId', type: 'uint256' }],
} as const

let prepared: PreparedMediaCar

beforeAll(async () => {
  const encoded = new TextEncoder().encode('public evidence '.repeat(16))
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength))
  bytes.set(encoded)
  prepared = await preparePaidMediaCar({
    name: 'evidence.gif',
    size: bytes.byteLength,
    stream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    type: 'image/gif',
  })
})

function readyQuote(
  overrides: Partial<FilecoinStorageQuote> = {},
): FilecoinStorageQuote {
  return {
    account: ACCOUNT,
    chainId: FILECOIN_CALIBRATION_CHAIN_ID,
    copies: 1,
    dataSize: BigInt(prepared.carBytes.byteLength),
    depositNeeded: 0n,
    fees: {
      addPiecesFee: 2n,
      createDataSetFee: 3n,
      total: 5n,
    },
    lockups: {
      cacheMissLockup: 0n,
      cdnLockup: 0n,
      lifecycleLockup: 7n,
      rateDeltaPerEpoch: 1n,
      reserveReplenishment: 0n,
      streamingLockup: 11n,
      total: 18n,
    },
    needsServiceApproval: false,
    rates: { perEpoch: 1n, perMonth: 2_592_000n },
    ready: true,
    tokenDecimals: 18,
    tokenSymbol: 'USDFC',
    withCDN: false,
    ...overrides,
  }
}

function domain() {
  return {
    chainId: Number(FILECOIN_CALIBRATION_CHAIN_ID),
    name: 'FilecoinWarmStorageService',
    verifyingContract: CALIBRATION.contracts.fwss,
    version: '1',
  }
}

function createAuthorization(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    domain: domain(),
    message: {
      clientDataSetId: CLIENT_DATA_SET_ID.toString(),
      metadata: [
        { key: 'source', value: 'lifeinvader' },
        { key: 'withIPFSIndexing', value: '' },
      ],
      payee: SERVICE_PROVIDER,
      ...overrides,
    },
    primaryType: 'CreateDataSet',
    types: TYPES,
  })
}

function addAuthorization(
  mediaCid: string,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    domain: domain(),
    message: {
      clientDataSetId: CLIENT_DATA_SET_ID.toString(),
      nonce: '61',
      pieceData: [{ data: bytesToHex(PIECE_CID.bytes) }],
      pieceMetadata: [
        {
          metadata: [{ key: 'ipfsRootCID', value: mediaCid }],
          pieceIndex: '0',
        },
      ],
      ...overrides,
    },
    primaryType: 'AddPieces',
    types: TYPES,
  })
}

function providerDetails(overrides: Record<string, unknown> = {}) {
  return {
    ipniIpfs: true,
    isActive: true,
    maxPieceSizeInBytes: 32n * 1024n * 1024n,
    minPieceSizeInBytes: 127n,
    paymentTokenAddress: CALIBRATION.contracts.usdfc,
    providerId: PROVIDER_ID,
    serviceProvider: SERVICE_PROVIDER,
    serviceUrl: 'https://provider.example/pdp/',
    ...overrides,
  } as Parameters<
    Parameters<FilecoinStorageUploadExecutor>[0]['onProviderSelected']
  >[0] & { carByteLength?: number }
}

function storageLogs(
  hash: Hash = REPLACEMENT_HASH,
  overrides: {
    dataSetId?: bigint
    dataSetMetadataValues?: string[]
    mediaCid?: string
    pieceCid?: Hex
    pieceId?: bigint
    providerId?: bigint
    serviceProvider?: `0x${string}`
  } = {},
) {
  const dataSetId = overrides.dataSetId ?? DATA_SET_ID
  const pieceId = overrides.pieceId ?? PIECE_ID
  const serviceProvider = overrides.serviceProvider ?? SERVICE_PROVIDER
  const providerId = overrides.providerId ?? PROVIDER_ID
  const common = {
    address: CALIBRATION.contracts.fwss,
    blockHash: BLOCK_HASH,
    blockNumber: '0x2a',
    transactionHash: hash,
  }
  return [
    {
      ...common,
      data: encodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'address' },
          { type: 'address' },
          { type: 'string[]' },
          { type: 'string[]' },
        ],
        [
          67n,
          0n,
          0n,
          ACCOUNT,
          serviceProvider,
          serviceProvider,
          ['source', 'withIPFSIndexing'],
          overrides.dataSetMetadataValues ?? ['lifeinvader', ''],
        ],
      ),
      topics: encodeEventTopics({
        abi: EVENT_ABI,
        args: { dataSetId, providerId },
        eventName: 'DataSetCreated',
      }),
    },
    {
      ...common,
      data: encodeAbiParameters(
        [
          {
            components: [{ name: 'data', type: 'bytes' }],
            type: 'tuple',
          },
          { type: 'string[]' },
          { type: 'string[]' },
        ],
        [
          { data: overrides.pieceCid ?? bytesToHex(PIECE_CID.bytes) },
          ['ipfsRootCID'],
          [overrides.mediaCid ?? prepared.mediaCid.text],
        ],
      ),
      topics: encodeEventTopics({
        abi: EVENT_ABI,
        args: { dataSetId, pieceId },
        eventName: 'PieceAdded',
      }),
    },
  ]
}

function walletProvider({
  account = ACCOUNT,
  hash = REPLACEMENT_HASH,
  logs = storageLogs(hash),
  methods = [],
  signatureError,
}: {
  account?: string
  hash?: Hash
  logs?: unknown[]
  methods?: string[]
  signatureError?: unknown
} = {}): Eip1193Provider {
  return {
    async request({ method }: ProviderRequest) {
      methods.push(method)
      if (method === 'eth_accounts') return [account]
      if (method === 'eth_chainId') {
        return `0x${FILECOIN_CALIBRATION_CHAIN_ID.toString(16)}`
      }
      if (method === 'eth_blockNumber') return '0x29'
      if (method === 'eth_call') return '0x'
      if (method === 'eth_signTypedData_v4') {
        if (signatureError) throw signatureError
        return SIGNATURE
      }
      if (method === 'eth_getTransactionReceipt') {
        return {
          blockHash: BLOCK_HASH,
          blockNumber: '0x2a',
          logs,
          status: '0x1',
          transactionHash: hash,
        }
      }
      if (method === 'eth_getBlockByNumber') {
        return { hash: BLOCK_HASH, number: '0x2a' }
      }
      throw new Error(`Unexpected wallet method ${method}`)
    },
  }
}

function inspection() {
  return vi.fn(async () => ({
    kind: 'ready' as const,
    network: CALIBRATION,
  }))
}

function successfulExecutor({
  confirmedTxHash = REPLACEMENT_HASH,
  createData = createAuthorization(),
  addData,
  dataSetId = DATA_SET_ID,
  initialTxHash = TX_HASH,
  pieceId = PIECE_ID,
  providerOverrides,
}: {
  addData?: string
  confirmedTxHash?: Hash
  createData?: string
  dataSetId?: bigint
  initialTxHash?: Hash
  pieceId?: bigint
  providerOverrides?: Record<string, unknown>
} = {}): FilecoinStorageUploadExecutor {
  return async ({
    authorizeCommit,
    onProviderSelected,
    onStored,
    onSubmitted,
    plan,
    reportProgress,
    request,
  }) => {
    await request({
      method: 'eth_call',
      params: [
        {
          data: encodeFunctionData({
            abi: PROVIDER_READ_ABI,
            args: [plan.providerId, 0],
            functionName: 'getProviderWithProduct',
          }),
          to: plan.network.contracts.serviceProviderRegistry,
        },
        'latest',
      ],
    })
    await request({
      method: 'eth_call',
      params: [
        {
          data: encodeFunctionData({
            abi: APPROVAL_READ_ABI,
            args: [plan.providerId],
            functionName: 'isProviderApproved',
          }),
          to: plan.network.contracts.fwssView,
        },
        'latest',
      ],
    })
    onProviderSelected(providerDetails(providerOverrides))
    reportProgress(plan.carBytes.byteLength)
    onStored({
      bytes: PIECE_CID.bytes,
      paddedSize: 512n,
      size: plan.carBytes.byteLength,
      text: PIECE_CID_TEXT,
    })
    await request({
      method: 'eth_signTypedData_v4',
      params: [plan.account, createData],
    })
    await request({
      method: 'eth_signTypedData_v4',
      params: [plan.account, addData ?? addAuthorization(plan.mediaCid)],
    })
    await authorizeCommit()
    onSubmitted(initialTxHash)
    return {
      confirmedTxHash,
      dataSetId,
      isNewDataSet: true,
      pieceIds: [pieceId],
      txHash: initialTxHash,
    }
  }
}

async function runUpload(
  executeUpload: FilecoinStorageUploadExecutor = successfulExecutor(),
  options: {
    hash?: Hash
    logs?: unknown[]
    onStored?: (checkpoint: FilecoinStorageUploadCheckpoint) => void
    onSubmitted?: (hash: Hash) => void
    provider?: Eip1193Provider
  } = {},
) {
  const hash = options.hash ?? REPLACEMENT_HASH
  return await uploadFilecoinStorage(
    options.provider ??
      walletProvider({ hash, logs: options.logs ?? storageLogs(hash) }),
    prepared,
    readyQuote(),
    PROVIDER_ID,
    {
      executeUpload,
      expectedAccount: ACCOUNT,
      expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
      inspectStorage: inspection(),
      onStored: options.onStored,
      onSubmitted: options.onSubmitted,
      pollIntervalMs: 1,
      receiptTimeoutMs: 100,
    },
  )
}

describe('Filecoin storage upload planning', () => {
  it('snapshots one ready quote and one explicit provider', async () => {
    const plan = await planFilecoinStorageUpload(
      prepared,
      readyQuote(),
      PROVIDER_ID,
      ACCOUNT,
      FILECOIN_CALIBRATION_CHAIN_ID,
    )
    const byte = plan.carBytes[0]
    prepared.carBytes[0] = (prepared.carBytes[0] ?? 0) ^ 0xff

    expect(plan).toMatchObject({
      account: ACCOUNT,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      mediaCid: prepared.mediaCid.text,
      providerId: PROVIDER_ID,
    })
    expect(plan.carBytes[0]).toBe(byte)
    expect(plan.carBytes).not.toBe(prepared.carBytes)
    expect(Object.isFrozen(plan)).toBe(true)

    prepared.carBytes[0] = (prepared.carBytes[0] ?? 0) ^ 0xff
  })

  it('rejects stale, unfunded, inconsistent, and unsupported plans', async () => {
    await expect(
      planFilecoinStorageUpload(
        prepared,
        readyQuote({ dataSize: 999n }),
        PROVIDER_ID,
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).rejects.toThrow(/different media or wallet context/i)
    await expect(
      planFilecoinStorageUpload(
        prepared,
        readyQuote({
          depositNeeded: 1n,
          needsServiceApproval: true,
          ready: false,
        }),
        PROVIDER_ID,
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).rejects.toThrow(/not ready/i)
    await expect(
      planFilecoinStorageUpload(
        prepared,
        readyQuote({ fees: { ...readyQuote().fees, total: 99n } }),
        PROVIDER_ID,
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).rejects.toThrow(/internally inconsistent/i)
    await expect(
      planFilecoinStorageUpload(
        prepared,
        readyQuote(),
        0n,
        ACCOUNT,
        FILECOIN_CALIBRATION_CHAIN_ID,
      ),
    ).rejects.toThrow(/provider ID/i)
    await expect(
      planFilecoinStorageUpload(
        prepared,
        readyQuote(),
        PROVIDER_ID,
        ACCOUNT,
        1n,
      ),
    ).rejects.toThrow(/unsupported/i)
  })
})

describe('Filecoin storage upload execution', () => {
  it('constrains reads and signatures, follows a replacement, and verifies events', async () => {
    const methods: string[] = []
    const submitted: Hash[] = []
    const stored = vi.fn()
    const result = await runUpload(successfulExecutor(), {
      onStored: stored,
      onSubmitted: (hash) => submitted.push(hash),
      provider: walletProvider({ methods }),
    })

    expect(result).toMatchObject({
      account: ACCOUNT,
      carByteLength: prepared.carBytes.byteLength,
      chainId: FILECOIN_CALIBRATION_CHAIN_ID,
      dataSetId: DATA_SET_ID,
      initialTransactionHash: TX_HASH,
      ipfsIndexingRequested: true,
      mediaCid: prepared.mediaCid.text,
      pieceId: PIECE_ID,
      provider: {
        id: PROVIDER_ID,
        serviceProvider: SERVICE_PROVIDER,
        serviceUrl: 'https://provider.example/pdp/',
      },
      transactionHash: REPLACEMENT_HASH,
      withCDN: false,
    })
    expect(result.providerPieceUrl).toBe(
      `https://provider.example/pdp/piece/${PIECE_CID_TEXT}`,
    )
    expect(result.receipt.hash).toBe(REPLACEMENT_HASH)
    expect(submitted).toEqual([TX_HASH, REPLACEMENT_HASH])
    expect(stored).toHaveBeenCalledOnce()
    expect(methods.filter((method) => method === 'eth_call')).toHaveLength(2)
    expect(
      methods.filter((method) => method === 'eth_signTypedData_v4'),
    ).toHaveLength(2)
    expect(methods).not.toContain('eth_sendTransaction')
  })

  it('rejects arbitrary reads, transactions, and excess RPC requests', async () => {
    const forbidden: FilecoinStorageUploadExecutor = async ({ request }) => {
      await request({ method: 'eth_sendTransaction', params: [] })
      throw new Error('unreachable')
    }
    await expect(runUpload(forbidden)).rejects.toThrow(/forbidden RPC method/i)

    const wrongRead: FilecoinStorageUploadExecutor = async ({
      plan,
      request,
    }) => {
      await request({
        method: 'eth_call',
        params: [
          {
            data: encodeFunctionData({
              abi: APPROVAL_READ_ABI,
              args: [plan.providerId + 1n],
              functionName: 'isProviderApproved',
            }),
            to: plan.network.contracts.fwssView,
          },
          'latest',
        ],
      })
      throw new Error('unreachable')
    }
    await expect(runUpload(wrongRead)).rejects.toThrow(
      /unexpected contract read/i,
    )

    const greedy: FilecoinStorageUploadExecutor = async ({ request }) => {
      for (
        let index = 0;
        index <= MAX_FILECOIN_STORAGE_UPLOAD_RPC_REQUESTS;
        index += 1
      ) {
        await request({ method: 'eth_blockNumber' })
      }
      throw new Error('unreachable')
    }
    await expect(runUpload(greedy)).rejects.toThrow(/RPC request budget/i)
  })

  it('rejects changed typed-data terms before forwarding them', async () => {
    const wallet = walletProvider()
    const request = vi.spyOn(wallet, 'request')
    await expect(
      runUpload(
        successfulExecutor({
          createData: createAuthorization({ payee: OTHER_ACCOUNT }),
        }),
        { provider: wallet },
      ),
    ).rejects.toThrow(/data-set authorization terms/i)
    expect(
      request.mock.calls.filter(([candidate]) => {
        return candidate.method === 'eth_signTypedData_v4'
      }),
    ).toHaveLength(0)

    const walletForPiece = walletProvider()
    const pieceRequest = vi.spyOn(walletForPiece, 'request')
    await expect(
      runUpload(
        successfulExecutor({
          addData: addAuthorization(prepared.mediaCid.text, {
            pieceMetadata: [
              {
                metadata: [{ key: 'ipfsRootCID', value: 'bafkqaaa' }],
                pieceIndex: '0',
              },
            ],
          }),
        }),
        { provider: walletForPiece },
      ),
    ).rejects.toThrow(/piece authorization terms/i)
    expect(
      pieceRequest.mock.calls.filter(([candidate]) => {
        return candidate.method === 'eth_signTypedData_v4'
      }),
    ).toHaveLength(1)
  })

  it('rejects providers that cannot perform the promised IPFS path', async () => {
    await expect(
      runUpload(successfulExecutor({ providerOverrides: { ipniIpfs: false } })),
    ).rejects.toThrow(/does not advertise IPFS indexing/i)
    await expect(
      runUpload(
        successfulExecutor({
          providerOverrides: { serviceUrl: 'http://provider.example/' },
        }),
      ),
    ).rejects.toThrow(/credential-free HTTPS/i)
    await expect(
      runUpload(
        successfulExecutor({
          providerOverrides: { paymentTokenAddress: 'not-an-address' },
        }),
      ),
    ).rejects.toThrow(/provider payment token is invalid/i)
    await expect(
      runUpload(
        successfulExecutor({
          providerOverrides: {
            minPieceSizeInBytes: BigInt(prepared.carBytes.byteLength + 1),
          },
        }),
      ),
    ).rejects.toThrow(/outside the provider size range/i)
  })

  it('requires a complete upload and exactly two signatures before commit', async () => {
    const incomplete: FilecoinStorageUploadExecutor = async ({
      authorizeCommit,
      onProviderSelected,
      onStored,
      plan,
      reportProgress,
      request,
    }) => {
      onProviderSelected(providerDetails())
      reportProgress(plan.carBytes.byteLength - 1)
      onStored({
        bytes: PIECE_CID.bytes,
        paddedSize: 512n,
        size: plan.carBytes.byteLength,
        text: PIECE_CID_TEXT,
      })
      await request({
        method: 'eth_signTypedData_v4',
        params: [plan.account, createAuthorization()],
      })
      await request({
        method: 'eth_signTypedData_v4',
        params: [plan.account, addAuthorization(plan.mediaCid)],
      })
      await authorizeCommit()
      throw new Error('unreachable')
    }
    await expect(runUpload(incomplete)).rejects.toThrow(
      /incomplete storage commit/i,
    )

    const oneSignature: FilecoinStorageUploadExecutor = async ({
      authorizeCommit,
      onProviderSelected,
      onStored,
      plan,
      reportProgress,
      request,
    }) => {
      onProviderSelected(providerDetails())
      reportProgress(plan.carBytes.byteLength)
      onStored({
        bytes: PIECE_CID.bytes,
        paddedSize: 512n,
        size: plan.carBytes.byteLength,
        text: PIECE_CID_TEXT,
      })
      await request({
        method: 'eth_signTypedData_v4',
        params: [plan.account, createAuthorization()],
      })
      await authorizeCommit()
      throw new Error('unreachable')
    }
    await expect(runUpload(oneSignature)).rejects.toThrow(
      /incomplete storage commit/i,
    )
  })

  it('preserves wallet rejection before any provider commit', async () => {
    const rejection = Object.assign(new Error('User rejected.'), { code: 4001 })
    await expect(
      runUpload(successfulExecutor(), {
        provider: walletProvider({ signatureError: rejection }),
      }),
    ).rejects.toBe(rejection)
  })

  it('returns a recovery checkpoint when provider submission is uncertain', async () => {
    const checkpoints: FilecoinStorageUploadCheckpoint[] = []
    const uncertain: FilecoinStorageUploadExecutor = async (input) => {
      const base = successfulExecutor({ confirmedTxHash: TX_HASH })
      await base({
        ...input,
        onSubmitted(hash) {
          input.onSubmitted(hash)
          throw new Error('provider disconnected after accepting commit')
        },
      })
      throw new Error('unreachable')
    }
    let failure: unknown
    try {
      await runUpload(uncertain, {
        onStored: (checkpoint) => checkpoints.push(checkpoint),
      })
    } catch (error) {
      failure = error
    }
    expect(isFilecoinStorageSubmissionUnknownError(failure)).toBe(true)
    if (!isFilecoinStorageSubmissionUnknownError(failure)) return
    expect(failure.transactionHash).toBe(TX_HASH)
    expect(failure.checkpoint).toEqual(checkpoints[0])
    expect(failure.checkpoint.mediaCid).toBe(prepared.mediaCid.text)

    const noHash: FilecoinStorageUploadExecutor = async ({
      authorizeCommit,
      onProviderSelected,
      onStored,
      plan,
      reportProgress,
      request,
    }) => {
      onProviderSelected(providerDetails())
      reportProgress(plan.carBytes.byteLength)
      onStored({
        bytes: PIECE_CID.bytes,
        paddedSize: 512n,
        size: plan.carBytes.byteLength,
        text: PIECE_CID_TEXT,
      })
      await request({
        method: 'eth_signTypedData_v4',
        params: [plan.account, createAuthorization()],
      })
      await request({
        method: 'eth_signTypedData_v4',
        params: [plan.account, addAuthorization(plan.mediaCid)],
      })
      await authorizeCommit()
      throw new Error('provider disconnected before returning a hash')
    }
    await expect(runUpload(noHash)).rejects.toMatchObject({
      name: 'FilecoinStorageSubmissionUnknownError',
      transactionHash: undefined,
    })
  })

  it('releases both wallet listener layers when registration fails', async () => {
    const registrationFailure = new Error('listener registration failed')
    const base = walletProvider()
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    let registrations = 0
    const provider: Eip1193Provider = {
      request: base.request,
      on(event, listener) {
        registrations += 1
        if (registrations === 4) throw registrationFailure
        const entries = listeners.get(event) ?? new Set()
        entries.add(listener)
        listeners.set(event, entries)
      },
      removeListener(event, listener) {
        listeners.get(event)?.delete(listener)
      },
    }

    await expect(runUpload(successfulExecutor(), { provider })).rejects.toBe(
      registrationFailure,
    )
    expect([...listeners.values()].every((entries) => entries.size === 0)).toBe(
      true,
    )
  })
})

describe('Filecoin storage receipt authentication', () => {
  async function checkpoint() {
    let captured: FilecoinStorageUploadCheckpoint | undefined
    await runUpload(successfulExecutor(), {
      onStored(value) {
        captured = value
      },
    })
    if (!captured) throw new Error('Checkpoint was not captured.')
    return captured
  }

  it('derives IDs from exact canonical events for later recovery', async () => {
    const saved = await checkpoint()
    await expect(
      checkFilecoinStorageUploadReceipt(
        walletProvider(),
        REPLACEMENT_HASH,
        saved,
        {
          expectedAccount: ACCOUNT,
          expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
          pollIntervalMs: 1,
          receiptTimeoutMs: 100,
        },
      ),
    ).resolves.toMatchObject({
      dataSetId: DATA_SET_ID,
      pieceId: PIECE_ID,
      receipt: { hash: REPLACEMENT_HASH },
    })
  })

  it('rejects changed metadata, identities, duplicates, and provider result IDs', async () => {
    await expect(
      runUpload(successfulExecutor(), {
        logs: storageLogs(REPLACEMENT_HASH, {
          dataSetMetadataValues: ['another-app', ''],
        }),
      }),
    ).rejects.toThrow(/data-set event changed/i)
    const cdnLogs = storageLogs()
    const dataSet = cdnLogs[0] as Record<string, unknown>
    dataSet.data = encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'string[]' },
        { type: 'string[]' },
      ],
      [
        67n,
        0n,
        1n,
        ACCOUNT,
        SERVICE_PROVIDER,
        SERVICE_PROVIDER,
        ['source', 'withIPFSIndexing'],
        ['lifeinvader', ''],
      ],
    )
    await expect(
      runUpload(successfulExecutor(), { logs: cdnLogs }),
    ).rejects.toThrow(/data-set event changed/i)
    await expect(
      runUpload(successfulExecutor(), {
        logs: storageLogs(REPLACEMENT_HASH, {
          mediaCid: 'bafkqaaa',
        }),
      }),
    ).rejects.toThrow(/piece event changed/i)
    await expect(
      runUpload(successfulExecutor(), {
        logs: storageLogs(REPLACEMENT_HASH, {
          serviceProvider: OTHER_ACCOUNT,
        }),
      }),
    ).rejects.toThrow(/data-set event changed/i)
    const duplicated = storageLogs()
    duplicated.push(duplicated[1] as (typeof duplicated)[number])
    await expect(
      runUpload(successfulExecutor(), { logs: duplicated }),
    ).rejects.toThrow(/exactly one data set and one piece/i)
    await expect(
      runUpload(successfulExecutor({ pieceId: PIECE_ID + 1n })),
    ).rejects.toThrow(/provider result disagrees/i)
  })

  it('rejects noncanonical receipt fields and wrong recovery context', async () => {
    const saved = await checkpoint()
    const receipt = {
      blockHash: BLOCK_HASH,
      blockNumber: 42n,
      hash: REPLACEMENT_HASH,
    }
    const logs = storageLogs()
    ;(logs[0] as Record<string, unknown>).transactionHash = TX_HASH
    expect(() =>
      assertFilecoinStorageUploadReceipt(logs, receipt, saved),
    ).toThrow(/not canonical/i)

    await expect(
      checkFilecoinStorageUploadReceipt(
        walletProvider(),
        REPLACEMENT_HASH,
        saved,
        {
          expectedAccount: OTHER_ACCOUNT,
          expectedChainId: FILECOIN_CALIBRATION_CHAIN_ID,
          pollIntervalMs: 1,
          receiptTimeoutMs: 100,
        },
      ),
    ).rejects.toThrow(/different upload context/i)
  })

  it('does not mistake an indexing request for completed indexing', async () => {
    expect(FILECOIN_STORAGE_DATA_SET_METADATA).toEqual({
      source: 'lifeinvader',
      withIPFSIndexing: '',
    })
    const result = await runUpload()
    expect(result.ipfsIndexingRequested).toBe(true)
    expect(result).not.toHaveProperty('indexed')
    expect(result).not.toHaveProperty('pinned')
  })
})
