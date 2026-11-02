const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += B62[b % 62]
  return out
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf =
    typeof data === 'string' ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function bytesToB64(b: Uint8Array | ArrayBuffer): string {
  const arr = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of arr) s += String.fromCharCode(x)
  return btoa(s)
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// --- Pair session keys -----------------------------------------------------
// The room code is NEVER used as an encryption key (a 6-digit code would be
// offline-brute-forceable). Instead each pair of peers runs an ephemeral
// ECDH exchange inside the handshake; the shared secret keys the handshake
// payloads and yields the human-compared verification code. A passive
// observer of the room learns connection metadata only; an active
// man-in-the-middle produces different verification codes on each side.

export interface SessionKeys {
  encKey: CryptoKey // AES-GCM for handshake payloads
  verifyCode: string // 6 digits, grouped 3-3
}

export async function generateKxPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
}

export async function exportPub(pair: CryptoKeyPair): Promise<string> {
  return bytesToB64(await crypto.subtle.exportKey('raw', pair.publicKey))
}

export async function deriveSessionKeys(priv: CryptoKey, remotePubB64: string, selfId: string, peerId: string): Promise<SessionKeys> {
  const remotePub = await crypto.subtle.importKey('raw', b64ToBytes(remotePubB64) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: remotePub } as EcdhKeyDeriveParams, priv, 256)
  const hkdfIn = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits'])
  // Bind the session to this exact pair of peer ids.
  const salt = new TextEncoder().encode(['proshare-session-v1', ...[selfId, peerId].sort()].join(':'))
  const material = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new Uint8Array(0) } as HkdfParams, hkdfIn, 512))
  const encKey = await crypto.subtle.importKey('raw', material.slice(0, 32) as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const v = material.slice(32, 40)
  const n = (((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0) % 1_000_000
  return { encKey, verifyCode: n.toString().padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2') }
}

export async function seal(encKey: CryptoKey, obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, encKey, new TextEncoder().encode(JSON.stringify(obj)))
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), 12)
  return bytesToB64(out)
}

export async function open(encKey: CryptoKey, b64: unknown): Promise<unknown> {
  if (typeof b64 !== 'string') throw new Error('bad handshake payload')
  const raw = b64ToBytes(b64)
  if (raw.length < 13) throw new Error('bad handshake payload')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource }, encKey, raw.slice(12) as BufferSource)
  return JSON.parse(new TextDecoder().decode(pt))
}
