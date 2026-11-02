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
  if ((parts[0] === 'host' || parts[0] === 'join') && parts[1] && parts[2]) {
    const props = { roomId: parts[1], password: parts[2] }
    view = parts[0] === 'host' ? <Host key={hash} {...props} /> : <Join key={hash} {...props} />
  } else if (parts[0] === 'join' || parts[0] === 'host') {
    view = (
      <div className="fade-up flex flex-col items-center justify-center flex-1 text-center gap-4">
        <div className="text-5xl">&#128683;</div>
        <h2 className="text-2xl font-bold">That link is incomplete</h2>
        <p className="text-[--color-mut] max-w-sm">ProShare links carry a long secret after the #. If part of it got cut off, ask for the full link again.</p>
        <a className="btn btn-ghost" href="#/">Back home</a>
      </div>
    )
  } else {
    view = <Home />
  }

  return <Shell>{view}</Shell>
}
