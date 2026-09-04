import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMediaCid } from './media-cid'
import type { RetrievedMedia } from './media-retrieval'
import { MediaViewer } from './media-viewer'

const CID = parseMediaCid(
  'bafkreiexaqucef7aglg4zgvbw5mmu6tok2xyji3w37z7hqk665zfxzu6ze',
)!
const DAG_CID = parseMediaCid('QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C')!
const GATEWAY = 'https://gateway.example/ipfs/{cid}'

function image(): RetrievedMedia {
  return {
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
      type: 'image/png',
    }),
    byteLength: 4,
    kind: 'image',
    mimeType: 'image/png',
    verified: true,
  }
}

function objectUrls() {
  return {
    create: vi.fn(() => 'blob:lifeinvader-media'),
    revoke: vi.fn(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('MediaViewer', () => {
  it('shows canonical commitments without loading or trusting malformed bytes', () => {
    const retrieve = vi.fn()
    const view = render(
      <MediaViewer
        label="media for post #1"
        retrieve={retrieve}
        value={CID.bytes}
      />,
    )

    expect(screen.getByText(CID.text)).toBeTruthy()
    expect(screen.getByText(/IPFS media commitment · raw/i)).toBeTruthy()
    expect(screen.getByText(/configure an opt-in gateway/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /load media/i })).toBeNull()
    expect(retrieve).not.toHaveBeenCalled()

    view.rerender(<MediaViewer label="media for post #1" value="0x0102" />)
    expect(screen.getByText(/invalid media CID bytes/i)).toBeTruthy()
    expect(screen.getByText('0x0102')).toBeTruthy()
  })

  it('retrieves only after a click and revokes the temporary object URL', async () => {
    const urls = objectUrls()
    const retrieve = vi.fn(async () => image())
    render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for post #7"
        objectUrls={urls}
        retrieve={retrieve}
        value={CID.bytes}
      />,
    )

    expect(retrieve).not.toHaveBeenCalled()
    expect(screen.getByText(/No request is sent until you click/i)).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Load media for post #7' }),
    )

    const loaded = await screen.findByRole('img', {
      name: 'media for post #7',
    })
    expect(loaded.getAttribute('src')).toBe('blob:lifeinvader-media')
    expect(retrieve).toHaveBeenCalledWith(GATEWAY, CID, {
      signal: expect.any(AbortSignal),
    })
    expect(
      screen.getByText(/Retrieved and matched 4 B.*image\/png/i),
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Unload media for post #7' }),
    )
    expect(urls.revoke).toHaveBeenCalledWith('blob:lifeinvader-media')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('does not send DAG media to an unverifiable path gateway', () => {
    const retrieve = vi.fn()
    render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for post #8"
        retrieve={retrieve}
        value={DAG_CID.bytes}
      />,
    )
    expect(screen.getByText(/verifies raw blocks only/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /load media/i })).toBeNull()
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('renders supported moving media with explicit browser controls', async () => {
    const urls = objectUrls()
    const retrieve = vi.fn(async (): Promise<RetrievedMedia> => ({
      blob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], {
        type: 'video/webm',
      }),
      byteLength: 4,
      kind: 'video',
      mimeType: 'video/webm',
      verified: true,
    }))
    render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for comment #4"
        objectUrls={urls}
        retrieve={retrieve}
        value={CID.bytes}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Load media for comment #4' }),
    )
    const video = await screen.findByLabelText('media for comment #4')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('controls')).not.toBeNull()
    expect(video.getAttribute('preload')).toBe('metadata')
  })

  it('releases verified bytes that the browser cannot decode', async () => {
    const urls = objectUrls()
    render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for post #12"
        objectUrls={urls}
        retrieve={vi.fn(async () => image())}
        value={CID.bytes}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Load media for post #12' }),
    )
    fireEvent.error(await screen.findByRole('img'))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /browser could not decode/i,
    )
    expect(urls.revoke).toHaveBeenCalledWith('blob:lifeinvader-media')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('surfaces retrieval failures without replacing the CID commitment', async () => {
    const retrieve = vi.fn(async () => {
      throw new Error('Cannot retrieve media: the gateway returned HTTP 404.')
    })
    render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for post #2"
        retrieve={retrieve}
        value={CID.bytes}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Load media for post #2' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 404')
    expect(screen.getByText(CID.text)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Load media for post #2' }),
    ).toBeTruthy()
  })

  it('cancels and discards stale work when the selected gateway changes', async () => {
    const first = deferred<RetrievedMedia>()
    let signal: AbortSignal | undefined
    const retrieve = vi.fn(
      async (
        _gateway: string,
        _cid: typeof CID,
        options?: { signal?: AbortSignal },
      ) => {
        signal = options?.signal
        return first.promise
      },
    )
    const urls = objectUrls()
    const view = render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for post #3"
        objectUrls={urls}
        retrieve={retrieve}
        value={CID.bytes}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Load media for post #3' }),
    )
    expect(signal?.aborted).toBe(false)

    view.rerender(
      <MediaViewer
        gatewayTemplate="https://other.example/ipfs/{cid}"
        label="media for post #3"
        objectUrls={urls}
        retrieve={retrieve}
        value={CID.bytes}
      />,
    )
    expect(signal?.aborted).toBe(true)
    await act(async () => first.resolve(image()))
    expect(urls.create).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Load media for post #3' }),
    ).toBeTruthy()
  })

  it('releases a loaded object URL when removed from the page', async () => {
    const urls = objectUrls()
    const view = render(
      <MediaViewer
        gatewayTemplate={GATEWAY}
        label="media for post #9"
        objectUrls={urls}
        retrieve={vi.fn(async () => image())}
        value={CID.bytes}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Load media for post #9' }),
    )
    await screen.findByRole('img')
    view.unmount()
    expect(urls.revoke).toHaveBeenCalledWith('blob:lifeinvader-media')
  })
})
