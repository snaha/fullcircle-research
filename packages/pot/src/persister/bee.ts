import type { LoadSaver } from './persister.js'

export type FetchImpl = typeof fetch

export interface BeeLoadSaverOptions {
  beeUrl: string
  postageBatchId: string | Uint8Array
  fetch?: FetchImpl
}

// BeeLoadSaver persists POT nodes via a Bee node's /bytes API. Bee handles
// internal chunking for oversized payloads and returns the 32-byte root
// reference, matching the Go SwarmLoadSaver exactly.
export class BeeLoadSaver implements LoadSaver {
  private readonly beeUrl: string
  private readonly postageBatchId: string
  private readonly fetchImpl: FetchImpl

  constructor(options: BeeLoadSaverOptions) {
    this.beeUrl = options.beeUrl.replace(/\/+$/, '')
    const scheme = this.beeUrl.split(':', 1)[0]
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`invalid bee API URL: scheme must be http or https, got ${scheme}`)
    }
    this.postageBatchId = normaliseBatchId(options.postageBatchId)
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async load(reference: Uint8Array): Promise<Uint8Array> {
    if (reference.length !== 32) {
      throw new Error(`reference must be 32 bytes, got ${reference.length}`)
    }
    const res = await this.fetchImpl(`${this.beeUrl}/bytes/${toHex(reference)}`)
    if (!res.ok) {
      throw new Error(`bee /bytes GET returned status ${res.status}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  async save(data: Uint8Array): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.beeUrl}/bytes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'swarm-postage-batch-id': this.postageBatchId,
      },
      // Cast via unknown: `lib.dom.d.ts` BodyInit before TS 5.7 doesn't
      // recognise `Uint8Array<ArrayBufferLike>`, but node/undici accept it.
      body: data as unknown as ArrayBuffer,
    })
    if (res.status !== 201) {
      const text = await res.text().catch(() => '')
      throw new Error(`bee /bytes POST returned status ${res.status}: ${text}`)
    }
    const payload = (await res.json()) as { reference?: string }
    if (!payload.reference || payload.reference.length !== 64) {
      throw new Error(`bee /bytes POST returned invalid reference: ${payload.reference}`)
    }
    return fromHex(payload.reference)
  }
}

function normaliseBatchId(id: string | Uint8Array): string {
  if (typeof id === 'string') {
    const clean = id.toLowerCase().replace(/^0x/, '')
    if (clean.length !== 64 || !/^[0-9a-f]+$/.test(clean)) {
      throw new Error(`postage batch id must be 32 bytes hex, got ${clean.length} chars`)
    }
    return clean
  }
  if (id.length !== 32) {
    throw new Error(`postage batch id must be 32 bytes, got ${id.length}`)
  }
  return toHex(id)
}

function toHex(buf: Uint8Array): string {
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.toLowerCase().replace(/^0x/, '')
  if (clean.length % 2 !== 0) throw new Error('odd-length hex string')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}
