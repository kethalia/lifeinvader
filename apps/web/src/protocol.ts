import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  padHex,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import {
  beforeDeadline,
  getRpcErrorCode,
  parseAccounts,
  parseChainId,
  parseTransactionHash,
  WALLET_READ_TIMEOUT_MS,
  type Eip1193Provider,
  type ProviderRequest,
} from './ethereum'
import { decodeMediaCid } from './media-cid'
export { MAX_MEDIA_CID_BYTES } from './media-cid'
export const FACTORY_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
export const FACTORY_CODE_HASH =
  '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989'
export const PROTOCOL_ADDRESS = '0x779DEb5AD0B27BF40BDBFF3A81caB2d9049d7ad1'
export const PROTOCOL_CODE_HASH =
  '0x9289a8f9250caef94eb4c263b182f4540e50b62b713f83ab722237cfcbdb87c4'
export const DEPLOYMENT_SALT =
  '0x12f1d647ac2191038e16cc3e772d7674c8f6eb825ce09650b96d6dba48179059'
export const INIT_CODE_HASH =
  '0xa9bdddbbb0824a6b64f118b0eeb6b2c6051394933c5593ace3ee9495f4cc805e'
export const MAX_POST_BODY_BYTES = 4_096
export const LOCAL_CHAIN_ID = 31_337n
export const LOCAL_RPC_URL = 'http://127.0.0.1:8545'
export const LIFEINVADER_INIT_CODE =
  '0x608060405260016000556001805560016002556001600355348015602257600080fd5b50610d4d806100326000396000f3fe608060405234801561001057600080fd5b506004361061012c5760003560e01c80639ae9a5ca116100ad578063b3f1a39a11610071578063b3f1a39a14610224578063c4e225f614610237578063cec6cdfa1461023f578063d0bdacbe14610252578063eefbf17e1461025b57600080fd5b80639ae9a5ca146101cf5780639aee153e146101e2578063a75611e3146101f5578063a9e5ec9014610208578063b1eabf391461021157600080fd5b80635eda7a76116100f45780635eda7a761461017a578063769da0d7146101835780637bd6262c1461019657806380b28cee146101a957806398e1747f146101bc57600080fd5b80631ba44fd4146101315780632ade18c214610146578063373e2db3146101615780635c09bd98146101695780635c33f13114610172575b600080fd5b61014461013f36600461092b565b610264565b005b61014f61100081565b60405190815260200160405180910390f35b61014f604081565b61014f60005481565b61014f608081565b61014f60035481565b61014f610191366004610984565b6102e2565b61014f6101a4366004610a00565b610359565b61014f6101b7366004610a7f565b6103cc565b6101446101ca366004610af0565b610436565b6101446101dd366004610b96565b6104fc565b61014f6101f0366004610a00565b610543565b61014f610203366004610a7f565b6105ab565b61014f61040081565b61014461021f366004610bb9565b610662565b61014f610232366004610bd2565b61069b565b61014f606081565b61014461024d366004610c0f565b610746565b61014f60015481565b61014f60025481565b600083600181111561027857610278610c39565b0361028b57610286826107d5565b610294565b61029482610808565b33828460018111156102a8576102a8610c39565b60405184151581527fa6fa55005fe0b190111a9abc7df43c5e4b986d6332d5971d6fe809390bb97aa09060200160405180910390a4505050565b6000806000836001600160a01b0316856001600160a01b03161061030757838561030a565b84845b6040516bffffffffffffffffffffffff19606084811b8216602084015283901b166034820152919350915060480160405160208183030381529060405280519060200120925050505b92915050565b600061036486610838565b61037085858585610868565b6103786108d2565b905080336001600160a01b0316877fd09a35baad2f16a457a76f1875dcc3ffa7556a6515782e018f8ab2a13798c308888888886040516103bb9493929190610c78565b60405180910390a495945050505050565b60006103da85858585610868565b506000546103e9816001610caa565b600055604051339082907fe5fc58b1da4793a6b63868a467012805821ecfc10f870a845faf34a4dd5c53db90610426908990899089908990610c78565b60405180910390a3949350505050565b84604081111561046e57604080516373767f0560e11b8152610465918391600401918252602082015260400190565b60405180910390fd5b8361040081111561049d5760405163b84047d160e01b8152600481018290526104006024820152604401610465565b6104a784846108e6565b336001600160a01b03167f033f4d6cdbbae83b8a59446e605fd37762898192566e447aed006d0d815842a78989898989896040516104ea96959493929190610ccb565b60405180910390a25050505050505050565b61050582610838565b6040518115158152339083907f35b852f9d0970d7d7c8d97158385a3a58772cab7af8c74714b25f79ae466641c906020015b60405180910390a35050565b600061054e866107d5565b61055a85858585610868565b600154905080600161056c9190610caa565b6001556040513390879083907fdab0b0dd807460349a9bdbcf1e964a6f69ea6e241e844257a8ea7a47d7ea7076906103bb908a908a908a908a90610c78565b6000838082036105ce57604051634a2e0cdd60e01b815260040160405180910390fd5b60608111156105fa57604051633acbcdd760e21b81526004810182905260606024820152604401610465565b61060484846108e6565b6003549150610614826001610caa565b600355604051339083907ff32741f516bc616f96857271f14729f50e80882de799470133ec54117df98edd90610651908a908a908a908a90610c78565b60405180910390a350949350505050565b61066b816107d5565b604051339082907f48b2667530535dfe389ce140bb7872ab9a922083158958ed14099b3565381b9990600090a350565b60006001600160a01b0386166106c45760405163d92e233d60e01b815260040160405180910390fd5b6106d085858585610868565b6106d86108d2565b905060006106e633886102e2565b9050866001600160a01b0316336001600160a01b0316827fd3c21a10e60cff821a30409b33f5e1cbe639483334abf0a56db83cbdbd3f5732858a8a8a8a604051610734959493929190610d14565b60405180910390a45095945050505050565b6001600160a01b03821661076d5760405163d92e233d60e01b815260040160405180910390fd5b336001600160a01b038316036107965760405163773685ef60e01b815260040160405180910390fd5b60405181151581526001600160a01b0383169033907fd94333e426f298545f1366b65dd950a7409194062f9d6a8c4a708c8a9c1d6b6490602001610537565b8015806107e457506000548110155b15610805576040516391f2ffcb60e01b815260048101829052602401610465565b50565b80158061081757506001548110155b15610805576040516393cbe52960e01b815260048101829052602401610465565b80158061084757506003548110155b156108055760405163cfd439dd60e01b815260048101829052602401610465565b8280158015610875575081155b1561089357604051630b8fc7cd60e21b815260040160405180910390fd5b6110008111156108c157604051635d51876360e11b8152600481018290526110006024820152604401610465565b6108cb83836108e6565b5050505050565b6002546108e0816001610caa565b60025590565b608081111561091257604051630d4b64c960e41b81526004810182905260806024820152604401610465565b5050565b8035801515811461092657600080fd5b919050565b60008060006060848603121561094057600080fd5b83356002811061094f57600080fd5b92506020840135915061096460408501610916565b90509250925092565b80356001600160a01b038116811461092657600080fd5b6000806040838503121561099757600080fd5b6109a08361096d565b91506109ae6020840161096d565b90509250929050565b60008083601f8401126109c957600080fd5b50813567ffffffffffffffff8111156109e157600080fd5b6020830191508360208285010111156109f957600080fd5b9250929050565b600080600080600060608688031215610a1857600080fd5b85359450602086013567ffffffffffffffff811115610a3657600080fd5b610a42888289016109b7565b909550935050604086013567ffffffffffffffff811115610a6257600080fd5b610a6e888289016109b7565b969995985093965092949392505050565b60008060008060408587031215610a9557600080fd5b843567ffffffffffffffff811115610aac57600080fd5b610ab8878288016109b7565b909550935050602085013567ffffffffffffffff811115610ad857600080fd5b610ae4878288016109b7565b95989497509550505050565b60008060008060008060608789031215610b0957600080fd5b863567ffffffffffffffff811115610b2057600080fd5b610b2c89828a016109b7565b909750955050602087013567ffffffffffffffff811115610b4c57600080fd5b610b5889828a016109b7565b909550935050604087013567ffffffffffffffff811115610b7857600080fd5b610b8489828a016109b7565b979a9699509497509295939492505050565b60008060408385031215610ba957600080fd5b823591506109ae60208401610916565b600060208284031215610bcb57600080fd5b5035919050565b600080600080600060608688031215610bea57600080fd5b610bf38661096d565b9450602086013567ffffffffffffffff811115610a3657600080fd5b60008060408385031215610c2257600080fd5b610c2b8361096d565b91506109ae60208401610916565b634e487b7160e01b600052602160045260246000fd5b81835281816020850137506000828201602090810191909152601f909101601f19169091010190565b604081526000610c8c604083018688610c4f565b8281036020840152610c9f818587610c4f565b979650505050505050565b8082018082111561035357634e487b7160e01b600052601160045260246000fd5b606081526000610cdf60608301888a610c4f565b8281036020840152610cf2818789610c4f565b90508281036040840152610d07818587610c4f565b9998505050505050505050565b858152606060208201526000610d2e606083018688610c4f565b8281036040840152610d41818587610c4f565b9897505050505050505056' as Hex
const PUBLISH_POST_ABI = [
  {
    type: 'function',
    name: 'publishPost',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'body', type: 'string' },
      { name: 'mediaCid', type: 'bytes' },
    ],
    outputs: [{ name: 'postId', type: 'uint256' }],
  },
] as const
const PUBLISH_REPOST_ABI = [
  {
    type: 'function',
    name: 'publishRepost',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'postId', type: 'uint256' }],
    outputs: [],
  },
] as const
const SET_LIKE_ABI = [
  {
    type: 'function',
    name: 'setLike',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'contentKind', type: 'uint8' },
      { name: 'contentId', type: 'uint256' },
      { name: 'liked', type: 'bool' },
    ],
    outputs: [],
  },
] as const
export const POST_PUBLISHED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'postId', type: 'uint256' },
      { indexed: true, name: 'author', type: 'address' },
      { indexed: false, name: 'body', type: 'string' },
      { indexed: false, name: 'mediaCid', type: 'bytes' },
    ],
    name: 'PostPublished',
    type: 'event',
  },
] as const
export const REPOST_PUBLISHED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'postId', type: 'uint256' },
      { indexed: true, name: 'account', type: 'address' },
    ],
    name: 'RepostPublished',
    type: 'event',
  },
] as const
export const LIKE_SET_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'contentKind', type: 'uint8' },
      { indexed: true, name: 'contentId', type: 'uint256' },
      { indexed: true, name: 'account', type: 'address' },
      { indexed: false, name: 'liked', type: 'bool' },
    ],
    name: 'LikeSet',
    type: 'event',
  },
] as const
export const POST_PUBLISHED_TOPIC =
  '0xe5fc58b1da4793a6b63868a467012805821ecfc10f870a845faf34a4dd5c53db'
export const REPOST_PUBLISHED_TOPIC =
  '0x48b2667530535dfe389ce140bb7872ab9a922083158958ed14099b3565381b99'
export const LIKE_SET_TOPIC =
  '0xa6fa55005fe0b190111a9abc7df43c5e4b986d6332d5971d6fe809390bb97aa0'
const POST_DATA_PARAMETERS = [{ type: 'string' }, { type: 'bytes' }] as const
const LIKE_DATA_PARAMETERS = [{ type: 'bool' }] as const
const MAX_UINT256 = (1n << 256n) - 1n
export const POST_CONTENT_KIND = 0
export type ProtocolInspection =
  | { kind: 'ready' }
  | { kind: 'deployable' }
  | { kind: 'missing-factory' }
  | { kind: 'unsafe-factory' }
  | { kind: 'address-conflict' }
export type TransactionReceipt = {
  blockHash: Hash
  blockNumber: bigint
  hash: Hash
}
export type TransactionSubmitted = (hash: Hash) => void
type BlockFingerprint = {
  hash: Hash
  number: bigint
}
async function requestLocalRpc({ method, params }: ProviderRequest) {
  let response: Response
  try {
    response = await fetch(LOCAL_RPC_URL, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method,
        params: params ?? [],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  } catch {
    throw new Error(`Local Anvil did not respond at ${LOCAL_RPC_URL}.`)
  }
  if (!response.ok) {
    throw new Error(
      `Local Anvil returned HTTP ${response.status} at ${LOCAL_RPC_URL}.`,
    )
  }
  const payload: unknown = await response.json()
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error('Local Anvil returned an invalid RPC response.')
  }
  const error = 'error' in payload ? payload.error : undefined
  if (error !== undefined && error !== null) {
    const message =
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : undefined
    throw new Error(
      message?.slice(0, 240).trim() || 'Local Anvil returned an RPC error.',
    )
  }
  if (!Object.hasOwn(payload, 'result')) {
    throw new Error('Local Anvil returned an invalid RPC response.')
  }
  return (payload as { result: unknown }).result
}
const LOCAL_RPC_PROVIDER: Eip1193Provider = { request: requestLocalRpc }
function parseRpcQuantity(value: unknown, field: string): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 66 ||
    !/^0x[0-9a-f]+$/i.test(value)
  ) {
    throw new Error(`The RPC returned an invalid ${field}.`)
  }
  return BigInt(value)
}
function parseBlockFingerprint(value: unknown): BlockFingerprint {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The RPC returned invalid block data.')
  }
  const hash = 'hash' in value ? value.hash : undefined
  const number = 'number' in value ? value.number : undefined
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) {
    throw new Error('The RPC returned an invalid block hash.')
  }
  return {
    hash: hash.toLowerCase() as Hash,
    number: parseRpcQuantity(number, 'block number'),
  }
}
function localChainMismatch() {
  return new Error(
    `Chain ${LOCAL_CHAIN_ID} in the wallet does not match Anvil at ${LOCAL_RPC_URL}. Remove or update that wallet network before continuing.`,
  )
}
function parseCode(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    value.length > 49_154 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  ) {
    throw new Error('The wallet returned invalid contract code.')
  }
  return value.toLowerCase() as Hex
}
async function getCode(
  provider: Eip1193Provider,
  address: Address,
  deadline: number,
  blockTag = 'latest',
  signal?: AbortSignal,
): Promise<Hex> {
  const request = () =>
    provider.request({ method: 'eth_getCode', params: [address, blockTag] })
  const timeout = () => new Error('Contract code inspection timed out.')
  return parseCode(
    await beforeDeadline(
      request,
      deadline,
      timeout,
      signal,
      () => new Error('Contract code inspection was cancelled.'),
    ),
  )
}

export class TransactionSubmissionUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      'The wallet did not return a transaction hash. It may still have broadcast the action; check wallet activity before trying again.',
      { cause },
    )
    this.name = 'TransactionSubmissionUnknownError'
  }
}

export function isTransactionSubmissionUnknownError(
  error: unknown,
): error is TransactionSubmissionUnknownError {
  return error instanceof TransactionSubmissionUnknownError
}

export function assertProtocolConfiguration() {
  if (keccak256(LIFEINVADER_INIT_CODE) !== INIT_CODE_HASH) {
    throw new Error('The bundled Lifeinvader creation code does not match v1.')
  }
  const derivedAddress = getCreate2Address({
    bytecodeHash: INIT_CODE_HASH,
    from: FACTORY_ADDRESS,
    salt: DEPLOYMENT_SALT,
  })
  if (derivedAddress !== PROTOCOL_ADDRESS) {
    throw new Error(
      'The bundled Lifeinvader deployment address does not match v1.',
    )
  }
}
export async function inspectProtocol(
  provider: Eip1193Provider,
  timeoutMs = WALLET_READ_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ProtocolInspection> {
  const deadline = Date.now() + timeoutMs
  const protocolCode = await getCode(
    provider,
    PROTOCOL_ADDRESS,
    deadline,
    'latest',
    signal,
  )
  if (protocolCode !== '0x') {
    return keccak256(protocolCode) === PROTOCOL_CODE_HASH
      ? { kind: 'ready' }
      : { kind: 'address-conflict' }
  }
  const factoryCode = await getCode(
    provider,
    FACTORY_ADDRESS,
    deadline,
    'latest',
    signal,
  )
  if (factoryCode === '0x') return { kind: 'missing-factory' }
  if (keccak256(factoryCode) !== FACTORY_CODE_HASH)
    return { kind: 'unsafe-factory' }
  return { kind: 'deployable' }
}
export async function verifyLocalChain(
  provider: Eip1193Provider,
  localProvider: Eip1193Provider = LOCAL_RPC_PROVIDER,
  timeoutMs = WALLET_READ_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs
  const read = (source: Eip1193Provider, request: ProviderRequest) =>
    beforeDeadline(() => source.request(request), deadline, localChainMismatch)
  const walletChainId = parseRpcQuantity(
    await read(provider, { method: 'eth_chainId' }),
    'wallet chain identifier',
  )
  const localChainId = parseRpcQuantity(
    await read(localProvider, { method: 'eth_chainId' }),
    'local chain identifier',
  )
  if (walletChainId !== LOCAL_CHAIN_ID || localChainId !== LOCAL_CHAIN_ID) {
    throw localChainMismatch()
  }
  const localBlockNumber = parseRpcQuantity(
    await read(localProvider, { method: 'eth_blockNumber' }),
    'local block number',
  )
  const walletBlockNumber = parseRpcQuantity(
    await read(provider, { method: 'eth_blockNumber' }),
    'wallet block number',
  )
  if (walletBlockNumber !== localBlockNumber) throw localChainMismatch()
  const blockTag = `0x${localBlockNumber.toString(16)}`
  const [localBlockValue, walletBlockValue] = await Promise.all([
    read(localProvider, {
      method: 'eth_getBlockByNumber',
      params: [blockTag, false],
    }),
    read(provider, {
      method: 'eth_getBlockByNumber',
      params: [blockTag, false],
    }),
  ])
  let localBlock: BlockFingerprint
  let walletBlock: BlockFingerprint
  try {
    localBlock = parseBlockFingerprint(localBlockValue)
    walletBlock = parseBlockFingerprint(walletBlockValue)
  } catch {
    throw localChainMismatch()
  }
  if (
    localBlock.number !== localBlockNumber ||
    walletBlock.number !== localBlockNumber ||
    localBlock.hash !== walletBlock.hash
  ) {
    throw localChainMismatch()
  }
}
export async function switchToLocalChain(
  provider: Eip1193Provider,
  localProvider?: Eip1193Provider,
) {
  const chainId = `0x${LOCAL_CHAIN_ID.toString(16)}`
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId }],
    })
  } catch (error) {
    if (getRpcErrorCode(error) !== 4902) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: 'Lifeinvader Local (Anvil)',
          nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
          rpcUrls: ['http://127.0.0.1:8545'],
        },
      ],
    })
    const selectedChainId = await beforeDeadline(
      () => provider.request({ method: 'eth_chainId' }),
      Date.now() + WALLET_READ_TIMEOUT_MS,
      localChainMismatch,
    )
    if (parseChainId(selectedChainId) !== LOCAL_CHAIN_ID) {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId }],
      })
    }
  }
  await verifyLocalChain(provider, localProvider)
}
type TransactionGuard = {
  assertUnchanged(): void
  assertSubmission(): Promise<void>
  chainId: bigint
  release(): void
}
function chainChangedError() {
  return new Error(
    'The wallet network changed during this action. If the wallet showed a transaction, check it before trying again.',
  )
}
function accountChangedError() {
  return new Error(
    'The selected wallet account changed during this action. If the wallet showed a transaction, check it before trying again.',
  )
}
export async function createTransactionGuard(
  provider: Eip1193Provider,
  account: Address,
  chainId: bigint,
): Promise<TransactionGuard> {
  let chainChanged = false
  let accountChanged = false
  const handleChainChanged = (value: unknown) => {
    try {
      if (parseChainId(value) !== chainId) chainChanged = true
    } catch {
      chainChanged = true
    }
  }
  const handleAccountsChanged = (value: unknown) => {
    try {
      const selectedAccount = parseAccounts(value)[0]
      if (selectedAccount?.toLowerCase() !== account.toLowerCase()) {
        accountChanged = true
      }
    } catch {
      accountChanged = true
    }
  }
  provider.on?.('chainChanged', handleChainChanged)
  provider.on?.('disconnect', handleChainChanged)
  provider.on?.('accountsChanged', handleAccountsChanged)
  const assertUnchanged = () => {
    if (chainChanged) throw chainChangedError()
    if (accountChanged) throw accountChangedError()
  }
  const release = () => {
    provider.removeListener?.('chainChanged', handleChainChanged)
    provider.removeListener?.('disconnect', handleChainChanged)
    provider.removeListener?.('accountsChanged', handleAccountsChanged)
  }
  const assertChain = async () => {
    let currentChainId: bigint
    try {
      currentChainId = parseChainId(
        await beforeDeadline(
          () => provider.request({ method: 'eth_chainId' }),
          Date.now() + WALLET_READ_TIMEOUT_MS,
          chainChangedError,
        ),
      )
    } catch {
      throw chainChangedError()
    }
    if (chainChanged || currentChainId !== chainId) throw chainChangedError()
  }
  const assertSender = async () => {
    let selectedAccount: Address | undefined
    try {
      selectedAccount = parseAccounts(
        await beforeDeadline(
          () => provider.request({ method: 'eth_accounts' }),
          Date.now() + WALLET_READ_TIMEOUT_MS,
          accountChangedError,
        ),
      )[0]
    } catch {
      throw accountChangedError()
    }
    if (
      accountChanged ||
      selectedAccount?.toLowerCase() !== account.toLowerCase()
    ) {
      throw accountChangedError()
    }
  }
  const assertSubmission = async () => {
    await Promise.all([assertChain(), assertSender()])
    assertUnchanged()
  }
  try {
    await assertSubmission()
  } catch (error) {
    release()
    throw error
  }
  return { assertSubmission, assertUnchanged, chainId, release }
}
async function sendTransaction(
  provider: Eip1193Provider,
  transaction: { data: Hex; from: Address; to: Address },
  guard: TransactionGuard,
  onSubmitted?: TransactionSubmitted,
  localProvider?: Eip1193Provider,
): Promise<Hash> {
  await guard.assertSubmission()
  if (guard.chainId === LOCAL_CHAIN_ID) {
    await verifyLocalChain(provider, localProvider)
    await guard.assertSubmission()
  }
  let hashValue: unknown
  try {
    hashValue = await provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          ...transaction,
          chainId: `0x${guard.chainId.toString(16)}`,
        },
      ],
    })
  } catch (error) {
    if (getRpcErrorCode(error) === 4001) throw error
    throw new TransactionSubmissionUnknownError(error)
  }
  let hash: Hash
  try {
    hash = parseTransactionHash(hashValue)
  } catch (error) {
    throw new TransactionSubmissionUnknownError(error)
  }
  onSubmitted?.(hash)
  await guard.assertSubmission()
  return hash
}
function parseReceipt(
  value: unknown,
  hash: Hash,
):
  | { logs: unknown; receipt: TransactionReceipt; reverted: boolean }
  | undefined {
  if (value === null) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error('The wallet returned an invalid transaction receipt.')
  }
  const status = 'status' in value ? value.status : undefined
  const blockHash = 'blockHash' in value ? value.blockHash : undefined
  const blockNumber = 'blockNumber' in value ? value.blockNumber : undefined
  const transactionHash = parseTransactionHash(
    'transactionHash' in value ? value.transactionHash : undefined,
  )
  if (transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(
      'The wallet returned a receipt for a different transaction.',
    )
  }
  if (status !== '0x0' && status !== '0x1') {
    throw new Error('The wallet returned an invalid transaction status.')
  }
  if (typeof blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(blockHash)) {
    throw new Error('The wallet returned an invalid receipt block hash.')
  }
  const parsedBlockNumber = parseRpcQuantity(
    blockNumber,
    'receipt block number',
  )
  return {
    logs: 'logs' in value ? value.logs : undefined,
    receipt: {
      blockHash: blockHash.toLowerCase() as Hash,
      blockNumber: parsedBlockNumber,
      hash,
    },
    reverted: status === '0x0',
  }
}
export type PostPayload = { body: string; mediaCid: Hex }
export type ExpectedPost = PostPayload & { author: Address }
export type ExpectedPostAction =
  | { account: Address; kind: 'like'; liked: boolean; postId: bigint }
  | { account: Address; kind: 'repost'; postId: bigint }

function expectedTopic(value: Address | bigint) {
  return padHex(typeof value === 'bigint' ? toHex(value) : value, {
    size: 32,
  }).toLowerCase() as Hex
}

function hasExpectedProtocolLog(
  logs: unknown,
  receipt: TransactionReceipt,
  expectedTopics: readonly (Hex | undefined)[],
  expectedData: Hex,
) {
  if (!Array.isArray(logs) || logs.length > 1_000) {
    throw new Error('The wallet returned invalid receipt logs.')
  }
  const normalizedData = expectedData.toLowerCase()
  return logs.some((log) => {
    if (typeof log !== 'object' || log === null) return false
    const { address, data, topics } = log as Record<string, unknown>
    const blockHash = 'blockHash' in log ? log.blockHash : undefined
    const blockNumber = 'blockNumber' in log ? log.blockNumber : undefined
    const transactionHash =
      'transactionHash' in log ? log.transactionHash : undefined
    return (
      typeof address === 'string' &&
      /^0x[0-9a-f]{40}$/i.test(address) &&
      address.toLowerCase() === PROTOCOL_ADDRESS.toLowerCase() &&
      typeof blockHash === 'string' &&
      blockHash.toLowerCase() === receipt.blockHash.toLowerCase() &&
      typeof blockNumber === 'string' &&
      blockNumber.length <= 66 &&
      /^0x[0-9a-f]+$/i.test(blockNumber) &&
      BigInt(blockNumber) === receipt.blockNumber &&
      typeof transactionHash === 'string' &&
      transactionHash.toLowerCase() === receipt.hash.toLowerCase() &&
      Array.isArray(topics) &&
      topics.length === expectedTopics.length &&
      topics.every(
        (topic, index) =>
          typeof topic === 'string' &&
          topic.length === 66 &&
          /^0x[0-9a-f]{64}$/i.test(topic) &&
          (expectedTopics[index] === undefined ||
            topic.toLowerCase() === expectedTopics[index]?.toLowerCase()),
      ) &&
      typeof data === 'string' &&
      data.length === normalizedData.length &&
      data.toLowerCase() === normalizedData
    )
  })
}

export function assertExpectedPost(
  logs: unknown,
  expected: ExpectedPost,
  receipt: TransactionReceipt,
) {
  const expectedData = encodeAbiParameters(POST_DATA_PARAMETERS, [
    expected.body,
    expected.mediaCid,
  ])
  if (
    !hasExpectedProtocolLog(
      logs,
      receipt,
      [POST_PUBLISHED_TOPIC, undefined, expectedTopic(expected.author)],
      expectedData,
    )
  ) {
    throw new Error('The receipt did not contain the expected post event.')
  }
}

export function assertExpectedPostAction(
  logs: unknown,
  expected: ExpectedPostAction,
  receipt: TransactionReceipt,
) {
  const account = expectedTopic(expected.account)
  const postId = expectedTopic(expected.postId)
  const found =
    expected.kind === 'repost'
      ? hasExpectedProtocolLog(
          logs,
          receipt,
          [REPOST_PUBLISHED_TOPIC, postId, account],
          '0x',
        )
      : hasExpectedProtocolLog(
          logs,
          receipt,
          [LIKE_SET_TOPIC, expectedTopic(0n), postId, account],
          encodeAbiParameters(LIKE_DATA_PARAMETERS, [expected.liked]),
        )
  if (!found) {
    throw new Error(
      `The receipt did not contain the expected ${expected.kind} event.`,
    )
  }
}
class TransactionRevertedError extends Error {
  constructor(hash: Hash) {
    super(`Transaction ${hash} reverted on-chain.`)
    this.name = 'TransactionRevertedError'
  }
}
export function isTransactionRevertedError(
  error: unknown,
): error is TransactionRevertedError {
  return error instanceof TransactionRevertedError
}
function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
function receiptUnavailableError(hash: Hash) {
  return new Error(
    `Receipt for transaction ${hash} is still unavailable. Check its status before trying again.`,
  )
}
export async function waitForTransactionReceipt(
  provider: Eip1193Provider,
  hash: Hash,
  options: {
    assertCurrentChain?: () => Promise<void>
    assertUnchanged?: () => void
    expectedPost?: ExpectedPost
    expectedPostAction?: ExpectedPostAction
    expectProtocol?: boolean
    localProvider?: Eip1193Provider
    pollIntervalMs?: number
    selectedChainId?: bigint
    timeoutMs?: number
  } = {},
): Promise<TransactionReceipt> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const timeoutMs = options.timeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs
  const assertCurrentContext = () =>
    options.assertCurrentChain
      ? beforeDeadline(options.assertCurrentChain, deadline, () =>
          receiptUnavailableError(hash),
        )
      : Promise.resolve()
  while (true) {
    await assertCurrentContext()
    const receiptValue = await beforeDeadline(
      () =>
        provider.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      deadline,
      () => receiptUnavailableError(hash),
    )
    await assertCurrentContext()
    const parsedReceipt = parseReceipt(receiptValue, hash)
    if (parsedReceipt) {
      const { logs, receipt, reverted } = parsedReceipt
      const blockTag = `0x${receipt.blockNumber.toString(16)}`
      if (options.selectedChainId === LOCAL_CHAIN_ID) {
        await verifyLocalChain(
          provider,
          options.localProvider,
          Math.max(1, deadline - Date.now()),
        )
      }
      let protocolCode: Hex | undefined
      if (!reverted && options.expectProtocol) {
        const address = PROTOCOL_ADDRESS
        protocolCode = await getCode(provider, address, deadline, blockTag)
      }
      await assertCurrentContext()
      const blockValue = await beforeDeadline(
        () =>
          provider.request({
            method: 'eth_getBlockByNumber',
            params: [blockTag, false],
          }),
        deadline,
        () => receiptUnavailableError(hash),
      )
      options.assertUnchanged?.()
      if (blockValue !== null) {
        const canonicalBlock = parseBlockFingerprint(blockValue)
        if (
          canonicalBlock.number === receipt.blockNumber &&
          canonicalBlock.hash === receipt.blockHash
        ) {
          if (protocolCode && keccak256(protocolCode) !== PROTOCOL_CODE_HASH) {
            throw new Error('The receipt did not deploy Lifeinvader v1.')
          }
          if (!reverted && options.expectedPost) {
            assertExpectedPost(logs, options.expectedPost, receipt)
          }
          if (!reverted && options.expectedPostAction) {
            assertExpectedPostAction(logs, options.expectedPostAction, receipt)
          }
          if (reverted) throw new TransactionRevertedError(hash)
          return receipt
        }
      }
    }
    if (Date.now() >= deadline) {
      throw receiptUnavailableError(hash)
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
  }
}
export async function deployProtocol(
  provider: Eip1193Provider,
  account: Address,
  chainId: bigint,
  onSubmitted?: TransactionSubmitted,
  localProvider?: Eip1193Provider,
): Promise<TransactionReceipt | undefined> {
  assertProtocolConfiguration()
  const guard = await createTransactionGuard(provider, account, chainId)
  try {
    const inspection = await inspectProtocol(provider)
    if (inspection.kind === 'ready') return undefined
    if (inspection.kind !== 'deployable') {
      throw new Error('This chain cannot safely deploy Lifeinvader v1.')
    }
    const hash = await sendTransaction(
      provider,
      {
        data: concatHex([DEPLOYMENT_SALT, LIFEINVADER_INIT_CODE]),
        from: account,
        to: FACTORY_ADDRESS,
      },
      guard,
      onSubmitted,
      localProvider,
    )
    return await waitForTransactionReceipt(provider, hash, {
      assertCurrentChain: guard.assertSubmission,
      assertUnchanged: guard.assertUnchanged,
      expectProtocol: true,
      localProvider,
      selectedChainId: chainId,
    })
  } finally {
    guard.release()
  }
}
export function getPostBodyByteLength(body: string): number {
  return new TextEncoder().encode(body).length
}
export async function publishPost(
  provider: Eip1193Provider,
  account: Address,
  chainId: bigint,
  payload: PostPayload,
  onSubmitted?: TransactionSubmitted,
  localProvider?: Eip1193Provider,
): Promise<TransactionReceipt> {
  const { body, mediaCid } = payload
  const bodyLength =
    body.length > MAX_POST_BODY_BYTES
      ? MAX_POST_BODY_BYTES + 1
      : getPostBodyByteLength(body)
  if (bodyLength === 0 && mediaCid === '0x') {
    throw new Error('Write something or add a media CID before publishing.')
  }
  if (bodyLength > MAX_POST_BODY_BYTES) {
    throw new Error(`Posts are limited to ${MAX_POST_BODY_BYTES} UTF-8 bytes.`)
  }
  if (mediaCid !== '0x') decodeMediaCid(mediaCid)
  const guard = await createTransactionGuard(provider, account, chainId)
  try {
    if ((await inspectProtocol(provider)).kind !== 'ready') {
      throw new Error(
        'Verified Lifeinvader v1 code is required before publishing.',
      )
    }
    const hash = await sendTransaction(
      provider,
      {
        data: encodeFunctionData({
          abi: PUBLISH_POST_ABI,
          functionName: 'publishPost',
          args: [body, mediaCid],
        }),
        from: account,
        to: PROTOCOL_ADDRESS,
      },
      guard,
      onSubmitted,
      localProvider,
    )
    return await waitForTransactionReceipt(provider, hash, {
      assertCurrentChain: guard.assertSubmission,
      assertUnchanged: guard.assertUnchanged,
      expectedPost: { author: account, body, mediaCid },
      localProvider,
      selectedChainId: chainId,
    })
  } finally {
    guard.release()
  }
}

function assertPostId(postId: bigint) {
  if (postId < 1n || postId > MAX_UINT256) {
    throw new Error('The selected post identifier is invalid.')
  }
}

async function submitPostAction(
  provider: Eip1193Provider,
  account: Address,
  chainId: bigint,
  data: Hex,
  expectedPostAction: ExpectedPostAction,
  onSubmitted?: TransactionSubmitted,
  localProvider?: Eip1193Provider,
) {
  assertPostId(expectedPostAction.postId)
  const guard = await createTransactionGuard(provider, account, chainId)
  try {
    if ((await inspectProtocol(provider)).kind !== 'ready') {
      throw new Error(
        'Verified Lifeinvader v1 code is required before reacting.',
      )
    }
    const hash = await sendTransaction(
      provider,
      { data, from: account, to: PROTOCOL_ADDRESS },
      guard,
      onSubmitted,
      localProvider,
    )
    return await waitForTransactionReceipt(provider, hash, {
      assertCurrentChain: guard.assertSubmission,
      assertUnchanged: guard.assertUnchanged,
      expectedPostAction,
      localProvider,
      selectedChainId: chainId,
    })
  } finally {
    guard.release()
  }
}

export async function publishRepost(
  provider: Eip1193Provider,
  account: Address,
  chainId: bigint,
  postId: bigint,
  onSubmitted?: TransactionSubmitted,
  localProvider?: Eip1193Provider,
) {
  assertPostId(postId)
  return await submitPostAction(
    provider,
    account,
    chainId,
    encodeFunctionData({
      abi: PUBLISH_REPOST_ABI,
      functionName: 'publishRepost',
      args: [postId],
    }),
    { account, kind: 'repost', postId },
    onSubmitted,
    localProvider,
  )
}

export async function setPostLike(
  provider: Eip1193Provider,
  account: Address,
  chainId: bigint,
  postId: bigint,
  liked: boolean,
  onSubmitted?: TransactionSubmitted,
  localProvider?: Eip1193Provider,
) {
  assertPostId(postId)
  return await submitPostAction(
    provider,
    account,
    chainId,
    encodeFunctionData({
      abi: SET_LIKE_ABI,
      functionName: 'setLike',
      args: [POST_CONTENT_KIND, postId, liked],
    }),
    { account, kind: 'like', liked, postId },
    onSubmitted,
    localProvider,
  )
}
