import { useEffect, useState } from 'react'
import type { Diagnostics } from '../lib/room'
import { checkNetwork, type NetVerdict } from '../lib/netcheck'

const NET_TEXT: Record<NetVerdict, string> = {
  checking: 'checking\u2026',
  ok: 'direct connection looks possible',
  strict: 'strict network (direct link unlikely - may need a relay)',
  none: 'no public address found (blocked, or browser hides it)',
  unsupported: 'WebRTC unavailable',
}

// Plain-language connection status. Contains no room code, key, or file data.
export function Diag({ get }: { get: () => Diagnostics | null }) {
  const [d, setD] = useState<Diagnostics | null>(null)
  const [net, setNet] = useState<NetVerdict>('checking')
  useEffect(() => { let on = true; checkNetwork().then(v => { if (on) setNet(v) }); return () => { on = false } }, [])
  useEffect(() => {
    const t = setInterval(() => setD(get()), 1000)
    return () => clearInterval(t)
  }, [get])
  if (!d) return null
  return (
    <p className="text-xs text-[--color-mut] mono">
      Relays reachable: {d.relaysOpen}/{d.relaysTotal} &middot; status: {d.stage}{d.error ? ` \u00b7 last error: ${d.error}` : ''} &middot; network: {NET_TEXT[net]}
    </p>
  )
}
