import { CarBufferReader } from '@ipld/car'
import { sha256 } from 'multiformats/hashes/sha2'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PAID_MEDIA_BYTES,
  MIN_PAID_MEDIA_CAR_BYTES,
  preparePaidMediaCar,
} from './paid-media-car'

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
})
