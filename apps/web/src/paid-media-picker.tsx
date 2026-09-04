import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import type {
  PaidMediaPreparationOptions,
  PreparedMediaCar,
} from './paid-media-car'

export type PaidMediaPreparer = (
  file: File,
  options?: PaidMediaPreparationOptions,
) => Promise<PreparedMediaCar>

type PreparationState =
  | { kind: 'idle' }
  | { fileName: string; kind: 'preparing'; percentage: number }
  | { kind: 'ready'; prepared: PreparedMediaCar }
  | { kind: 'error'; message: string }

const prepareMediaInBrowser: PaidMediaPreparer = async (file, options) => {
  const { preparePaidMediaCar } = await import('./paid-media-car')
  return preparePaidMediaCar(file, options)
}

function formatByteLength(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function describePreparationError(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The selected media could not be prepared.'
}

export function PaidMediaPicker({
  disabled = false,
  initialPrepared,
  onPrepared,
  onPreparingChange,
  prepareMedia = prepareMediaInBrowser,
}: {
  disabled?: boolean
  initialPrepared?: PreparedMediaCar
  onPrepared(prepared: PreparedMediaCar | undefined): void
  onPreparingChange(preparing: boolean): void
  prepareMedia?: PaidMediaPreparer
}) {
  const inputId = useId()
  const helpId = `${inputId}-help`
  const inputRef = useRef<HTMLInputElement>(null)
  const activeController = useRef<AbortController | undefined>(undefined)
  const onPreparingChangeRef = useRef(onPreparingChange)
  const operationSequence = useRef(0)
  const [state, setState] = useState<PreparationState>(() =>
    initialPrepared
      ? { kind: 'ready', prepared: initialPrepared }
      : { kind: 'idle' },
  )

  useEffect(() => {
    onPreparingChangeRef.current = onPreparingChange
  }, [onPreparingChange])

  useEffect(() => {
    return () => {
      const wasPreparing = activeController.current !== undefined
      operationSequence.current += 1
      activeController.current?.abort(
        new DOMException('Media preparation was reset.', 'AbortError'),
      )
      activeController.current = undefined
      if (wasPreparing) onPreparingChangeRef.current(false)
    }
  }, [])

  const reset = () => {
    operationSequence.current += 1
    activeController.current?.abort(
      new DOMException('Media preparation was cancelled.', 'AbortError'),
    )
    activeController.current = undefined
    if (inputRef.current) inputRef.current.value = ''
    setState({ kind: 'idle' })
    onPreparingChange(false)
    onPrepared(undefined)
  }

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    const operationId = ++operationSequence.current
    activeController.current?.abort(
      new DOMException('A newer media file was selected.', 'AbortError'),
    )
    onPrepared(undefined)

    if (!file) {
      activeController.current = undefined
      setState({ kind: 'idle' })
      onPreparingChange(false)
      return
    }

    const controller = new AbortController()
    activeController.current = controller
    setState({ fileName: file.name, kind: 'preparing', percentage: 0 })
    onPreparingChange(true)

    void (async () => {
      try {
        const prepared = await prepareMedia(file, {
          signal: controller.signal,
          onProgress(processedBytes, totalBytes) {
            if (
              operationId !== operationSequence.current ||
              controller.signal.aborted
            )
              return
            const percentage = Math.min(
              100,
              Math.floor((processedBytes / totalBytes) * 100),
            )
            setState((current) =>
              current.kind === 'preparing' && current.percentage !== percentage
                ? { ...current, percentage }
                : current,
            )
          },
        })
        if (
          operationId !== operationSequence.current ||
          controller.signal.aborted
        )
          return
        setState({ kind: 'ready', prepared })
        onPrepared(prepared)
      } catch (error) {
        if (
          operationId !== operationSequence.current ||
          controller.signal.aborted
        )
          return
        setState({ kind: 'error', message: describePreparationError(error) })
      } finally {
        if (operationId === operationSequence.current) {
          activeController.current = undefined
          onPreparingChange(false)
        }
      }
    })()
  }

  return (
    <div className="paid-media-picker">
      <label htmlFor={inputId}>Prepare a local image, GIF, or video</label>
      <input
        accept="image/*,video/*"
        aria-describedby={helpId}
        disabled={disabled}
        id={inputId}
        onChange={handleFile}
        ref={inputRef}
        type="file"
      />
      <p className="input-help" id={helpId}>
        Preparation happens in this tab. It creates an IPFS CID and CAR but does
        not upload, pin, pay, or publish anything.
      </p>

      {state.kind === 'preparing' ? (
        <div className="media-preparation-status" role="status">
          <p>
            Preparing <strong>{state.fileName}</strong>… {state.percentage}%
          </p>
          <progress max={100} value={state.percentage}>
            {state.percentage}%
          </progress>
          <button type="button" onClick={reset}>
            Cancel preparation
          </button>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div className="media-preparation-ready" role="status">
          <p>
            <strong>{state.prepared.file.name}</strong> is prepared locally.
          </p>
          <dl>
            <div>
              <dt>IPFS root</dt>
              <dd>
                <code>{state.prepared.mediaCid.text}</code>
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{formatByteLength(state.prepared.file.size)}</dd>
            </div>
            <div>
              <dt>CAR</dt>
              <dd>{formatByteLength(state.prepared.carBytes.byteLength)}</dd>
            </div>
          </dl>
          <p>
            The CID is now in this post draft, but its CAR exists only in this
            tab. Publishing the post does not make the media available.
          </p>
          <button disabled={disabled} type="button" onClick={reset}>
            Remove prepared media
          </button>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className="media-preparation-error" role="alert">
          <p>{state.message}</p>
          <button disabled={disabled} type="button" onClick={reset}>
            Clear media error
          </button>
        </div>
      ) : null}
    </div>
  )
}
