import * as raw from 'multiformats/codecs/raw'
import { CID as MultiformatsCid } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIpfsGatewayUrl, parseIpfsGatewayTemplate } from './ipfs-gateway'
import { parseMediaCid } from './media-cid'
import { MAX_RETRIEVED_MEDIA_BYTES, retrieveIpfsMedia } from './media-retrieval'
import { preparePaidMediaCar } from './paid-media-car'

const CID = parseMediaCid(
  'bafkreiexaqucef7aglg4zgvbw5mmu6tok2xyji3w37z7hqk665zfxzu6ze',
)!

async function rawCid(bytes: Uint8Array) {
  const localBytes = new Uint8Array(bytes.byteLength)
  localBytes.set(bytes)
  return parseMediaCid(
    MultiformatsCid.createV1(
      raw.code,
      await sha256.digest(localBytes),
    ).toString(),
  )!
}

function response(
  chunks: Uint8Array[],
  options: { contentLength?: string; status?: number } = {},
) {
  const status = options.status ?? 200
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-length'
          ? (options.contentLength ?? null)
          : null
      },
    },
    ok: status >= 200 && status < 300,
    status,
  } as Response
}

function ftyp(majorBrand: string, compatibleBrands: string[] = []) {
  const bytes = new Uint8Array(16 + compatibleBrands.length * 4)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, bytes.byteLength)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  bytes.set(new TextEncoder().encode(majorBrand), 8)
  compatibleBrands.forEach((brand, index) => {
    bytes.set(new TextEncoder().encode(brand), 16 + index * 4)
  })
  return bytes
}

function mediaFile(bytes: Uint8Array) {
  const snapshot = new Uint8Array(bytes)
  return {
    name: 'evidence.png',
    size: snapshot.byteLength,
    stream: () =>
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(snapshot)
          controller.close()
        },
      }),
    type: 'image/png',
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('IPFS media retrieval', () => {
  it('accepts explicit secure and loopback templates and builds the CID URL', () => {
    expect(
      parseIpfsGatewayTemplate(
        ' https://gateway.example/ipfs/{cid}?download=1 ',
      ),
    ).toEqual({
      origin: 'https://gateway.example',
      template: 'https://gateway.example/ipfs/{cid}?download=1',
    })
    expect(
      buildIpfsGatewayUrl('http://127.0.0.1:8080/ipfs/{cid}', CID).href,
    ).toBe(`http://127.0.0.1:8080/ipfs/${CID.text}`)
    expect(
      parseIpfsGatewayTemplate('http://localhost:8080/ipfs/{cid}').origin,
    ).toBe('http://localhost:8080')
  })

  it.each([
    ['', /enter an IPFS gateway/i],
    ['https://gateway.example/ipfs/', /contain \{cid\} exactly once/i],
    [
      'https://gateway.example/{cid}/again/{cid}',
      /contain \{cid\} exactly once/i,
    ],
    ['not a URL/{cid}', /template is invalid/i],
    ['http://gateway.example/ipfs/{cid}', /use HTTPS/i],
    ['ftp://gateway.example/ipfs/{cid}', /use HTTPS/i],
    ['https://user:secret@gateway.example/ipfs/{cid}', /credentials/i],
    ['https://gateway.example/ipfs/{cid}#preview', /fragment/i],
    ['https://{cid}.gateway.example/', /must not change the gateway origin/i],
    ['https://gateway.example/ipfs/{cid}\n', /control characters/i],
  ])('rejects unsafe gateway template %s', (template, message) => {
    expect(() => parseIpfsGatewayTemplate(template)).toThrow(message)
  })

  it('fetches only through the selected URL with ambient credentials and redirects disabled', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ])
    const fetcher = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        response([png.slice(0, 4), png.slice(4)], {
          contentLength: png.byteLength.toString(),
        }),
    )
    const matchingCid = await rawCid(png)

    const result = await retrieveIpfsMedia(
      'https://gateway.example/ipfs/{cid}',
      matchingCid,
      { fetcher },
    )

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL(`https://gateway.example/ipfs/${matchingCid.text}`),
    )
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toMatchObject({
      byteLength: png.byteLength,
      kind: 'image',
      mimeType: 'image/png',
      verified: true,
    })
    expect(result.blob.size).toBe(png.byteLength)
    expect(result.blob.type).toBe('image/png')
  })

  it.each([
    [new TextEncoder().encode('GIF89a payload'), 'image', 'image/gif'],
    [
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]),
      'video',
      'video/webm',
    ],
    [ftyp('isom', ['mp42']), 'video', 'video/mp4'],
    [ftyp('avif'), 'image', 'image/avif'],
    [ftyp('mif1', ['miaf', 'avif']), 'image', 'image/avif'],
  ] as const)(
    'recognizes supported bytes instead of trusting response headers',
    async (bytes, kind, mimeType) => {
      const matchingCid = await rawCid(bytes)
      const result = await retrieveIpfsMedia(
        'https://gateway.example/ipfs/{cid}',
        matchingCid,
        { fetcher: vi.fn(async () => response([bytes])) },
      )
      expect(result).toMatchObject({ kind, mimeType })
    },
  )

  it('rejects active and document formats even when a gateway serves them', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
    )
    const matchingCid = await rawCid(svg)
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', matchingCid, {
        fetcher: vi.fn(async () => response([svg])),
      }),
    ).rejects.toThrow(/not a supported PNG, JPEG, GIF/i)
  })

  it('rejects substituted bytes that do not match the on-chain raw CID', async () => {
    const expected = new TextEncoder().encode('GIF89a expected')
    const substituted = new TextEncoder().encode('GIF89a substituted')
    await expect(
      retrieveIpfsMedia(
        'https://gateway.example/ipfs/{cid}',
        await rawCid(expected),
        { fetcher: vi.fn(async () => response([substituted])) },
      ),
    ).rejects.toThrow(/bytes do not match the on-chain raw CID/i)
  })

  it('reconstructs the deterministic UnixFS root before displaying dag-pb media', async () => {
    const png = new Uint8Array(1024 * 1024 + 1)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const prepared = await preparePaidMediaCar(mediaFile(png))
    expect(prepared.mediaCid.codec).toBe('dag-pb')
    expect(prepared.mediaCid.text).toBe(
      'bafybeifciz62f3h2gqwddaxkoesbmqecgkphfwhba4tjxm6edztg3hd6hu',
    )

    const result = await retrieveIpfsMedia(
      'https://gateway.example/ipfs/{cid}',
      prepared.mediaCid,
      { fetcher: vi.fn(async () => response([png])) },
    )
    expect(result).toMatchObject({
      byteLength: png.byteLength,
      kind: 'image',
      mimeType: 'image/png',
      verified: true,
    })

    const substituted = new Uint8Array(png)
    substituted[substituted.byteLength - 1] = 1
    await expect(
      retrieveIpfsMedia(
        'https://gateway.example/ipfs/{cid}',
        prepared.mediaCid,
        { fetcher: vi.fn(async () => response([substituted])) },
      ),
    ).rejects.toThrow(/do not reproduce the on-chain deterministic UnixFS CID/i)
  })

  it('refuses structured DAG media without contacting the gateway', async () => {
    const structuredCid = parseMediaCid(
      'bafyreidr22rx7ja2xkdytbupiw7e36uj6cwyd2j2zkpixdy35cv3vfzmuq',
    )!
    const fetcher = vi.fn()
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', structuredCid, {
        fetcher,
      }),
    ).rejects.toThrow(/Lifeinvader-prepared dag-pb files only/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects inconsistent CID text and bytes before contacting a gateway', async () => {
    const first = await rawCid(new TextEncoder().encode('first'))
    const second = await rawCid(new TextEncoder().encode('second'))
    const fetcher = vi.fn()
    await expect(
      retrieveIpfsMedia(
        'https://gateway.example/ipfs/{cid}',
        { ...first, bytes: second.bytes },
        { fetcher },
      ),
    ).rejects.toThrow(/does not match its declared codec/i)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('cancels response bodies rejected before streaming', async () => {
    const httpCancel = vi.fn()
    let httpSignal: AbortSignal | undefined
    const httpFailure = {
      body: new ReadableStream<Uint8Array>({ cancel: httpCancel }),
      headers: { get: () => null },
      ok: false,
      status: 404,
    } as unknown as Response
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', CID, {
        fetcher: vi.fn(async (_input, init) => {
          httpSignal = init?.signal ?? undefined
          return httpFailure
        }),
      }),
    ).rejects.toThrow(/HTTP 404/i)
    expect(httpSignal?.aborted).toBe(true)
    expect(httpCancel).toHaveBeenCalledTimes(1)

    const lengthCancel = vi.fn()
    let lengthSignal: AbortSignal | undefined
    const oversized = {
      body: new ReadableStream<Uint8Array>({ cancel: lengthCancel }),
      headers: {
        get: () => (MAX_RETRIEVED_MEDIA_BYTES + 1).toString(),
      },
      ok: true,
      status: 200,
    } as unknown as Response
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', CID, {
        fetcher: vi.fn(async (_input, init) => {
          lengthSignal = init?.signal ?? undefined
          return oversized
        }),
      }),
    ).rejects.toThrow(/exceeds the 33554432-byte limit/i)
    expect(lengthSignal?.aborted).toBe(true)
    expect(lengthCancel).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed lengths and empty bodies', async () => {
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', CID, {
        fetcher: vi.fn(async () =>
          response([new Uint8Array([1])], { contentLength: 'many' }),
        ),
      }),
    ).rejects.toThrow(/invalid content length/i)
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', CID, {
        fetcher: vi.fn(async () => response([])),
      }),
    ).rejects.toThrow(/empty file/i)
  })

  it('cancels streamed responses that cross the byte limit', async () => {
    const cancel = vi.fn()
    let fetchSignal: AbortSignal | undefined
    const streamed = {
      body: new ReadableStream<Uint8Array>({
        cancel,
        start(controller) {
          controller.enqueue(new Uint8Array(5))
        },
      }),
      headers: { get: () => null },
      ok: true,
      status: 200,
    } as unknown as Response
    await expect(
      retrieveIpfsMedia('https://gateway.example/ipfs/{cid}', CID, {
        fetcher: vi.fn(async (_input, init) => {
          fetchSignal = init?.signal ?? undefined
          return streamed
        }),
        maximumBytes: 4,
      }),
    ).rejects.toThrow(/exceeds the 4-byte limit/i)
    expect(fetchSignal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('honors caller cancellation and the finite request deadline', async () => {
    const waitForAbort = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    const caller = new AbortController()
    const cancelled = retrieveIpfsMedia(
      'https://gateway.example/ipfs/{cid}',
      CID,
      { fetcher: waitForAbort, signal: caller.signal },
    )
    caller.abort()
    await expect(cancelled).rejects.toThrow(/request was cancelled/i)

    vi.useFakeTimers()
    const timedOut = retrieveIpfsMedia(
      'https://gateway.example/ipfs/{cid}',
      CID,
      { fetcher: waitForAbort, timeoutMs: 25 },
    )
    const timeoutExpectation =
      expect(timedOut).rejects.toThrow(/request timed out/i)
    await vi.advanceTimersByTimeAsync(25)
    await timeoutExpectation
  })
})
