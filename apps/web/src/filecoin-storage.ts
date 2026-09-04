import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import {
  parseChainId,
  requestProviderBeforeDeadline,
  type Eip1193Provider,
} from './ethereum'

export const FILECOIN_MAINNET_CHAIN_ID = 314n
export const FILECOIN_CALIBRATION_CHAIN_ID = 314_159n
export const FILECOIN_STORAGE_INSPECTION_TIMEOUT_MS = 15_000

export type FilecoinStorageContract =
  | 'endorsements'
  | 'filecoinPay'
  | 'fwss'
  | 'fwssView'
  | 'multicall3'
  | 'pdp'
  | 'serviceProviderRegistry'
  | 'sessionKeyRegistry'
  | 'usdfc'

export type FilecoinStorageNetwork = {
  chainId: bigint
  contracts: Readonly<Record<FilecoinStorageContract, Address>>
  id: 'filecoin-calibration' | 'filecoin-mainnet'
  name: string
  testnet: boolean
}

/**
 * Filecoin Onchain Cloud deployments consumed by the pinned Synapse SDK
 * v2.0.0 quote adapter. FWSS is the discovery root; the inspection below
 * verifies its reported dependency graph before a later adapter is allowed to
 * upload or pay.
 *
 * Source: https://github.com/FilOzone/synapse-sdk/blob/synapse-sdk-v2.0.0/packages/synapse-core/src/chains.ts
 */
export const FILECOIN_STORAGE_NETWORKS = [
  {
    chainId: FILECOIN_MAINNET_CHAIN_ID,
    contracts: {
      endorsements: '0x59eFa2e8324E1551d46010d7B0B140eE2F5c726b',
      filecoinPay: '0x23b1e018F08BB982348b15a86ee926eEBf7F4DAa',
      fwss: '0x8408502033C418E1bbC97cE9ac48E5528F371A9f',
      fwssView: '0xcf184Ab1FD8D1a563054d30Aa1fFb08136998172',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      pdp: '0xBADd0B92C1c71d02E7d520f64c0876538fa2557F',
      serviceProviderRegistry: '0xf55dDbf63F1b55c3F1D4FA7e339a68AB7b64A5eB',
      sessionKeyRegistry: '0x74FD50525A958aF5d484601E252271f9625231aB',
      usdfc: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045',
    },
    id: 'filecoin-mainnet',
    name: 'Filecoin mainnet',
    testnet: false,
  },
  {
    chainId: FILECOIN_CALIBRATION_CHAIN_ID,
    contracts: {
      endorsements: '0xAA2f7CfC7ecAc616EC9C1f6d700fAd19087FAC84',
      filecoinPay: '0x09a0fDc2723fAd1A7b8e3e00eE5DF73841df55a0',
      fwss: '0x02925630df557F957f70E112bA06e50965417CA0',
      fwssView: '0x1B68d64f01bAa42014B9774605867BF4eDC0320f',
      multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
      pdp: '0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C',
      serviceProviderRegistry: '0x839e5c9988e4e9977d40708d0094103c0839Ac9D',
      sessionKeyRegistry: '0x518411c2062E119Aaf7A8B12A2eDf9a939347655',
      usdfc: '0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0',
    },
    id: 'filecoin-calibration',
    name: 'Filecoin Calibration',
    testnet: true,
  },
] as const satisfies readonly FilecoinStorageNetwork[]

export const FILECOIN_STORAGE_CONTRACT_LABELS: Readonly<
  Record<FilecoinStorageContract, string>
> = {
  endorsements: 'provider endorsements',
  filecoinPay: 'Filecoin Pay',
  fwss: 'warm storage',
  fwssView: 'warm-storage view',
  multicall3: 'Multicall3',
  pdp: 'PDP verifier',
  serviceProviderRegistry: 'service-provider registry',
  sessionKeyRegistry: 'session-key registry',
  usdfc: 'USDFC token',
}

type FwssAddressContract = Exclude<
  FilecoinStorageContract,
  'endorsements' | 'fwss' | 'multicall3'
>

const FWSS_ADDRESS_ABI = [
  {
    inputs: [],
    name: 'paymentsContractAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'viewContractAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'pdpVerifierAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'serviceProviderRegistry',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'sessionKeyRegistry',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'usdfcTokenAddress',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const FWSS_ADDRESS_GETTERS = [
  {
    contract: 'filecoinPay',
    functionName: 'paymentsContractAddress',
  },
  { contract: 'fwssView', functionName: 'viewContractAddress' },
  { contract: 'pdp', functionName: 'pdpVerifierAddress' },
  {
    contract: 'serviceProviderRegistry',
    functionName: 'serviceProviderRegistry',
  },
  {
    contract: 'sessionKeyRegistry',
    functionName: 'sessionKeyRegistry',
  },
  { contract: 'usdfc', functionName: 'usdfcTokenAddress' },
] as const satisfies readonly {
  contract: FwssAddressContract
  functionName:
    | 'paymentsContractAddress'
    | 'pdpVerifierAddress'
    | 'serviceProviderRegistry'
    | 'sessionKeyRegistry'
    | 'usdfcTokenAddress'
    | 'viewContractAddress'
}[]

export type FilecoinStorageIssue =
  | {
      address: Address
      contract: FilecoinStorageContract
      kind: 'missing-code'
    }
  | {
      contract: FwssAddressContract
      expected: Address
      kind: 'address-mismatch'
      received: Address
    }

export type FilecoinStorageInspection =
  | {
      chainId: bigint
      kind: 'unsupported-chain'
    }
  | {
      issues: readonly FilecoinStorageIssue[]
      kind: 'unavailable'
      network: FilecoinStorageNetwork
    }
  | {
      kind: 'ready'
      network: FilecoinStorageNetwork
    }

export type FilecoinStorageInspectionOptions = {
  expectedChainId?: bigint
  signal?: AbortSignal
  timeoutMs?: number
}

export function getFilecoinStorageNetwork(
  chainId: bigint | undefined,
): FilecoinStorageNetwork | undefined {
  if (chainId === undefined) return undefined
  return FILECOIN_STORAGE_NETWORKS.find(
    (network) => network.chainId === chainId,
  )
}

function inspectionError(message: string, options?: ErrorOptions) {
  return new Error(`Cannot inspect Filecoin storage: ${message}`, options)
}

function parseRpcHex(value: unknown, label: string, maximumBytes: number): Hex {
  if (
    typeof value !== 'string' ||
    value.length > maximumBytes * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw inspectionError(`the wallet returned invalid ${label}.`)
  }
  return value as Hex
}

function parseAddressResult(value: unknown, functionName: string): Address {
  const encoded = parseRpcHex(value, `${functionName} data`, 32)
  if (encoded.length !== 66 || encoded.slice(2, 26) !== '0'.repeat(24)) {
    throw inspectionError(`the wallet returned invalid ${functionName} data.`)
  }
  try {
    return getAddress(`0x${encoded.slice(26)}`)
  } catch (cause) {
    throw inspectionError(`the wallet returned invalid ${functionName} data.`, {
      cause,
    })
  }
}

function validTimeout(value: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= 60_000
}

/**
 * Verify the currently selected Filecoin network and its deployed contract
 * graph through the wallet. Reads are sequential, bounded, and only run after
 * an explicit user action; this function never polls an RPC endpoint.
 */
export async function inspectFilecoinStorage(
  provider: Eip1193Provider,
  options: FilecoinStorageInspectionOptions = {},
): Promise<FilecoinStorageInspection> {
  const timeoutMs = options.timeoutMs ?? FILECOIN_STORAGE_INSPECTION_TIMEOUT_MS
  if (!validTimeout(timeoutMs)) {
    throw inspectionError('the inspection timeout is invalid.')
  }
  let chainChanged = false
  const handleChainChanged = () => {
    chainChanged = true
  }
  const addProviderListener = provider.on?.bind(provider)
  const removeProviderListener = provider.removeListener?.bind(provider)
  if (addProviderListener && removeProviderListener) {
    addProviderListener('chainChanged', handleChainChanged)
  }
  try {
    const assertNoChainChange = () => {
      if (chainChanged) {
        throw inspectionError('the wallet chain changed during inspection.')
      }
    }
    const deadline = Date.now() + timeoutMs
    const request = async (method: string, params?: readonly unknown[]) => {
      assertNoChainChange()
      const result = await requestProviderBeforeDeadline(
        provider,
        { method, ...(params ? { params } : {}) },
        deadline,
        () => inspectionError('the wallet read timed out.'),
        options.signal,
        () => inspectionError('the inspection was cancelled.'),
      )
      assertNoChainChange()
      return result
    }
    const firstChainId = parseChainId(await request('eth_chainId'))
    if (
      options.expectedChainId !== undefined &&
      firstChainId !== options.expectedChainId
    ) {
      throw inspectionError(
        `the wallet moved from expected chain ${options.expectedChainId.toString()} to chain ${firstChainId.toString()}.`,
      )
    }
    const network = getFilecoinStorageNetwork(firstChainId)
    if (!network) return { chainId: firstChainId, kind: 'unsupported-chain' }

    const finish = async <T extends FilecoinStorageInspection>(result: T) => {
      const finalChainId = parseChainId(await request('eth_chainId'))
      if (finalChainId !== firstChainId) {
        throw inspectionError('the wallet chain changed during inspection.')
      }
      return result
    }
    const readCode = async (address: Address) =>
      parseRpcHex(
        await request('eth_getCode', [address, 'latest']),
        'contract code',
        96 * 1024,
      )

    const fwssCode = await readCode(network.contracts.fwss)
    if (fwssCode === '0x') {
      return finish({
        issues: [
          {
            address: network.contracts.fwss,
            contract: 'fwss',
            kind: 'missing-code',
          },
        ],
        kind: 'unavailable',
        network,
      })
    }

    const addressIssues: FilecoinStorageIssue[] = []
    for (const getter of FWSS_ADDRESS_GETTERS) {
      const data = encodeFunctionData({
        abi: FWSS_ADDRESS_ABI,
        functionName: getter.functionName,
      })
      const received = parseAddressResult(
        await request('eth_call', [
          { data, to: network.contracts.fwss },
          'latest',
        ]),
        getter.functionName,
      )
      const expected = network.contracts[getter.contract]
      if (received.toLowerCase() !== expected.toLowerCase()) {
        addressIssues.push({
          contract: getter.contract,
          expected,
          kind: 'address-mismatch',
          received,
        })
      }
    }
    if (addressIssues.length > 0) {
      return finish({ issues: addressIssues, kind: 'unavailable', network })
    }

    const codeIssues: FilecoinStorageIssue[] = []
    for (const [contract, address] of Object.entries(network.contracts) as [
      FilecoinStorageContract,
      Address,
    ][]) {
      if (contract === 'fwss') continue
      if ((await readCode(address)) === '0x') {
        codeIssues.push({ address, contract, kind: 'missing-code' })
      }
    }
    if (codeIssues.length > 0) {
      return finish({ issues: codeIssues, kind: 'unavailable', network })
    }

    return finish({ kind: 'ready', network })
  } finally {
    if (addProviderListener && removeProviderListener) {
      removeProviderListener('chainChanged', handleChainChanged)
    }
  }
}
