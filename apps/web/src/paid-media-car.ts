import { CarBufferWriter } from '@ipld/car'
import * as raw from 'multiformats/codecs/raw'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { parseMediaCid, type MediaCid } from './media-cid'

export const MAX_PAID_MEDIA_BYTES = 32 * 1024 * 1024
export const MIN_PAID_MEDIA_CAR_BYTES = 127

export type PreparedMediaCar = {
  carBytes: Uint8Array
  file: {
    name: string
    size: number
    type: string
  }
  mediaCid: MediaCid
  rootCid: CID
}

type MediaFile = Pick<File, 'arrayBuffer' | 'name' | 'size' | 'type'>

function invalidMediaFile(reason: string, options?: ErrorOptions) {
  return new Error(`Cannot prepare media: ${reason}`, options)
}

function assertMediaFile(file: MediaFile) {
  if (
    !file ||
    typeof file.arrayBuffer !== 'function' ||
    typeof file.name !== 'string' ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.type !== 'string'
  ) {
    throw invalidMediaFile('select a valid local file.')
  }
  if (file.size === 0) throw invalidMediaFile('the selected file is empty.')
  if (file.size > MAX_PAID_MEDIA_BYTES) {
    throw invalidMediaFile(
      `the selected file exceeds the ${String(MAX_PAID_MEDIA_BYTES / 1024 / 1024)} MiB browser limit.`,
    )
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return
  signal.throwIfAborted()
  throw new DOMException('Media preparation was cancelled.', 'AbortError')
}

function encodeCar(rootCid: CID, bytes: Uint8Array) {
  const block = { bytes, cid: rootCid }
  const byteLength =
    CarBufferWriter.headerLength({ roots: [rootCid] }) +
    CarBufferWriter.blockLength(block)
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(byteLength), {
    roots: [rootCid],
  })
  return writer.write(block).close()
}

/**
 * Hash a browser file as one raw IPLD block and wrap it in a single-root CARv1.
 * The raw root CID addresses the original bytes, while the CAR is the artifact
 * sent to an optional paid storage adapter.
 */
export async function preparePaidMediaCar(
  file: MediaFile,
  options: { signal?: AbortSignal } = {},
): Promise<PreparedMediaCar> {
  assertMediaFile(file)
  assertNotAborted(options.signal)

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (cause) {
    assertNotAborted(options.signal)
    throw invalidMediaFile('the selected file could not be read.', { cause })
  }

  assertNotAborted(options.signal)
  if (bytes.byteLength !== file.size) {
    throw invalidMediaFile('the selected file changed while it was being read.')
  }

  const rootCid = CID.createV1(raw.code, await sha256.digest(bytes))
  assertNotAborted(options.signal)
  const carBytes = encodeCar(rootCid, bytes)
  if (carBytes.byteLength < MIN_PAID_MEDIA_CAR_BYTES) {
    throw invalidMediaFile(
      `the resulting archive is below the ${String(MIN_PAID_MEDIA_CAR_BYTES)}-byte paid-storage minimum.`,
    )
  }

  const mediaCid = parseMediaCid(rootCid.toString())
  if (!mediaCid) throw invalidMediaFile('the generated CID is invalid.')

  return {
    carBytes,
    file: { name: file.name, size: file.size, type: file.type },
    mediaCid,
    rootCid,
  }
}
