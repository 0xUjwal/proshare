// Content transfer protocol, isolated from the rendezvous layer for testing.
//
// Every payload is AES-GCM sealed under the pair's ECDH session key with:
//  - direction-separated keys (sender uses sendKey, receiver opens with recvKey)
//  - strictly increasing per-direction sequence numbers (order + replay binding)
//  - all transfer metadata inside the authenticated envelope
//  - fresh random 96-bit nonces per message
// Composition is standard primitives but unreviewed - see README.

import { open, openRaw, seal, sealRaw, type SessionKeys } from './crypto'
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, sanitizeFilename } from './files'

export const CHUNK_BYTES = 256 * 1024
// Chunks travel as base64(iv || ciphertext): 4/3 raw size plus GCM tag.
export const MAX_WIRE_BYTES = Math.ceil((CHUNK_BYTES + 28) / 3) * 4 + 64

export interface FileMeta {
  [key: string]: string | number
  id: string
  name: string
  size: number
  type: string
  sha256: string
}

export type WireMeta = { id: string; k: 'm' } | { id: string; k: 'c'; i: number }

export class ContentSender {
  private sendSeq = 0
  private keys: SessionKeys
  constructor(keys: SessionKeys) { this.keys = keys }

  async sealFileMeta(meta: FileMeta, n: number): Promise<{ data: string; wire: WireMeta }> {
    const data = await seal(this.keys.sendKey, { s: ++this.sendSeq, t: 'meta', id: meta.id, name: meta.name, size: meta.size, type: meta.type, sha256: meta.sha256, n })
    return { data, wire: { id: meta.id, k: 'm' } }
  }

  async sealChunk(id: string, i: number, chunk: Uint8Array): Promise<{ data: string; wire: WireMeta }> {
    const seq = this.sendSeq + 1
    const ad = new TextEncoder().encode(JSON.stringify({ s: seq, id, i }))
    const data = await sealRaw(this.keys.sendKey, chunk, ad)
    this.sendSeq = seq
    return { data, wire: { id, k: 'c', i } }
  }

  async sealText(id: string, text: string, ts: number): Promise<string> {
    return seal(this.keys.sendKey, { s: ++this.sendSeq, t: 'text', id, text, ts })
  }

  get seq(): number { return this.sendSeq }
}

export type ReceiveEvent =
  | { type: 'start'; meta: FileMeta; total: number }
  | { type: 'progress'; id: string; progress: number }
  | { type: 'file'; meta: FileMeta; data: ArrayBuffer }
  | { type: 'text'; id: string; text: string; ts: number }
  | { type: 'drop' }

interface Reassembling { meta: FileMeta; chunks: (Uint8Array | undefined)[]; got: number; total: number }

export class ContentReceiver {
  private recvSeq = 0
  private incoming = new Map<string, Reassembling>()
  private keys: SessionKeys
  constructor(keys: SessionKeys) { this.keys = keys }

  // One entry point for every sealed payload. Anything unauthentic,
  // out of sequence, replayed or malformed is dropped.
  async acceptFileMessage(data: unknown, wm: Partial<WireMeta>): Promise<ReceiveEvent[]> {
    if (typeof data !== 'string' || !wm || typeof wm.id !== 'string' || (wm.k !== 'm' && wm.k !== 'c')) return [{ type: 'drop' }]
    try {
      if (wm.k === 'm') {
        const env = (await open(this.keys.recvKey, data)) as Record<string, unknown>
        if (env.s !== this.recvSeq + 1 || env.t !== 'meta' || env.id !== wm.id) return [{ type: 'drop' }]
        this.recvSeq = env.s as number
        if (typeof env.size !== 'number' || env.size < 0 || env.size > MAX_FILE_BYTES) return [{ type: 'drop' }]
        if (typeof env.sha256 !== 'string' || typeof env.n !== 'number' || env.n < 1 || env.n > Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)) return [{ type: 'drop' }]
        const meta: FileMeta = {
          id: String(env.id).slice(0, 40),
          name: sanitizeFilename(env.name),
          size: env.size,
          type: typeof env.type === 'string' ? (env.type as string).slice(0, 120) : 'application/octet-stream',
          sha256: env.sha256,
        }
        this.incoming.set(meta.id, { meta, chunks: new Array(env.n as number), got: 0, total: env.n as number })
        return [{ type: 'start', meta, total: env.n as number }]
      }
      const i = (wm as { i?: number }).i
      if (typeof i !== 'number' || i < 0) return [{ type: 'drop' }]
      const rec = this.incoming.get(wm.id)
      if (!rec || i >= rec.total) return [{ type: 'drop' }]
      const ad = new TextEncoder().encode(JSON.stringify({ s: this.recvSeq + 1, id: wm.id, i }))
      const chunk = await openRaw(this.keys.recvKey, data, ad)
      this.recvSeq++
      rec.chunks[i] = chunk
      rec.got++
      const events: ReceiveEvent[] = [{ type: 'progress', id: rec.meta.id, progress: rec.got / rec.total }]
      if (rec.got === rec.total) {
        this.incoming.delete(rec.meta.id)
        events.push({ type: 'file', meta: rec.meta, data: concatChunks(rec.chunks as Uint8Array[]) })
      }
      return events
    } catch {
      return [{ type: 'drop' }]
    }
  }

  async acceptText(data: unknown): Promise<ReceiveEvent[]> {
    if (typeof data !== 'string') return [{ type: 'drop' }]
    try {
      const m = (await open(this.keys.recvKey, data)) as Record<string, unknown>
      if (m.s !== this.recvSeq + 1 || m.t !== 'text') return [{ type: 'drop' }]
      this.recvSeq = m.s as number
      if (typeof m.text !== 'string' || !m.text || m.text.length > MAX_TEXT_CHARS) return [{ type: 'drop' }]
      return [{ type: 'text', id: String(m.id ?? ''), text: m.text, ts: typeof m.ts === 'number' ? m.ts : Date.now() }]
    } catch {
      return [{ type: 'drop' }]
    }
  }

  get seq(): number { return this.recvSeq }
}

export function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out.buffer
}

export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_BYTES))
}
