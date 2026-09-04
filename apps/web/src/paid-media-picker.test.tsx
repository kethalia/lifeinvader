import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CID } from 'multiformats/cid'
import { parseMediaCid } from './media-cid'
import { PaidMediaPicker, type PaidMediaPreparer } from './paid-media-picker'
import type { PreparedMediaCar } from './paid-media-car'

const MEDIA_CID = parseMediaCid(
  'bafkreiciqd2dbfh6pw7j4t2hgvbafrboumt5lmqiqixkj4jlhmjrmszugm',
)!

function preparedMedia(name = 'evidence.gif'): PreparedMediaCar {
  return {
    carBytes: new Uint8Array(273),
    file: { name, size: 176, type: 'image/gif' },
    mediaCid: MEDIA_CID,
    rootCid: CID.parse(MEDIA_CID.text),
  }
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next, fail) => {
    reject = fail
    resolve = next
  })
  return { promise, reject, resolve }
}

afterEach(cleanup)

describe('PaidMediaPicker', () => {
  it('restores a parent-held preparation after the picker remounts', () => {
    const prepared = preparedMedia('restored.gif')
    const onPrepared = vi.fn()
    render(
      <PaidMediaPicker
        initialPrepared={prepared}
        onPrepared={onPrepared}
        onPreparingChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('status').textContent).toMatch(
      /restored\.gif.*prepared locally/i,
    )
    expect(screen.getByText(MEDIA_CID.text)).toBeTruthy()
    expect(onPrepared).not.toHaveBeenCalled()
  })

  it('prepares a file, reports progress, and states the local-only boundary', async () => {
    const prepared = preparedMedia()
    const prepareMedia = vi.fn<PaidMediaPreparer>(async (file, options) => {
      options?.onProgress?.(file.size, file.size)
      return prepared
    })
    const onPrepared = vi.fn()
    const onPreparingChange = vi.fn()
    render(
      <PaidMediaPicker
        onPrepared={onPrepared}
        onPreparingChange={onPreparingChange}
        prepareMedia={prepareMedia}
      />,
    )

    expect(
      screen.getByText(/does not upload, pin, pay, or publish/i),
    ).toBeTruthy()
    const file = new File(['media'], 'evidence.gif', { type: 'image/gif' })
    fireEvent.change(screen.getByLabelText(/prepare a local image/i), {
      target: { files: [file] },
    })

    await waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(1))
    expect(prepareMedia.mock.calls[0]?.[0]).toBe(file)
    expect(prepareMedia.mock.calls[0]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    })
    expect(await screen.findByText(/is prepared locally/i)).toBeTruthy()
    expect(screen.getByText(MEDIA_CID.text)).toBeTruthy()
    expect(screen.getByText(/CAR exists only in this tab/i)).toBeTruthy()
    expect(onPrepared.mock.calls).toEqual([[undefined], [prepared]])
    expect(onPreparingChange.mock.calls).toEqual([[true], [false]])
  })

  it('cancels an in-flight preparation and clears its draft value', async () => {
    let preparationSignal: AbortSignal | undefined
    const prepareMedia = vi.fn<PaidMediaPreparer>((_file, options) => {
      preparationSignal = options?.signal
      return new Promise((_resolve, reject) => {
        preparationSignal?.addEventListener(
          'abort',
          () => reject(preparationSignal?.reason),
          { once: true },
        )
      })
    })
    const onPrepared = vi.fn()
    const onPreparingChange = vi.fn()
    render(
      <PaidMediaPicker
        onPrepared={onPrepared}
        onPreparingChange={onPreparingChange}
        prepareMedia={prepareMedia}
      />,
    )

    fireEvent.change(screen.getByLabelText(/prepare a local image/i), {
      target: { files: [new File(['media'], 'waiting.mp4')] },
    })
    expect((await screen.findByRole('status')).textContent).toMatch(
      /preparing waiting\.mp4/i,
    )
    fireEvent.click(screen.getByRole('button', { name: /cancel preparation/i }))

    expect(preparationSignal?.aborted).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
    expect(onPrepared.mock.calls).toEqual([[undefined], [undefined]])
    expect(onPreparingChange.mock.calls).toEqual([[true], [false]])
  })

  it('ignores a stale completion after a newer file is selected', async () => {
    const first = deferred<PreparedMediaCar>()
    const second = deferred<PreparedMediaCar>()
    const firstPrepared = preparedMedia('first.gif')
    const secondPrepared = preparedMedia('second.gif')
    const signals: AbortSignal[] = []
    const prepareMedia = vi.fn<PaidMediaPreparer>((_file, options) => {
      if (options?.signal) signals.push(options.signal)
      return signals.length === 1 ? first.promise : second.promise
    })
    const onPrepared = vi.fn()
    render(
      <PaidMediaPicker
        onPrepared={onPrepared}
        onPreparingChange={vi.fn()}
        prepareMedia={prepareMedia}
      />,
    )
    const input = screen.getByLabelText(/prepare a local image/i)

    fireEvent.change(input, {
      target: { files: [new File(['first'], 'first.gif')] },
    })
    fireEvent.change(input, {
      target: { files: [new File(['second'], 'second.gif')] },
    })
    expect(signals[0]?.aborted).toBe(true)

    await act(async () => second.resolve(secondPrepared))
    expect((await screen.findByRole('status')).textContent).toMatch(
      /second\.gif.*prepared locally/i,
    )
    await act(async () => first.resolve(firstPrepared))
    expect(screen.getByRole('status').textContent).not.toMatch(
      /first\.gif.*prepared locally/i,
    )
    expect(onPrepared.mock.calls).toEqual([
      [undefined],
      [undefined],
      [secondPrepared],
    ])
  })

  it('surfaces preparation failures and lets the user clear them', async () => {
    const prepareMedia = vi.fn<PaidMediaPreparer>(async () => {
      throw new Error('Cannot prepare media: unsupported bytes.')
    })
    render(
      <PaidMediaPicker
        onPrepared={vi.fn()}
        onPreparingChange={vi.fn()}
        prepareMedia={prepareMedia}
      />,
    )

    fireEvent.change(screen.getByLabelText(/prepare a local image/i), {
      target: { files: [new File(['bad'], 'bad.gif')] },
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /unsupported bytes/i,
    )
    fireEvent.click(screen.getByRole('button', { name: /clear media error/i }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('aborts and releases an in-flight preparation when it unmounts', async () => {
    let preparationSignal: AbortSignal | undefined
    const prepareMedia = vi.fn<PaidMediaPreparer>((_file, options) => {
      preparationSignal = options?.signal
      return new Promise(() => undefined)
    })
    const onPreparingChange = vi.fn()
    const { unmount } = render(
      <PaidMediaPicker
        onPrepared={vi.fn()}
        onPreparingChange={onPreparingChange}
        prepareMedia={prepareMedia}
      />,
    )

    fireEvent.change(screen.getByLabelText(/prepare a local image/i), {
      target: { files: [new File(['media'], 'leaving.mp4')] },
    })
    await waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(1))
    unmount()

    expect(preparationSignal?.aborted).toBe(true)
    expect(onPreparingChange.mock.calls).toEqual([[true], [false]])
  })
})
