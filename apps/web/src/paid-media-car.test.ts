import { CarBufferReader, CarBufferWriter } from '@ipld/car'
import * as dagPb from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PAID_MEDIA_BYTES,
  MAX_PAID_MEDIA_CAR_BYTES,
  MIN_PAID_MEDIA_CAR_BYTES,
  preparePaidMediaCar,
  validatePreparedMediaCar,
} from './paid-media-car'
import { parseMediaCid } from './media-cid'

const CONTENT = new TextEncoder().encode('hello world'.repeat(16))
const RAW_REPEATED_HELLO_WORLD_CID =
  'bafkreihxqxntok44xjiavm4s2xp4kplmpk472w57cmmjeqlqdipnxyzium'
const UNIXFS_CHUNK_BYTES = 1024 * 1024

function byteStream(
  bytes: Uint8Array,
  onStart?: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      onStart?.()
      controller.enqueue(copy)
      controller.close()
    },
  })
}

function mediaFile(
  bytes: Uint8Array = CONTENT,
  options: { name?: string; type?: string } = {},
) {
  const snapshot = new Uint8Array(bytes)
  return {
    name: options.name ?? 'evidence.gif',
    size: snapshot.byteLength,
    stream: () => byteStream(snapshot),
    type: options.type ?? 'image/gif',
  }
}

function encodeCar(root: CID, blocks: { bytes: Uint8Array; cid: CID }[]) {
  const length = blocks.reduce(
    (total, block) => total + CarBufferWriter.blockLength(block),
    CarBufferWriter.headerLength({ roots: [root] }),
  )
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(length), {
    roots: [root],
  })
  blocks.forEach((block) => writer.write(block))
  return writer.close()
}

describe('paid media CAR preparation', () => {
  it('creates a verifiable raw UnixFS block under the published CID', async () => {
    const prepared = await preparePaidMediaCar(mediaFile())
    const reader = CarBufferReader.fromBytes(prepared.carBytes)
    const roots = reader.getRoots()
    const blocks = reader.blocks()

    expect(reader.version).toBe(1)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.toString()).toBe(prepared.mediaCid.text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.cid.equals(prepared.rootCid)).toBe(true)
    expect(Array.from(blocks[0]?.bytes ?? [])).toEqual(Array.from(CONTENT))
    expect(prepared.mediaCid).toMatchObject({ codec: 'raw' })
    expect(prepared.carBytes.byteLength).toBeGreaterThanOrEqual(
      MIN_PAID_MEDIA_CAR_BYTES,
    )
  })

  it('chunks large files into interoperable UnixFS blocks', async () => {
    const bytes = new Uint8Array(UNIXFS_CHUNK_BYTES + 257)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251
    }

    const prepared = await preparePaidMediaCar(
      mediaFile(bytes, { name: 'evidence.mp4', type: 'video/mp4' }),
    )
    const reader = CarBufferReader.fromBytes(prepared.carBytes)
    const blocks = reader.blocks()

    expect(reader.getRoots()[0]?.equals(prepared.rootCid)).toBe(true)
    expect(prepared.mediaCid.codec).toBe('dag-pb')
    expect(blocks.filter(({ cid }) => cid.code === 0x55)).toHaveLength(2)
    expect(blocks.some(({ cid }) => cid.equals(prepared.rootCid))).toBe(true)
    expect(
      blocks.every(({ bytes: blockBytes }) => {
        return blockBytes.byteLength <= UNIXFS_CHUNK_BYTES
      }),
    ).toBe(true)
    for (const block of blocks) {
      const digest = await sha256.digest(block.bytes)
      expect(Array.from(block.cid.multihash.bytes)).toEqual(
        Array.from(digest.bytes),
      )
    }
  })

  it('uses only file bytes for deterministic content addressing', async () => {
    const first = await preparePaidMediaCar(
      mediaFile(CONTENT, { name: 'first.gif', type: 'image/gif' }),
    )
    const second = await preparePaidMediaCar(
      mediaFile(CONTENT, { name: 'renamed.mp4', type: 'video/mp4' }),
    )

    expect(first.mediaCid).toEqual(second.mediaCid)
    expect(first.carBytes).toEqual(second.carBytes)
    expect(first.file).toEqual({
      name: 'first.gif',
      size: CONTENT.byteLength,
      type: 'image/gif',
    })
    expect(second.file.name).toBe('renamed.mp4')
  })

  it('revalidates every block and snapshots bytes before paid storage', async () => {
    const prepared = await preparePaidMediaCar(mediaFile())
    const validated = await validatePreparedMediaCar(prepared)
    const firstByte = validated.carBytes[0]

    prepared.carBytes[0] = (prepared.carBytes[0] ?? 0) ^ 0xff

    expect(validated).not.toBe(prepared)
    expect(validated.carBytes).not.toBe(prepared.carBytes)
    expect(validated.carBytes[0]).toBe(firstByte)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.file)).toBe(true)
    expect(Object.isFrozen(validated.mediaCid)).toBe(true)

    const intact = await preparePaidMediaCar(mediaFile())
    const corrupted = {
      ...intact,
      carBytes: intact.carBytes.slice(),
    }
    const lastIndex = corrupted.carBytes.length - 1
    corrupted.carBytes[lastIndex] = (corrupted.carBytes[lastIndex] ?? 0) ^ 0x01
    await expect(validatePreparedMediaCar(corrupted)).rejects.toThrow(
      /failed CID verification/i,
    )
  })

  it('requires every linked block and rejects unreachable CAR payloads', async () => {
    const content = new Uint8Array(UNIXFS_CHUNK_BYTES + 257)
    const prepared = await preparePaidMediaCar(mediaFile(content))
    const blocks = CarBufferReader.fromBytes(prepared.carBytes).blocks()
    const leaf = blocks.find(({ cid }) => cid.code === 0x55)
    if (!leaf) throw new Error('Expected a raw UnixFS leaf fixture.')

    await expect(
      validatePreparedMediaCar({
        ...prepared,
        carBytes: encodeCar(
          prepared.rootCid,
          blocks.filter(({ cid }) => !cid.equals(leaf.cid)),
        ),
      }),
    ).rejects.toThrow(/references a missing block/i)

    const extraBytes = new Uint8Array([1, 2, 3, 4])
    const extraCid = CID.createV1(0x55, await sha256.digest(extraBytes))
    await expect(
      validatePreparedMediaCar({
        ...prepared,
        carBytes: encodeCar(prepared.rootCid, [
          ...blocks,
          { bytes: extraBytes, cid: extraCid },
        ]),
      }),
    ).rejects.toThrow(/unreachable block/i)

    const root = blocks.find(({ cid }) => cid.equals(prepared.rootCid))
    if (!root) throw new Error('Expected a dag-pb root fixture.')
    const invalidRootBytes = dagPb.encode({
      ...dagPb.decode(root.bytes),
      Data: undefined,
    })
    const invalidRoot = CID.createV1(
      dagPb.code,
      await sha256.digest(invalidRootBytes),
    )
    const invalidMediaCid = parseMediaCid(invalidRoot.toString())
    if (!invalidMediaCid) throw new Error('Expected a valid media CID fixture.')
    await expect(
      validatePreparedMediaCar({
        ...prepared,
        carBytes: encodeCar(invalidRoot, [
          { bytes: invalidRootBytes, cid: invalidRoot },
          ...blocks.filter(({ cid }) => !cid.equals(prepared.rootCid)),
        ]),
        mediaCid: invalidMediaCid,
        rootCid: invalidRoot,
      }),
    ).rejects.toThrow(/deterministic UnixFS profile/i)
  })

  it('rejects inconsistent roots and malformed or unbounded archives', async () => {
    const prepared = await preparePaidMediaCar(mediaFile())
    await expect(
      validatePreparedMediaCar({
        ...prepared,
        mediaCid: { ...prepared.mediaCid, codec: 'dag-pb' },
      }),
    ).rejects.toThrow(/declared root CID is inconsistent/i)

    await expect(
      validatePreparedMediaCar({
        ...prepared,
        carBytes: new Uint8Array(MIN_PAID_MEDIA_CAR_BYTES),
      }),
    ).rejects.toThrow(/not valid CAR data/i)

    await expect(
      validatePreparedMediaCar({
        ...prepared,
        carBytes: new Uint8Array(MAX_PAID_MEDIA_CAR_BYTES + 1),
      }),
    ).rejects.toThrow(/byte length is out of bounds/i)
  })

  it('matches a stable raw CID fixture', async () => {
    const bytes = new TextEncoder().encode('hello world'.repeat(4))
    const prepared = await preparePaidMediaCar(
      mediaFile(bytes, { name: 'hello.txt', type: 'text/plain' }),
    )

    expect(prepared.mediaCid.text).toBe(RAW_REPEATED_HELLO_WORLD_CID)
  })

  it('rejects empty, undersized, oversized, and malformed inputs', async () => {
    await expect(
      preparePaidMediaCar(mediaFile(new Uint8Array())),
    ).rejects.toThrow(/empty/i)
    await expect(
      preparePaidMediaCar(mediaFile(new Uint8Array([1]))),
    ).rejects.toThrow(/below the 127-byte/i)

    const stream = vi.fn(() => byteStream(CONTENT))
    await expect(
      preparePaidMediaCar({
        name: 'too-large.mp4',
        size: MAX_PAID_MEDIA_BYTES + 1,
        stream,
        type: 'video/mp4',
      }),
    ).rejects.toThrow(/32 MiB/i)
    expect(stream).not.toHaveBeenCalled()

    await expect(
      preparePaidMediaCar({
        name: 'invalid',
        size: Number.NaN,
        stream,
        type: '',
      }),
    ).rejects.toThrow(/valid local file/i)
    await expect(
      preparePaidMediaCar({
        name: 'invalid',
        size: -1,
        stream,
        type: '',
      }),
    ).rejects.toThrow(/valid local file/i)
  })

  it('rejects files whose reported size changes during the read', async () => {
    await expect(
      preparePaidMediaCar({
        name: 'changing.gif',
        size: CONTENT.byteLength + 1,
        stream: () => byteStream(CONTENT),
        type: 'image/gif',
      }),
    ).rejects.toThrow(/changed while it was being read/i)
  })

  it('preserves read failures and cancellation at async boundaries', async () => {
    const readFailure = new Error('disk detached')
    const failedStream = () => {
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.error(readFailure)
        },
      })
    }
    await expect(
      preparePaidMediaCar({
        name: 'broken.mp4',
        size: CONTENT.byteLength,
        stream: failedStream,
        type: 'video/mp4',
      }),
    ).rejects.toMatchObject({
      cause: readFailure,
      message: expect.stringMatching(/could not be read and encoded/i),
    })

    const controller = new AbortController()
    controller.abort(new DOMException('User cancelled.', 'AbortError'))
    const stream = vi.fn(() => byteStream(CONTENT))
    await expect(
      preparePaidMediaCar(
        {
          name: 'cancelled.gif',
          size: CONTENT.byteLength,
          stream,
          type: 'image/gif',
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/user cancelled/i)
    expect(stream).not.toHaveBeenCalled()

    const laterController = new AbortController()
    await expect(
      preparePaidMediaCar(
        {
          name: 'cancelled-later.gif',
          size: CONTENT.byteLength,
          stream: () => byteStream(CONTENT, () => laterController.abort()),
          type: 'image/gif',
        },
        { signal: laterController.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('actively cancels a pending file read when aborted', async () => {
    let notifyReadStarted = () => {}
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve
    })
    let cancelReason: unknown
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      cancel(reason) {
        cancelReason = reason
      },
      pull() {
        notifyReadStarted()
        return new Promise(() => {})
      },
    })
    const controller = new AbortController()
    const abortReason = new DOMException('Stop stalled read.', 'AbortError')
    const preparation = preparePaidMediaCar(
      {
        name: 'stalled.mp4',
        size: CONTENT.byteLength,
        stream: () => stream,
        type: 'video/mp4',
      },
      { signal: controller.signal },
    )

    await readStarted
    controller.abort(abortReason)

    await expect(preparation).rejects.toBe(abortReason)
    expect(cancelReason).toBe(abortReason)
  })
})
