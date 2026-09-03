import { base32 } from 'multiformats/bases/base32'
import { CID } from 'multiformats/cid'
import { bytesToHex, hexToBytes, type Hex } from 'viem'

export const MAX_MEDIA_CID_TEXT_LENGTH = 256
const SHA2_256_CODE = 0x12
const SHA2_256_DIGEST_BYTES = 32

export const MAX_MEDIA_CID_BYTES = 128

const MEDIA_CODECS = new Map<number, MediaCidCodec>([
  [0x55, 'raw'],
  [0x70, 'dag-pb'],
  [0x71, 'dag-cbor'],
  [0x0129, 'dag-json'],
])

export type MediaCidCodec = 'dag-cbor' | 'dag-json' | 'dag-pb' | 'raw'

export type MediaCid = {
  bytes: Hex
  codec: MediaCidCodec
  text: string
}

function invalidCid(reason?: string) {
  return new Error(
    reason
      ? `Invalid media CID: ${reason}`
      : 'Invalid media CID. Paste a CIDv0 or CIDv1 value.',
  )
}

function normalizeMediaCid(cid: CID): MediaCid {
  const normalized = cid.toV1()
  const codec = MEDIA_CODECS.get(normalized.code)
  if (!codec) {
    throw invalidCid('only raw, dag-pb, dag-cbor, and dag-json are supported.')
  }
  if (
    normalized.multihash.code !== SHA2_256_CODE ||
    normalized.multihash.digest.byteLength !== SHA2_256_DIGEST_BYTES
  ) {
    throw invalidCid('a 32-byte SHA-256 multihash is required.')
  }
  if (normalized.bytes.byteLength > MAX_MEDIA_CID_BYTES) {
    throw invalidCid(
      `binary form exceeds ${MAX_MEDIA_CID_BYTES.toString()} bytes.`,
    )
  }
  return {
    bytes: bytesToHex(normalized.bytes),
    codec,
    text: normalized.toString(base32),
  }
}

export function parseMediaCid(value: string): MediaCid | undefined {
  const candidate = value.trim()
  if (candidate.length === 0) return undefined
  if (candidate.length > MAX_MEDIA_CID_TEXT_LENGTH) {
    throw invalidCid('text form is too long.')
  }
  let cid: CID
  try {
    cid = CID.parse(candidate)
  } catch {
    throw invalidCid()
  }
  return normalizeMediaCid(cid)
}

export function decodeMediaCid(value: Hex): MediaCid {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > MAX_MEDIA_CID_BYTES * 2 + 2 ||
    !/^0x(?:[0-9a-f]{2})+$/i.test(value)
  ) {
    throw invalidCid('binary form is malformed or out of bounds.')
  }
  try {
    return normalizeMediaCid(CID.decode(hexToBytes(value)))
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Invalid media CID')
    ) {
      throw error
    }
    throw invalidCid('binary form cannot be decoded.')
  }
}
