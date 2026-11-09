import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProShareRoom, loadIceServers, peerMutual, turnConfigured, type ChatMsg, type FileMeta, type IncomingFile, type PeerInfo } from '../lib/room'
import { deviceName, forgetPair, listPairs, nearbyRoomName, pairRoomName, setDeviceName, type Pair } from '../lib/pairs'
import { randomToken, sha256Hex } from '../lib/crypto'
import { MAX_FILE_BYTES, MAX_FILES, MAX_TEXT_CHARS, formatBytes, saveBlob } from '../lib/files'
import { Card } from '../components/Chrome'
import { CopyButton } from '../components/CopyButton'
import { ProgressBar } from '../components/ProgressBar'

interface Entry { key: string; room: ProShareRoom; peer: PeerInfo; via: 'nearby' | 'paired'; label: string }
interface Outgoing { id: string; name: string; to: string; progress: number; status: 'sending' | 'done' | 'failed'; error?: string }
interface Got { id: string; from: string; text: string; ts: number }

export function Devices() {
  const [name, setName] = useState(deviceName())
  const [pairs, setPairs] = useState<Pair[]>(listPairs())
  const [peersByRoom, setPeersByRoom] = useState<Record<string, PeerInfo[]>>({})
  const [nearbyState, setNearbyState] = useState<'looking' | 'on' | 'unavailable'>('looking')
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<IncomingFile[]>([])
  const [texts, setTexts] = useState<ChatMsg[]>([])
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [sent, setSent] = useState<Got[]>([])
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const rooms = useRef<Record<string, { room: ProShareRoom; via: 'nearby' | 'paired'; label: string }>>({})
  const fileInput = useRef<HTMLInputElement>(null)

  // Open the nearby room and one room per paired device. Rooms stay open while this page is open.
  useEffect(() => {
    let dead = false
    const mine = rooms.current
    const open = (key: string, via: 'nearby' | 'paired', label: string, make: () => ProShareRoom) => {
      if (mine[key]) return
      mine[key] = { room: make(), via, label }
    }
    ;(async () => {
      const ice = await loadIceServers()
      if (dead) return
      const mkEvents = (key: string) => ({
        onPending: () => {},
        onPeers: (p: PeerInfo[]) => setPeersByRoom(s => ({ ...s, [key]: p })),
        onFileStart: (f: IncomingFile) => setFiles(fs => [...fs.filter(x => x.meta.id !== f.meta.id), f]),
        onFileProgress: (id: string, progress: number) => setFiles(fs => fs.map(x => x.meta.id === id ? { ...x, progress } : x)),
        onFileDone: (f: IncomingFile) => setFiles(fs => fs.map(x => x.meta.id === f.meta.id ? f : x)),
        onText: (m: ChatMsg) => setTexts(c => [...c.slice(-99), m]),
        onError: setNotice,
        onJoinError: () => {},
        onLeft: () => {},
      })
      for (const p of listPairs()) {
        const rn = await pairRoomName(p.secret)
        if (dead) return
        open(rn, 'paired', p.name, () => ProShareRoom.paired(rn, p.secret, mkEvents(rn), deviceName(), ice))
      }
      const near = await nearbyRoomName()
      if (dead) return
      if (near) { open(near, 'nearby', 'Nearby', () => ProShareRoom.nearby(near, mkEvents(near), deviceName(), ice)); setNearbyState('on') }
      else setNearbyState('unavailable')
    })()
    const bye = () => { Object.values(mine).forEach(r => { try { r.room.leave() } catch { /* gone */ } }) }
    window.addEventListener('pagehide', bye)
    return () => { dead = true; window.removeEventListener('pagehide', bye); bye(); for (const k of Object.keys(mine)) delete mine[k] }
  }, [pairs])

  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = []
    for (const [rk, peers] of Object.entries(peersByRoom)) {
      const r = rooms.current[rk]
      if (!r) continue
      for (const peer of peers) out.push({ key: rk + ':' + peer.id, room: r.room, peer, via: r.via, label: r.label })
    }
    return out
  }, [peersByRoom])
  const sel = entries.find(e => e.key === selected) ?? (entries.length === 1 ? entries[0] : null)
  const onlinePairNames = new Set(entries.filter(e => e.via === 'paired').map(e => e.label))

  const sendFiles = useCallback(async (list: File[]) => {
    if (!sel) return
    if (!peerMutual(sel.peer)) { setNotice('Confirm the code on both devices first.'); return }
    const ok = list.filter(f => f.size <= MAX_FILE_BYTES).slice(0, MAX_FILES)
    if (ok.length < list.length) setNotice(`Some files were skipped (limit ${formatBytes(MAX_FILE_BYTES)} each, ${MAX_FILES} files).`)
    for (const file of ok) {
      const buf = await file.arrayBuffer()
      const meta: FileMeta = { id: randomToken(8), name: file.name, size: file.size, type: file.type || 'application/octet-stream', sha256: await sha256Hex(buf) }
      setOutgoing(o => [...o, { id: meta.id, name: file.name, to: sel.peer.name, progress: 0, status: 'sending' }])
      sel.room.sendFile(sel.peer.id, file, meta, p => setOutgoing(o => o.map(x => x.id === meta.id ? { ...x, progress: p } : x)))
        .then(() => setOutgoing(o => o.map(x => x.id === meta.id ? { ...x, progress: 1, status: 'done' } : x)))
        .catch(e => setOutgoing(o => o.map(x => x.id === meta.id ? { ...x, status: 'failed', error: String(e) } : x)))
    }
  }, [sel])

  const sendText = useCallback(async () => {
    const t = text.trim()
    if (!t || !sel) return
    try { await sel.room.sendText(t, [sel.peer.id]); setSent(s => [...s.slice(-49), { id: crypto.randomUUID(), from: sel.peer.name, text: t, ts: Date.now() }]); setText('') }
    catch { setNotice('Could not send - confirm the code on both devices first.') }
  }, [text, sel])

  return (
    <div className="fade-up flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">My devices</h1>
        <p className="text-sm text-[--color-mut]">
          Open ProShare on both devices. Devices on the same Wi-Fi appear here by themselves; paired devices appear on any network.
          Everything goes straight between your devices, encrypted. Nothing is stored on a server.
        </p>
      </div>

      {notice && (
        <div className="card p-3 text-sm text-[--color-warn] flex justify-between items-center gap-3">
          <span>{notice}</span>
          <button className="text-[--color-mut] hover:text-white" onClick={() => setNotice(null)} aria-label="dismiss">&#10005;</button>
        </div>
      )}

      <Card className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider">This device</div>
        <div className="flex gap-2">
          <input className="field" value={name} maxLength={40} onChange={e => setName(e.target.value)} onBlur={() => { setDeviceName(name); setName(deviceName()) }} />
        </div>
        <p className="text-xs text-[--color-mut]">
          {nearbyState === 'looking' && 'Looking for devices on your Wi-Fi\u2026'}
          {nearbyState === 'on' && 'Visible to devices on the same Wi-Fi (same router / public IP). Nobody gets anything until both sides confirm a code.'}
          {nearbyState === 'unavailable' && 'Could not work out your network, so nearby discovery is off. Paired devices still work.'}
          {!turnConfigured() && ' Cross-network relay is not configured yet, so paired devices connect directly (fine on one Wi-Fi, may fail across networks).'}
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider">Devices</div>
        {entries.length === 0 && <p className="text-sm text-[--color-mut]">No devices found yet. Open ProShare on your other device and keep this page open.</p>}
        {entries.map(e => (
          <button key={e.key} onClick={() => setSelected(e.key)}
            className={`text-left rounded-xl border p-3 flex items-center justify-between gap-3 ${sel?.key === e.key ? 'border-[--color-brand]' : 'border-[--color-line]'} bg-[--color-panel2]`}>
            <span>
              <span className="font-semibold">{e.peer.name}</span>
              <span className="text-xs text-[--color-mut] ml-2">{e.via === 'paired' ? 'paired' : 'nearby'}</span>
            </span>
            <span className={`pill ${peerMutual(e.peer) ? 'pill-ok' : 'pill-warn'}`}>{peerMutual(e.peer) ? 'connected' : e.peer.localConfirmed ? 'waiting for them' : 'confirm code'}</span>
          </button>
        ))}
        {pairs.filter(p => !onlinePairNames.has(p.name)).map(p => (
          <div key={p.id} className="rounded-xl border border-[--color-line] p-3 flex items-center justify-between gap-3 opacity-70">
            <span><span className="font-semibold">{p.name}</span><span className="text-xs text-[--color-mut] ml-2">paired &middot; offline</span></span>
            <button className="text-xs text-[--color-mut] underline" onClick={() => { forgetPair(p.id); setPairs(listPairs()) }}>forget</button>
          </div>
        ))}
        <a className="btn btn-ghost" href="#/pair">Pair a new device with a 6-digit code</a>
      </Card>

      {sel && !peerMutual(sel.peer) && !sel.peer.localConfirmed && (
        <Card className="pulse-ring border-[--color-brand]">
          <div className="font-semibold text-lg mb-1">Check this code with {sel.peer.name}</div>
          <p className="text-sm text-[--color-mut] mb-2">It must be the same on both screens. If it differs, do not continue: someone else on this network may be in the middle.</p>
          <div className="mono text-3xl font-bold tracking-[0.2em] text-[--color-brand2] mb-3">{sel.peer.code}</div>
          <button className="btn btn-ok w-full" onClick={() => sel.room.confirmPeer(sel.peer.id).catch(() => setNotice('Could not confirm - the connection may have dropped.'))}>The codes match</button>
        </Card>
      )}
      {sel && !peerMutual(sel.peer) && sel.peer.localConfirmed && (
        <Card><p className="text-sm text-[--color-warn]">You confirmed. Waiting for {sel.peer.name} to confirm on their device.</p></Card>
      )}

      {sel && peerMutual(sel.peer) && (
        <>
          <Card className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider">Send to {sel.peer.name}</div>
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); void sendFiles([...e.dataTransfer.files]) }}
              className={`rounded-xl border-2 border-dashed p-6 text-center text-sm cursor-pointer ${drag ? 'border-[--color-brand]' : 'border-[--color-line]'}`}
              onClick={() => fileInput.current?.click()}>
              Tap to choose files, or drop them here. They send right away.
              <input ref={fileInput} type="file" multiple hidden onChange={e => { void sendFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
            </div>
            <div className="flex gap-2">
              <input className="field" placeholder="Send text or a link&hellip;" value={text} maxLength={MAX_TEXT_CHARS}
                onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void sendText() }} />
              <button className="btn btn-primary" onClick={() => void sendText()} disabled={!text.trim()}>Send</button>
            </div>
            {sel.via === 'nearby' && (
              <a className="text-xs text-[--color-mut] underline" href="#/pair">Pair these devices so they find each other on any network</a>
            )}
            {outgoing.map(o => (
              <div key={o.id} className="text-sm space-y-1">
                <div className="flex justify-between gap-3"><span className="truncate">{o.name} &rarr; {o.to}</span><span className="text-[--color-mut] shrink-0">{o.status === 'done' ? 'sent' : o.status === 'failed' ? 'failed' : `${Math.round(o.progress * 100)}%`}</span></div>
                {o.status === 'sending' && <ProgressBar value={o.progress} />}
                {o.error && <div className="text-xs text-[--color-bad]">{o.error}</div>}
              </div>
            ))}
          </Card>
        </>
      )}

      <Card>
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-3">Received</div>
        {files.length === 0 && texts.length === 0 && <p className="text-sm text-[--color-mut]">Files and text from your devices show up here. Nothing downloads until you press the download icon.</p>}
        <div className="space-y-3">
          {files.map(f => (
            <div key={f.meta.id} className="text-sm space-y-1">
              <div className="flex justify-between gap-3">
                <span className="truncate">{f.meta.name}</span>
                {f.status === 'done' ? <span className="flex items-center gap-2 shrink-0"><span className="pill pill-ok">verified</span>{f.data && <button type="button" className="btn btn-ghost" onClick={() => saveBlob(f.data!, f.meta.name, f.meta.type)}>Download</button>}</span>
                  : f.status === 'failed' ? <span className="pill pill-bad shrink-0">failed</span>
                  : <span className="text-[--color-mut] shrink-0">{Math.round(f.progress * 100)}%</span>}
              </div>
              {(f.status === 'receiving' || f.status === 'verifying') && <ProgressBar value={f.progress} />}
              {f.error && <div className="text-xs text-[--color-bad]">{f.error}</div>}
              <div className="text-xs text-[--color-mut]">{formatBytes(f.meta.size)}</div>
            </div>
          ))}
          {texts.map(m => (
            <div key={m.id} className="text-sm rounded-xl px-3 py-2 bg-[--color-panel2] whitespace-pre-wrap break-words">
              <div className="flex items-center justify-between gap-2 mb-0.5"><span className="text-xs text-[--color-mut]">{m.name}</span><CopyButton text={m.text} /></div>
              {m.text}
            </div>
          ))}
          {sent.map(m => (
            <div key={m.id} className="text-sm rounded-xl px-3 py-2 bg-[rgba(109,92,255,.16)] ml-auto max-w-[85%] whitespace-pre-wrap break-words">
              <div className="text-xs text-[--color-mut] mb-0.5">You &rarr; {m.from}</div>{m.text}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
