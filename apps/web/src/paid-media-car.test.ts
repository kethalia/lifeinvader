import { CarBufferReader } from '@ipld/car'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PAID_MEDIA_BYTES,
  MIN_PAID_MEDIA_CAR_BYTES,
  preparePaidMediaCar,
} from './paid-media-car'

const CONTENT = new TextEncoder().encode('hello world'.repeat(16))
const RAW_REPEATED_HELLO_WORLD_CID =
  'bafkreihxqxntok44xjiavm4s2xp4kplmpk472w57cmmjeqlqdipnxyzium'

function mediaFile(
  bytes: Uint8Array = CONTENT,
  options: { name?: string; type?: string } = {},
) {
  const fileBytes = new Uint8Array(bytes.byteLength)
  fileBytes.set(bytes)
  return new File([fileBytes.buffer], options.name ?? 'evidence.gif', {
    type: options.type ?? 'image/gif',
  })
}

describe('paid media CAR preparation', () => {
  it('creates one verifiable raw block under the published CID', async () => {
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

    const read = vi.fn(async () => new ArrayBuffer())
    await expect(
      preparePaidMediaCar({
        arrayBuffer: read,
        name: 'too-large.mp4',
        size: MAX_PAID_MEDIA_BYTES + 1,
        type: 'video/mp4',
      }),
    ).rejects.toThrow(/32 MiB/i)
    expect(read).not.toHaveBeenCalled()

    await expect(
      preparePaidMediaCar({
        arrayBuffer: read,
        name: 'invalid',
        size: Number.NaN,
        type: '',
      }),
    ).rejects.toThrow(/valid local file/i)
    await expect(
      preparePaidMediaCar({
        arrayBuffer: read,
        name: 'invalid',
        size: -1,
        type: '',
      }),
    ).rejects.toThrow(/valid local file/i)
  })

  it('rejects files whose reported size changes during the read', async () => {
    await expect(
      preparePaidMediaCar({
        arrayBuffer: async () => CONTENT.buffer.slice(0),
        name: 'changing.gif',
        size: CONTENT.byteLength + 1,
        type: 'image/gif',
      }),
    ).rejects.toThrow(/changed while it was being read/i)
  })

  it('preserves read failures and cancellation at async boundaries', async () => {
    const readFailure = new Error('disk detached')
    await expect(
      preparePaidMediaCar({
        arrayBuffer: async () => {
          throw readFailure
        },
        name: 'broken.mp4',
        size: CONTENT.byteLength,
        type: 'video/mp4',
      }),
    ).rejects.toMatchObject({
      cause: readFailure,
      message: expect.stringMatching(/could not be read/i),
    })

    const controller = new AbortController()
    controller.abort(new DOMException('User cancelled.', 'AbortError'))
    const read = vi.fn(async () => CONTENT.buffer.slice(0))
    await expect(
      preparePaidMediaCar(
        {
          arrayBuffer: read,
          name: 'cancelled.gif',
          size: CONTENT.byteLength,
          type: 'image/gif',
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/user cancelled/i)
    expect(read).not.toHaveBeenCalled()

    const laterController = new AbortController()
    await expect(
      preparePaidMediaCar(
        {
          arrayBuffer: async () => {
            laterController.abort()
            return CONTENT.buffer.slice(0)
          },
          name: 'cancelled-later.gif',
          size: CONTENT.byteLength,
          type: 'image/gif',
        },
        { signal: laterController.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
