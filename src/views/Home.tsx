import { useCallback, useState } from 'react'
import { Card } from '../components/Chrome'
import { PrivacyPanel } from '../components/PrivacyPanel'
import { autoCode, isValidCode, normalizeCode, weakCodeWarning } from '../lib/codes'

export function Home() {
  const [sendCode, setSendCode] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const startAuto = useCallback(() => {
    location.hash = `#/host/${autoCode()}`
  }, [])

  const startCustom = useCallback(() => {
    const code = normalizeCode(sendCode)
    if (!isValidCode(code)) { setErr('Use 4-32 characters: letters, numbers, spaces or dashes (or 6 digits).'); return }
    location.hash = `#/host/${encodeURIComponent(code)}`
  }, [sendCode])

  const join = useCallback(() => {
    const code = normalizeCode(joinCode)
    if (!isValidCode(code)) { setErr('That does not look like a room code. Check it with the sender.'); return }
    location.hash = `#/join/${encodeURIComponent(code)}`
  }, [joinCode])

  const customWarning = weakCodeWarning(normalizeCode(sendCode))

  return (
    <div className="fade-up flex flex-col gap-6">
      <section className="text-center mt-4 sm:mt-8 flex flex-col items-center gap-4">
        <span className="pill pill-ok">end-to-end encrypted &middot; peer to peer</span>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight max-w-2xl">
          Send files to someone.<br /><span className="text-[--color-brand2]">Not to a server.</span>
        </h1>
        <p className="text-[--color-mut] max-w-xl leading-relaxed">
          One of you opens a room and shares its code. The other enters the code, the sender approves,
          and files travel straight between your devices over an encrypted channel.
        </p>
      </section>

      <section className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto w-full">
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">Send</h2>
          <p className="text-sm text-[--color-mut]">Open a room. You approve everyone who asks to join.</p>
          <button className="btn btn-primary w-full" onClick={startAuto}>Create a room</button>
          <div className="flex items-center gap-2 text-xs text-[--color-mut]"><span className="h-px flex-1 bg-[--color-line]" />or pick your own code<span className="h-px flex-1 bg-[--color-line]" /></div>
          <input className="field" placeholder="e.g. family-photos-7" value={sendCode} maxLength={32}
            onChange={e => { setSendCode(e.target.value); setErr(null) }}
            onKeyDown={e => { if (e.key === 'Enter') startCustom() }} />
          {customWarning && <p className="text-xs text-[--color-warn]">{customWarning}</p>}
          <button className="btn btn-ghost w-full" onClick={startCustom} disabled={!sendCode.trim()}>Use this code</button>
        </Card>

        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">Receive</h2>
          <p className="text-sm text-[--color-mut]">Enter the code the sender gave you (for example 482 916).</p>
          <input className="field text-center text-lg tracking-widest" placeholder="Room code" value={joinCode} maxLength={32}
            onChange={e => { setJoinCode(e.target.value); setErr(null) }}
            onKeyDown={e => { if (e.key === 'Enter') join() }} />
          <button className="btn btn-primary w-full" onClick={join} disabled={!joinCode.trim()}>Connect</button>
          <p className="text-xs text-[--color-mut]">Both devices stay online until the transfer finishes. The sender approves you before anything is shared.</p>
        </Card>
      </section>

      {err && <p className="text-sm text-[--color-bad] text-center">{err}</p>}

      <section className="grid sm:grid-cols-3 gap-3 mt-2">
        <Card>
          <div className="text-2xl mb-2">&#128272;</div>
          <h3 className="font-semibold mb-1">Only who you approve</h3>
          <p className="text-sm text-[--color-mut]">Anyone who knows a live code can ask to join - the sender approves each person explicitly. No approval, no transfer.</p>
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
