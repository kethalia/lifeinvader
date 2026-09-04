import type { MediaCid } from './media-cid'

export const MAX_IPFS_GATEWAY_TEMPLATE_LENGTH = 2_048
const CID_PLACEHOLDER = '{cid}'
const TEMPLATE_PROBE_CID =
  'bafkreiexaqucef7aglg4zgvbw5mmu6tok2xyji3w37z7hqk665zfxzu6ze'
const SECOND_TEMPLATE_PROBE_CID =
  'bafkreibm6jg3ux5qu4i2g42gcgr3u6ahdwvizlktqd2a3w2vcrv3zmeqbi'

export type IpfsGatewayTemplate = {
  origin: string
  template: string
}

function gatewayError(reason: string, options?: ErrorOptions) {
  return new Error(`Cannot retrieve media: ${reason}`, options)
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  )
}

function placeholderCount(value: string) {
  let count = 0
  let cursor = 0
  while (true) {
    const index = value.indexOf(CID_PLACEHOLDER, cursor)
    if (index === -1) return count
    count += 1
    cursor = index + CID_PLACEHOLDER.length
  }
}

export function parseIpfsGatewayTemplate(value: string): IpfsGatewayTemplate {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw gatewayError('the gateway URL template contains control characters.')
  }
  const template = value.trim()
  if (template.length === 0) {
    throw gatewayError('enter an IPFS gateway URL template.')
  }
  if (template.length > MAX_IPFS_GATEWAY_TEMPLATE_LENGTH) {
    throw gatewayError('the gateway URL template is too long.')
  }
  if (placeholderCount(template) !== 1) {
    throw gatewayError('the gateway URL must contain {cid} exactly once.')
  }

  let probe: URL
  try {
    probe = new URL(template.replace(CID_PLACEHOLDER, TEMPLATE_PROBE_CID))
  } catch (cause) {
    throw gatewayError('the gateway URL template is invalid.', { cause })
  }
  if (
    probe.protocol !== 'https:' &&
    !(probe.protocol === 'http:' && isLoopbackHostname(probe.hostname))
  ) {
    throw gatewayError('use HTTPS, or HTTP only for localhost development.')
  }
  if (probe.username || probe.password) {
    throw gatewayError('gateway URLs cannot contain credentials.')
  }
  if (probe.hash) {
    throw gatewayError('gateway URLs cannot contain a fragment.')
  }
  const secondOrigin = new URL(
    template.replace(CID_PLACEHOLDER, SECOND_TEMPLATE_PROBE_CID),
  ).origin
  if (secondOrigin !== probe.origin) {
    throw gatewayError(
      'the {cid} placeholder must not change the gateway origin.',
    )
  }

  return { origin: probe.origin, template }
}

export function buildIpfsGatewayUrl(gatewayTemplate: string, cid: MediaCid) {
  const gateway = parseIpfsGatewayTemplate(gatewayTemplate)
  return new URL(
    gateway.template.replace(CID_PLACEHOLDER, encodeURIComponent(cid.text)),
  )
}
