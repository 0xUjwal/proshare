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

// Short human-comparable verification code for a host<->joiner pair.
// Both sides compute it from values only the two ends of the encrypted
// channel know (room password + both peer ids), so comparing it out of
// band confirms you are talking to the person holding the link.
export async function pairCode(password: string, a: string, b: string): Promise<string> {
  const hex = await sha256Hex(`${password}:${[a, b].sort().join(':')}`)
  // 6 digits grouped 3-3, easy to read aloud
  const n = parseInt(hex.slice(0, 8), 16) % 1_000_000
  return n.toString().padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2')
}
