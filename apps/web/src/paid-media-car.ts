import { CarBufferReader, CarBufferWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { importByteStream, type WritableStorage } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { hexToBytes } from 'viem'
import { parseMediaCid, type MediaCid } from './media-cid'
import { LIFEINVADER_UNIXFS_PROFILE } from './media-unixfs'

export const MAX_PAID_MEDIA_BYTES = 32 * 1024 * 1024
export const MAX_PAID_MEDIA_CAR_BYTES = MAX_PAID_MEDIA_BYTES + 1024 * 1024
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

type MediaFile = Pick<File, 'name' | 'size' | 'stream' | 'type'>

export type PaidMediaPreparationOptions = {
  onProgress?: (processedBytes: number, totalBytes: number) => void
  signal?: AbortSignal
}

class PaidMediaPreparationError extends Error {}

type CarBlock = {
  bytes: Uint8Array
  cid: CID
}

function invalidMediaFile(reason: string, options?: ErrorOptions) {
  return new PaidMediaPreparationError(
    `Cannot prepare media: ${reason}`,
    options,
  )
}

function invalidPreparedCar(reason: string, options?: ErrorOptions) {
  return new PaidMediaPreparationError(
    `Cannot use prepared media: ${reason}`,
    options,
  )
}

function equalBytes(first: Uint8Array, second: Uint8Array) {
  if (first.byteLength !== second.byteLength) return false
  return first.every((byte, index) => byte === second[index])
}

function assertMediaFile(file: MediaFile) {
  if (
    !file ||
    typeof file.name !== 'string' ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.stream !== 'function' ||
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

function encodeCar(rootCid: CID, blocks: CarBlock[], signal?: AbortSignal) {
  const byteLength = blocks.reduce(
    (length, block) => {
      return length + CarBufferWriter.blockLength(block)
    },
    CarBufferWriter.headerLength({ roots: [rootCid] }),
  )
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(byteLength), {
    roots: [rootCid],
  })
  for (const block of blocks) {
    assertNotAborted(signal)
    writer.write(block)
  }
  return writer.close()
}

/**
 * Encode a browser file as an interoperable UnixFS DAG inside a single-root
 * CARv1. Small files retain a raw root; larger files are split into 1 MiB raw
 * leaves under a dag-pb root by the unixfs-v1-2025 profile.
 */
export async function preparePaidMediaCar(
  file: MediaFile,
  options: PaidMediaPreparationOptions = {},
): Promise<PreparedMediaCar> {
  assertMediaFile(file)
  assertNotAborted(options.signal)

  const blocksByCid = new Map<string, CarBlock>()
  const blockstore: WritableStorage = {
    async put(cid, bytes) {
      const chunks: Uint8Array[] = []
      if (bytes instanceof Uint8Array) {
        chunks.push(bytes)
      } else {
        for await (const chunk of bytes) chunks.push(chunk)
      }
      const byteLength = chunks.reduce((total, chunk) => {
        return total + chunk.byteLength
      }, 0)
      const blockBytes = new Uint8Array(byteLength)
      let offset = 0
      for (const chunk of chunks) {
        blockBytes.set(chunk, offset)
        offset += chunk.byteLength
      }

      const normalizedCid = CID.decode(cid.bytes)
      blocksByCid.set(normalizedCid.toString(), {
        bytes: blockBytes,
        cid: normalizedCid,
      })
      return cid
    },
  }

  let bytesProcessed = 0
  async function* content() {
    const reader = file.stream().getReader()
    let completed = false
    let abortCancellation: Promise<void> | undefined
    const cancelPendingRead = () => {
      abortCancellation = reader.cancel(options.signal?.reason).catch(() => {
        // The abort reason remains the public failure even if cancel also fails.
      })
    }
    options.signal?.addEventListener('abort', cancelPendingRead, { once: true })
    try {
      while (true) {
        assertNotAborted(options.signal)
        const chunk = await reader.read()
        assertNotAborted(options.signal)
        if (chunk.done) {
          completed = true
          break
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw invalidMediaFile('the selected file returned invalid bytes.')
        }

        const nextBytesProcessed = bytesProcessed + chunk.value.byteLength
        if (
          !Number.isSafeInteger(nextBytesProcessed) ||
          nextBytesProcessed > file.size
        ) {
          throw invalidMediaFile(
            'the selected file changed while it was being read.',
          )
        }
        bytesProcessed = nextBytesProcessed
        options.onProgress?.(bytesProcessed, file.size)
        yield chunk.value
      }
    } finally {
      options.signal?.removeEventListener('abort', cancelPendingRead)
      if (!completed) {
        if (abortCancellation) {
          await abortCancellation
        } else {
          try {
            await reader.cancel(options.signal?.reason)
          } catch {
            // Preserve the original read or validation failure.
          }
        }
      }
      reader.releaseLock()
    }
  }

  let imported: Awaited<ReturnType<typeof importByteStream>>
  try {
    imported = await importByteStream(content(), blockstore, {
      profile: LIFEINVADER_UNIXFS_PROFILE,
    })
  } catch (cause) {
    assertNotAborted(options.signal)
    if (cause instanceof PaidMediaPreparationError) throw cause
    throw invalidMediaFile(
      'the selected file could not be read and encoded as UnixFS.',
      { cause },
    )
  }

  assertNotAborted(options.signal)
  if (bytesProcessed !== file.size) {
    throw invalidMediaFile('the selected file changed while it was being read.')
  }

  const rootCid = CID.decode(imported.cid.bytes)
  if (!blocksByCid.has(rootCid.toString())) {
    throw invalidMediaFile('the generated UnixFS root block is missing.')
  }
  const blocks = [...blocksByCid.values()].sort((left, right) => {
    const leftText = left.cid.toString()
    const rightText = right.cid.toString()
    if (leftText < rightText) return -1
    if (leftText > rightText) return 1
    return 0
  })
  if (blocks.some(({ bytes }) => bytes.byteLength > 2 * 1024 * 1024)) {
    throw invalidMediaFile('the generated UnixFS DAG has an oversized block.')
  }

  const carBytes = encodeCar(rootCid, blocks, options.signal)
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

/**
 * Revalidate and snapshot a prepared archive immediately before it crosses a
 * paid storage boundary. CAR headers do not authenticate block bodies, so each
 * block hash is recomputed and the declared root is tied back to the canonical
 * media CID. The copy prevents later caller mutation from changing signed data.
 */
export async function validatePreparedMediaCar(
  value: PreparedMediaCar,
): Promise<PreparedMediaCar> {
  if (!value || typeof value !== 'object') {
    throw invalidPreparedCar('the prepared archive is missing.')
  }
  if (!(value.carBytes instanceof Uint8Array)) {
    throw invalidPreparedCar('the archive bytes are invalid.')
  }
  if (
    value.carBytes.byteLength < MIN_PAID_MEDIA_CAR_BYTES ||
    value.carBytes.byteLength > MAX_PAID_MEDIA_CAR_BYTES
  ) {
    throw invalidPreparedCar('the archive byte length is out of bounds.')
  }
  if (
    !value.file ||
    typeof value.file.name !== 'string' ||
    typeof value.file.type !== 'string' ||
    !Number.isSafeInteger(value.file.size) ||
    value.file.size <= 0 ||
    value.file.size > MAX_PAID_MEDIA_BYTES
  ) {
    throw invalidPreparedCar('the source file description is invalid.')
  }

  let mediaCid: MediaCid
  let rootCid: CID
  try {
    const parsedMediaCid = parseMediaCid(value.mediaCid?.text ?? '')
    if (
      !parsedMediaCid ||
      parsedMediaCid.codec !== value.mediaCid.codec ||
      parsedMediaCid.bytes.toLowerCase() !== value.mediaCid.bytes.toLowerCase()
    ) {
      throw new Error('CID representations differ')
    }
    mediaCid = parsedMediaCid
    rootCid = CID.decode(value.rootCid.bytes).toV1()
    if (
      rootCid.toString() !== mediaCid.text ||
      !equalBytes(rootCid.bytes, hexToBytes(mediaCid.bytes))
    ) {
      throw new Error('root CID differs')
    }
  } catch (cause) {
    throw invalidPreparedCar('the declared root CID is inconsistent.', {
      cause,
    })
  }

  const carBytes = value.carBytes.slice()
  let reader: CarBufferReader
  try {
    reader = CarBufferReader.fromBytes(carBytes)
  } catch (cause) {
    throw invalidPreparedCar('the archive is not valid CAR data.', { cause })
  }
  const roots = reader.getRoots()
  const blocks = reader.blocks()
  if (
    reader.version !== 1 ||
    roots.length !== 1 ||
    !roots[0]?.equals(rootCid) ||
    blocks.length === 0 ||
    blocks.length > 64
  ) {
    throw invalidPreparedCar(
      'the archive must be CARv1 with one declared root and a bounded DAG.',
    )
  }

  const seen = new Set<string>()
  const blocksByCid = new Map<string, (typeof blocks)[number]>()
  for (const block of blocks) {
    const text = block.cid.toString()
    if (
      block.cid.version !== 1 ||
      (block.cid.code !== 0x55 && block.cid.code !== 0x70) ||
      block.cid.multihash.code !== 0x12 ||
      block.cid.multihash.digest.byteLength !== 32 ||
      block.bytes.byteLength === 0 ||
      block.bytes.byteLength > 2 * 1024 * 1024 ||
      seen.has(text)
    ) {
      throw invalidPreparedCar('the archive contains an unsupported block.')
    }
    seen.add(text)
    blocksByCid.set(text, block)
    const digest = await sha256.digest(block.bytes)
    if (!equalBytes(block.cid.multihash.bytes, digest.bytes)) {
      throw invalidPreparedCar('an archive block failed CID verification.')
    }
  }
  const rootBlock = blocksByCid.get(rootCid.toString())
  if (!rootBlock) {
    throw invalidPreparedCar('the declared root block is missing.')
  }

  let fileBlocks = [rootBlock]
  if (rootCid.code === 0x70) {
    let node: ReturnType<typeof dagPb.decode>
    try {
      node = dagPb.decode(rootBlock.bytes)
    } catch (cause) {
      throw invalidPreparedCar('the archive contains invalid dag-pb data.', {
        cause,
      })
    }
    fileBlocks = node.Links.map((link) => {
      if (
        link.Hash.version !== 1 ||
        link.Hash.code !== 0x55 ||
        link.Hash.multihash.code !== 0x12
      ) {
        throw invalidPreparedCar(
          'the archive does not match the deterministic UnixFS profile.',
        )
      }
      const block = blocksByCid.get(link.Hash.toString())
      if (!block) {
        throw invalidPreparedCar('the archive DAG references a missing block.')
      }
      return block
    })
  }
  const reachable = new Set(fileBlocks.map((block) => block.cid.toString()))
  reachable.add(rootCid.toString())
  if (reachable.size !== blocks.length) {
    throw invalidPreparedCar('the archive contains an unreachable block.')
  }
  const fileSize = fileBlocks.reduce((n, b) => n + b.bytes.length, 0)
  if (fileSize !== value.file.size) {
    throw invalidPreparedCar('the archive file size is inconsistent.')
  }
  let imported: Awaited<ReturnType<typeof importByteStream>>
  try {
    imported = await importByteStream(
      fileBlocks.map(({ bytes }) => bytes),
      { put: (cid) => Promise.resolve(cid) },
      { profile: LIFEINVADER_UNIXFS_PROFILE },
    )
  } catch (cause) {
    throw invalidPreparedCar(
      'the archive could not be verified with the deterministic UnixFS profile.',
      { cause },
    )
  }
  if (!CID.decode(imported.cid.bytes).equals(rootCid)) {
    throw invalidPreparedCar(
      'the archive does not match the deterministic UnixFS profile.',
    )
  }

  return Object.freeze({
    carBytes,
    file: Object.freeze({ ...value.file }),
    mediaCid: Object.freeze({ ...mediaCid }),
    rootCid,
  })
}
