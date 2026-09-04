import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { hexToBytes } from 'viem'
import { buildIpfsGatewayUrl } from './ipfs-gateway'
import type { MediaCid } from './media-cid'

export const MAX_RETRIEVED_MEDIA_BYTES = 32 * 1024 * 1024
export const MEDIA_RETRIEVAL_TIMEOUT_MS = 30_000

export type RetrievedMedia = {
  blob: Blob
  byteLength: number
  kind: 'image' | 'video'
  mimeType: string
  verified: true
}

export type MediaRetriever = (
  gatewayTemplate: string,
  cid: MediaCid,
  options?: {
    fetcher?: typeof fetch
    maximumBytes?: number
    signal?: AbortSignal
    timeoutMs?: number
  },
) => Promise<RetrievedMedia>

function retrievalError(reason: string, options?: ErrorOptions) {
  return new Error(`Cannot retrieve media: ${reason}`, options)
}

function matches(bytes: Uint8Array, expected: readonly number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  )
}

function inspectFtypBrands(bytes: Uint8Array) {
  if (bytes.byteLength < 16 || ascii(bytes, 4, 4) !== 'ftyp') return

  const shortSize = readUint32(bytes, 0)
  let boxEnd: number
  let brandOffset: number
  if (shortSize === 1) {
    if (bytes.byteLength < 24) return
    let longSize = 0n
    for (let index = 8; index < 16; index += 1) {
      longSize = longSize * 256n + BigInt(bytes[index]!)
    }
    if (longSize > BigInt(Number.MAX_SAFE_INTEGER)) return
    boxEnd = Number(longSize)
    brandOffset = 16
  } else {
    boxEnd = shortSize === 0 ? bytes.byteLength : shortSize
    brandOffset = 8
  }
  if (
    boxEnd > bytes.byteLength ||
    boxEnd < brandOffset + 8 ||
    (boxEnd - (brandOffset + 8)) % 4 !== 0
  ) {
    return
  }

  const brands = [ascii(bytes, brandOffset, 4)]
  for (let offset = brandOffset + 8; offset < boxEnd; offset += 4) {
    brands.push(ascii(bytes, offset, 4))
  }
  return brands
}

function inspectMediaType(bytes: Uint8Array): {
  kind: RetrievedMedia['kind']
  mimeType: string
} {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mimeType: 'image/png' }
  }
  if (matches(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mimeType: 'image/jpeg' }
  }
  if (
    bytes.byteLength >= 6 &&
    (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
  ) {
    return { kind: 'image', mimeType: 'image/gif' }
  }
  if (
    bytes.byteLength >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP'
  ) {
    return { kind: 'image', mimeType: 'image/webp' }
  }
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: 'video', mimeType: 'video/webm' }
  }
  if (bytes.byteLength >= 4 && ascii(bytes, 0, 4) === 'OggS') {
    return { kind: 'video', mimeType: 'video/ogg' }
  }
  const ftypBrands = inspectFtypBrands(bytes)
  if (ftypBrands) {
    return ftypBrands.some((brand) => brand === 'avif' || brand === 'avis')
      ? { kind: 'image', mimeType: 'image/avif' }
      : { kind: 'video', mimeType: 'video/mp4' }
  }
  throw retrievalError(
    'the response is not a supported PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, or Ogg file.',
  )
}

function parseRawCid(cid: MediaCid) {
  if (cid.codec !== 'raw') {
    throw retrievalError(
      'verified retrieval currently supports raw CIDs only; DAG-based media needs a trustless block traversal.',
    )
  }
  let expected: CID
  let textual: CID
  try {
    expected = CID.decode(hexToBytes(cid.bytes))
    textual = CID.parse(cid.text).toV1()
  } catch (cause) {
    throw retrievalError('the media CID is malformed.', { cause })
  }
  if (
    expected.version !== 1 ||
    expected.code !== 0x55 ||
    expected.multihash.code !== 0x12 ||
    expected.multihash.digest.byteLength !== 32 ||
    !expected.equals(textual)
  ) {
    throw retrievalError('the media CID does not identify a raw block.')
  }
  return expected
}

async function verifyRawCid(bytes: Uint8Array, expected: CID) {
  let actual: Awaited<ReturnType<typeof sha256.digest>>
  try {
    actual = await sha256.digest(bytes)
  } catch (cause) {
    throw retrievalError('this browser context cannot verify SHA-256.', {
      cause,
    })
  }
  if (
    actual.digest.byteLength !== expected.multihash.digest.byteLength ||
    actual.digest.some(
      (value, index) => value !== expected.multihash.digest[index],
    )
  ) {
    throw retrievalError('the gateway bytes do not match the on-chain raw CID.')
  }
}

function readContentLength(response: Response, maximumBytes: number) {
  const value = response.headers.get('content-length')
  if (value === null) return
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw retrievalError('the gateway returned an invalid content length.')
  }
  if (BigInt(value) > BigInt(maximumBytes)) {
    throw retrievalError(
      `the response exceeds the ${maximumBytes.toString()}-byte limit.`,
    )
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  abort: () => void,
) {
  if (!response.body) {
    throw retrievalError('the gateway response has no readable body.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (
        !ArrayBuffer.isView(chunk.value) ||
        chunk.value.BYTES_PER_ELEMENT !== 1
      ) {
        throw retrievalError('the gateway returned malformed bytes.')
      }
      const nextTotal = total + chunk.value.byteLength
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maximumBytes) {
        throw retrievalError(
          `the response exceeds the ${maximumBytes.toString()}-byte limit.`,
        )
      }
      chunks.push(chunk.value)
      total = nextTotal
    }
  } catch (error) {
    abort()
    void reader.cancel().catch(() => undefined)
    throw error
  }
  if (total === 0) throw retrievalError('the gateway returned an empty file.')

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export const retrieveIpfsMedia: MediaRetriever = async (
  gatewayTemplate,
  cid,
  options = {},
) => {
  const maximumBytes = options.maximumBytes ?? MAX_RETRIEVED_MEDIA_BYTES
  const timeoutMs = options.timeoutMs ?? MEDIA_RETRIEVAL_TIMEOUT_MS
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_RETRIEVED_MEDIA_BYTES
  ) {
    throw retrievalError('the response byte limit is invalid.')
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw retrievalError('the request timeout is invalid.')
  }
  if (options.signal?.aborted) {
    throw retrievalError('the request was cancelled.')
  }
  const expectedCid = parseRawCid(cid)

  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await (options.fetcher ?? fetch)(
      buildIpfsGatewayUrl(gatewayTemplate, cid),
      {
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      },
    )
    if (!response.ok) {
      controller.abort()
      void response.body?.cancel().catch(() => undefined)
      throw retrievalError(
        `the gateway returned HTTP ${response.status.toString()}.`,
      )
    }
    try {
      readContentLength(response, maximumBytes)
    } catch (error) {
      controller.abort()
      void response.body?.cancel().catch(() => undefined)
      throw error
    }
    const bytes = await readBoundedBody(response, maximumBytes, () =>
      controller.abort(),
    )
    controller.signal.throwIfAborted()
    await verifyRawCid(bytes, expectedCid)
    controller.signal.throwIfAborted()
    const mediaType = inspectMediaType(bytes)
    return {
      ...mediaType,
      blob: new Blob([bytes], { type: mediaType.mimeType }),
      byteLength: bytes.byteLength,
      verified: true,
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw retrievalError('the request was cancelled.', {
        cause: error instanceof Error ? error : undefined,
      })
    }
    if (timedOut) {
      throw retrievalError('the gateway request timed out.', {
        cause: error instanceof Error ? error : undefined,
      })
    }
    if (error instanceof Error && error.message.startsWith('Cannot retrieve')) {
      throw error
    }
    throw retrievalError('the gateway request failed.', {
      cause: error instanceof Error ? error : undefined,
    })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}
