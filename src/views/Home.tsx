import { useCallback } from 'react'
import { randomToken } from '../lib/crypto'
import { Card } from '../components/Chrome'
import { PrivacyPanel } from '../components/PrivacyPanel'

export function Home() {
  const start = useCallback(() => {
    // 256-bit room id + 256-bit password, carried only in the URL fragment.
    const roomId = randomToken(43)
    const password = randomToken(43)
    location.hash = `#/host/${roomId}/${password}`
  }, [])

  return (
    <div className="fade-up flex flex-col gap-6">
      <section className="text-center mt-4 sm:mt-10 flex flex-col items-center gap-4">
        <span className="pill pill-ok">end-to-end encrypted &middot; peer to peer</span>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight max-w-2xl">
          Send files to someone.<br /><span className="text-[--color-brand2]">Not to a server.</span>
        </h1>
        <p className="text-[--color-mut] max-w-xl leading-relaxed">
          ProShare connects two browsers directly. Files and text go straight from your device to theirs,
          encrypted - never uploaded, never stored, never scanned. You approve exactly who gets in.
        </p>
        <button className="btn btn-primary text-lg mt-2 px-8 py-4" onClick={start}>Start a private room</button>
        <p className="text-xs text-[--color-mut]">Free &middot; no account &middot; works on modern phones and computers</p>
      </section>

      <section className="grid sm:grid-cols-3 gap-3 mt-2">
        <Card>
          <div className="text-2xl mb-2">&#128272;</div>
          <h3 className="font-semibold mb-1">Only who you approve</h3>
          <p className="text-sm text-[--color-mut]">Long random links plus explicit approval for every person who joins. No knock, no entry.</p>
        </Card>
        <Card>
          <div className="text-2xl mb-2">&#9889;</div>
          <h3 className="font-semibold mb-1">Direct and fast</h3>
          <p className="text-sm text-[--color-mut]">Browser to browser over WebRTC. No upload-then-download detour, no size tiers, no throttling.</p>
        </Card>
        <Card>
          <div className="text-2xl mb-2">&#128065;</div>
          <h3 className="font-semibold mb-1">Nothing watching</h3>
          <p className="text-sm text-[--color-mut]">No analytics, cookies, or third-party scripts. Messages are shown as plain text, never as code.</p>
        </Card>
      </section>

      <PrivacyPanel />
    </div>
  )
}
