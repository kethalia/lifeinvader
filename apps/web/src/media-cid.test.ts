import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import * as digest from 'multiformats/hashes/digest'
import { bytesToHex } from 'viem'
import { decodeMediaCid, parseMediaCid } from './media-cid'

const CID_V0 = 'QmYwAPJzv5CZsnAzt8auVZRnGiVQPcK1nK3X8KzZtXQf8C'
const CID_V1 = 'bafybeie5nqv6kd3qnfjuprw2scvucpip3olifqqi7xsthbiqdthpxj4t2e'

describe('media CIDs', () => {
  it('normalizes CIDv0 and whitespace to canonical CIDv1 bytes', () => {
    expect(parseMediaCid(`  ${CID_V0}\n`)).toMatchObject({
      codec: 'dag-pb',
      text: CID_V1,
    })
  })

  it('round-trips canonical binary CID data', () => {
    const parsed = parseMediaCid(CID_V1)
    expect(parsed).toBeDefined()
    expect(decodeMediaCid(parsed!.bytes)).toEqual(parsed)
  })

  it('treats an empty field as no media', () => {
    expect(parseMediaCid(' \n ')).toBeUndefined()
  })

  it('rejects malformed and oversized text before publication', () => {
    expect(() => parseMediaCid('not-a-cid')).toThrow(/invalid media CID/i)
    expect(() => parseMediaCid('b'.repeat(257))).toThrow(/too long/i)
  })

  it('rejects unsupported codecs', () => {
    const multihash = digest.create(0x12, new Uint8Array(32))
    const unsupported = CID.createV1(0x0122, multihash).toString()
    expect(() => parseMediaCid(unsupported)).toThrow(/only raw/i)
  })

  it('rejects non-SHA-256 multihashes', () => {
    const identity = digest.create(0x00, new Uint8Array([1, 2, 3]))
    const unsupported = CID.createV1(0x55, identity).toString()
    expect(() => parseMediaCid(unsupported)).toThrow(/SHA-256/i)
  })

  it('rejects malformed or oversized on-chain bytes', () => {
    expect(() => decodeMediaCid('0x01')).toThrow(/cannot be decoded/i)
    expect(() => decodeMediaCid(bytesToHex(new Uint8Array(129)))).toThrow(
      /out of bounds/i,
    )
  })
})
