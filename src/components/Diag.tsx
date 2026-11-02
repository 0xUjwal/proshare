import { useEffect, useState } from 'react'
import type { Diagnostics } from '../lib/room'

// Plain-language connection status. Contains no room code, key, or file data.
export function Diag({ get }: { get: () => Diagnostics | null }) {
  const [d, setD] = useState<Diagnostics | null>(null)
  useEffect(() => {
    const t = setInterval(() => setD(get()), 1000)
    return () => clearInterval(t)
  }, [get])
  if (!d) return null
  return (
    <p className="text-xs text-[--color-mut] mono">
      Relays reachable: {d.relaysOpen}/{d.relaysTotal} &middot; status: {d.stage}{d.error ? ` \u00b7 last error: ${d.error}` : ''}
    </p>
  )
}
