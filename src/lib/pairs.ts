// Paired devices. A pairing is a random 256-bit secret both devices keep in
// this browser's localStorage. The secret never leaves the two devices except
// inside the sealed, code-verified channel that created the pairing. The relay
// room name and the handshake authentication both derive from it, so only the
// two paired browsers can meet there. Forget a pairing on either side to end it.
import { sha256Hex } from './crypto'

export interface Pair { id: string; name: string; secret: string; createdAt: number }
const KEY = 'proshare.pairs.v1'
const NAME_KEY = 'proshare.device-name.v1'

export function listPairs(): Pair[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function write(p: Pair[]) { try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* private mode */ } }
export function savePair(name: string, secret: string): Pair {
  const pair: Pair = { id: crypto.randomUUID(), name: name.slice(0, 40) || 'Device', secret, createdAt: Date.now() }
  write([...listPairs().filter(p => p.secret !== secret), pair])
  return pair
}
export function forgetPair(id: string) { write(listPairs().filter(p => p.id !== id)) }
export function newSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}
export async function pairRoomName(secret: string): Promise<string> {
  return 'pair-' + (await sha256Hex(new TextEncoder().encode('proshare-pair-room-v1|' + secret))).slice(0, 40)
}

const ADJ = ['Calm', 'Brave', 'Swift', 'Bright', 'Quiet', 'Lucky', 'Sunny', 'Witty', 'Cosy', 'Bold']
const ANI = ['Fox', 'Otter', 'Panda', 'Heron', 'Lynx', 'Koala', 'Falcon', 'Gecko', 'Whale', 'Robin']
export function deviceName(): string {
  try {
    let n = localStorage.getItem(NAME_KEY)
    if (!n) {
      const r = crypto.getRandomValues(new Uint8Array(2))
      n = `${ADJ[r[0] % ADJ.length]} ${ANI[r[1] % ANI.length]}`
      localStorage.setItem(NAME_KEY, n)
    }
    return n
  } catch { return 'This device' }
}
export function setDeviceName(n: string) { try { localStorage.setItem(NAME_KEY, n.trim().slice(0, 40) || deviceName()) } catch { /* ignore */ } }

// Same-Wi-Fi discovery: devices behind one router share a public IPv4, so they
// share a room named from its hash. Only the hash reaches the relays; the IP
// lookup itself is one request to a public service (ipify). Nearby peers are
// untrusted until both people confirm the code, exactly like a manual room.
export async function nearbyRoomName(): Promise<string | null> {
  for (const url of ['https://api.ipify.org?format=json', 'https://ipv4.icanhazip.com']) {
    try {
      const r = await fetch(url, { cache: 'no-store' })
      if (!r.ok) continue
      const t = (await r.text()).trim()
      const ip = t.startsWith('{') ? (JSON.parse(t) as { ip?: string }).ip : t
      if (ip && /^[0-9.]{7,15}$/.test(ip)) return 'near-' + (await sha256Hex(new TextEncoder().encode('proshare-nearby-v1|' + ip))).slice(0, 40)
    } catch { /* try next */ }
  }
  return null
}
