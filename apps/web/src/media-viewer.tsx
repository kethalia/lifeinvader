import { useEffect, useMemo, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { decodeMediaCid } from './media-cid'
import type { MediaRetriever, RetrievedMedia } from './media-retrieval'

type MediaViewerState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { message: string; phase: 'failed' }
  | {
      byteLength: number
      kind: RetrievedMedia['kind']
      mimeType: string
      objectUrl: string
      phase: 'ready'
    }

export type MediaObjectUrls = {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

const browserObjectUrls: MediaObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

const retrieveInBrowser: MediaRetriever = async (...parameters) => {
  try {
    const { retrieveIpfsMedia } = await import('./media-retrieval')
    return await retrieveIpfsMedia(...parameters)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Cannot retrieve media:')
    ) {
      throw error
    }
    throw new Error(
      'Cannot retrieve media: the retrieval code failed to load.',
      {
        cause: error instanceof Error ? error : undefined,
      },
    )
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value.toString()} B`
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / 1024).toFixed(1)} KiB`
}

export function MediaViewer({
  gatewayTemplate,
  label,
  objectUrls = browserObjectUrls,
  retrieve = retrieveInBrowser,
  value,
}: {
  gatewayTemplate?: string
  label: string
  objectUrls?: MediaObjectUrls
  retrieve?: MediaRetriever
  value: Hex
}) {
  const decoded = useMemo(() => {
    try {
      return { cid: decodeMediaCid(value), valid: true } as const
    } catch {
      return { valid: false } as const
    }
  }, [value])
  const [state, setState] = useState<MediaViewerState>({ phase: 'idle' })
  const activeRequest = useRef<AbortController | undefined>(undefined)
  const currentObjectUrl = useRef<string | undefined>(undefined)
  const sequence = useRef(0)

  const releaseObjectUrl = () => {
    if (!currentObjectUrl.current) return
    objectUrls.revoke(currentObjectUrl.current)
    currentObjectUrl.current = undefined
  }

  useEffect(() => {
    sequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = undefined
    releaseObjectUrl()
    setState({ phase: 'idle' })
    return () => {
      sequence.current += 1
      activeRequest.current?.abort()
      activeRequest.current = undefined
      releaseObjectUrl()
    }
  }, [gatewayTemplate, objectUrls, value])

  if (!decoded.valid) {
    return (
      <div className="post-media-commitment invalid-media-commitment">
        <span>Invalid media CID bytes committed on-chain.</span>
        <code>{value}</code>
      </div>
    )
  }

  const load = async () => {
    if (!gatewayTemplate || state.phase === 'loading') return
    const requestId = ++sequence.current
    activeRequest.current?.abort()
    releaseObjectUrl()
    const controller = new AbortController()
    activeRequest.current = controller
    setState({ phase: 'loading' })
    try {
      const result = await retrieve(gatewayTemplate, decoded.cid, {
        signal: controller.signal,
      })
      if (sequence.current !== requestId || controller.signal.aborted) return
      const objectUrl = objectUrls.create(result.blob)
      currentObjectUrl.current = objectUrl
      setState({
        byteLength: result.byteLength,
        kind: result.kind,
        mimeType: result.mimeType,
        objectUrl,
        phase: 'ready',
      })
    } catch (error) {
      if (sequence.current !== requestId || controller.signal.aborted) return
      setState({
        message:
          error instanceof Error &&
          error.message.startsWith('Cannot retrieve media:')
            ? error.message
            : 'Cannot retrieve media: the request failed.',
        phase: 'failed',
      })
    } finally {
      if (sequence.current === requestId) activeRequest.current = undefined
    }
  }

  const unload = () => {
    sequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = undefined
    releaseObjectUrl()
    setState({ phase: 'idle' })
  }

  const rejectUndecodableMedia = () => {
    releaseObjectUrl()
    setState({
      message:
        'Cannot retrieve media: the browser could not decode the verified bytes.',
      phase: 'failed',
    })
  }

  return (
    <div className="post-media-commitment">
      <span>IPFS media commitment · {decoded.cid.codec}</span>
      <code>{decoded.cid.text}</code>
      <span>Address only; availability is not guaranteed.</span>
      {decoded.cid.codec !== 'raw' ? (
        <span>
          Not fetched: this first renderer verifies raw blocks only. DAG-based
          media needs trustless block traversal before it can be displayed.
        </span>
      ) : !gatewayTemplate ? (
        <span>Configure an opt-in gateway above to retrieve this media.</span>
      ) : state.phase === 'ready' ? (
        <div className="retrieved-media">
          {state.kind === 'image' ? (
            <img
              alt={label}
              onError={rejectUndecodableMedia}
              src={state.objectUrl}
            />
          ) : (
            <video
              aria-label={label}
              controls
              onError={rejectUndecodableMedia}
              preload="metadata"
              src={state.objectUrl}
            />
          )}
          <p>
            Retrieved and matched {formatBytes(state.byteLength)} to the
            on-chain raw CID as {state.mimeType}. This tab holds a temporary
            local copy; the gateway and storage remain independent.
          </p>
          <button onClick={unload} type="button">
            Unload {label}
          </button>
        </div>
      ) : (
        <div className="media-load-action">
          <button
            onClick={state.phase === 'loading' ? unload : load}
            type="button"
          >
            {state.phase === 'loading'
              ? `Cancel loading ${label}`
              : `Load ${label}`}
          </button>
          {state.phase === 'failed' ? (
            <span className="error-message" role="alert">
              {state.message}
            </span>
          ) : (
            <span>
              No request is sent until you click. The selected gateway will
              learn your IP address, this CID, and the page origin.
            </span>
          )}
        </div>
      )}
    </div>
  )
}
