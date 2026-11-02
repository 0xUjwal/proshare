import { useSyncExternalStore } from 'react'
import { Shell } from './components/Chrome'
import { Home } from './views/Home'
import { Host } from './views/Host'
import { Join } from './views/Join'

function useHash(): string {
  return useSyncExternalStore(
    cb => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb) },
    () => location.hash,
  )
}

export default function App() {
  const hash = useHash()
  const parts = hash.replace(/^#\//, '').split('/')

  let view
  if ((parts[0] === 'host' || parts[0] === 'join') && parts[1]) {
    const code = decodeURIComponent(parts[1])
    view = parts[0] === 'host' ? <Host key={hash} roomCode={code} /> : <Join key={hash} roomCode={code} />
  } else {
    view = <Home />
  }

  return <Shell>{view}</Shell>
}
