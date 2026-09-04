import { CarBufferWriter } from '@ipld/car'
import { importByteStream, type WritableStorage } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import { parseMediaCid, type MediaCid } from './media-cid'
import { LIFEINVADER_UNIXFS_PROFILE } from './media-unixfs'

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
