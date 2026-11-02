import { useCallback, useEffect, useRef, useState } from 'react'
import { ProShareRoom, type ChatMsg, type IncomingFile, type PeerInfo } from '../lib/room'
import { MAX_TEXT_CHARS, formatBytes, saveBlob } from '../lib/files'
import { Card } from '../components/Chrome'
import { ProgressBar } from '../components/ProgressBar'

type Phase = 'name' | 'connecting' | 'waiting' | 'connected' | 'declined' | 'failed'

export function Join({ roomId, password }: { roomId: string; password: string }) {
  const [phase, setPhase] = useState<Phase>('name')
  const [name, setName] = useState('')
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [files, setFiles] = useState<IncomingFile[]>([])
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const roomRef = useRef<ProShareRoom | null>(null)

  const connect = useCallback(() => {
    const display = name.trim().slice(0, 40) || `Guest-${Math.floor(Math.random() * 900 + 100)}`
    setPhase('connecting')
    const room = ProShareRoom.guest(roomId, password, {
      onPending: () => {},
      onPeers: p => { setPeers(p); if (p.length) setPhase('connected') },
      onFileStart: f => setFiles(fs => [...fs.filter(x => x.meta.id !== f.meta.id), f]),
      onFileProgress: (id, progress) => setFiles(fs => fs.map(x => x.meta.id === id ? { ...x, progress } : x)),
      onFileDone: f => {
        setFiles(fs => fs.map(x => x.meta.id === f.meta.id ? f : x))
        if (f.status === 'done' && f.data) saveBlob(f.data, f.meta.name, f.meta.type)
      },
      onText: m => setChat(c => [...c.slice(-99), m]),
      onError: setNotice,
      onJoinError: msg => {
        setPhase(prev => {
          if (prev === 'connected') { setNotice('Connection to the host was lost.'); return prev }
          return /declined|deny|denied|reject/i.test(msg) ? 'declined' : 'failed'
        })
      },
      onLeft: () => setNotice('The host left. The session is over - this link will not work anymore.'),
    }, display)
    roomRef.current = room
    // Host approval can take a moment; show a friendly waiting state.
    const t = setTimeout(() => setPhase(p => (p === 'connecting' ? 'waiting' : p)), 4000)
    return () => clearTimeout(t)
  }, [name, roomId, password])

  useEffect(() => () => { roomRef.current?.leave(); roomRef.current = null }, [])

  const sendText = useCallback(async () => {
    const t = text.trim()
    if (!t || !roomRef.current) return
    const msg: ChatMsg = { id: crypto.randomUUID(), from: 'me', name: 'You', text: t, ts: Date.now() }
    try { await roomRef.current.sendText(t); setChat(c => [...c.slice(-99), msg]); setText('') }
    catch { setNotice('Could not send - not connected.') }
  }, [text])

  const host = peers.find(p => p.role === 'host')

  if (phase === 'name') {
    return (
      <div className="fade-up flex flex-col gap-5 max-w-md mx-auto w-full mt-6">
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">You've been invited</h1>
          <p className="text-[--color-mut] text-sm mt-2">Someone wants to share with you directly, browser to browser. They will see a request and must approve you.</p>
        </div>
        <Card className="flex flex-col gap-3">
          <label className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider">Your name (shown to the host)</label>
          <input className="field" placeholder="e.g. Ujwal" value={name} maxLength={40} autoFocus
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') connect() }} />
          <button className="btn btn-primary w-full" onClick={connect}>Request to join</button>
          <p className="text-xs text-[--color-mut]">This opens a direct encrypted connection. No account, nothing uploaded.</p>
        </Card>
      </div>
    )
  }

  if (phase === 'declined' || phase === 'failed') {
    return (
      <div className="fade-up flex flex-col items-center justify-center flex-1 text-center gap-4">
        <div className="text-5xl">{phase === 'declined' ? '\u{1F6AB}' : '\u{1F50C}'}</div>
        <h2 className="text-2xl font-bold">{phase === 'declined' ? 'Request declined' : 'Could not connect'}</h2>
        <p className="text-[--color-mut] max-w-sm">
          {phase === 'declined'
            ? 'The host did not approve this request. Check you used the exact link they sent, and ask them to approve you.'
            : 'The direct connection could not be established. Some restrictive networks block peer-to-peer connections. Try another network, or ask the host to start a new session.'}
        </p>
        {phase === 'declined' && <button className="btn btn-ghost" onClick={() => setPhase('name')}>Try again</button>}
      </div>
    )
  }

  if (phase === 'connecting' || phase === 'waiting') {
    return (
      <div className="fade-up flex flex-col items-center justify-center flex-1 text-center gap-4">
        <div className="w-12 h-12 rounded-full border-4 border-[--color-line] border-t-[--color-brand] animate-spin" />
        <h2 className="text-xl font-bold">{phase === 'connecting' ? 'Opening a secure channel&hellip;' : 'Waiting for the host to approve you&hellip;'}</h2>
        <p className="text-[--color-mut] max-w-sm text-sm">Keep this tab open. If the host doesn't see your request, double-check the link is complete.</p>
      </div>
    )
  }

  return (
    <div className="fade-up flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Connected to {host ? host.name : 'host'}</h1>
        {host && (
          <p className="text-sm text-[--color-mut]">
            Verification code <span className="mono text-[--color-brand2] text-base">{host.code}</span> - compare it with the code on the host's screen (over a call or chat) to be sure it's really them.
          </p>
        )}
      </div>

      {notice && (
        <div className="card p-3 text-sm text-[--color-warn] flex justify-between items-center gap-3">
          <span>{notice}</span>
          <button className="text-[--color-mut] hover:text-white" onClick={() => setNotice(null)} aria-label="dismiss">&#10005;</button>
        </div>
      )}

      <Card>
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-3">Incoming files</div>
        {files.length === 0 ? (
          <p className="text-sm text-[--color-mut]">Files the host sends will appear here and download automatically after an integrity check.</p>
        ) : (
          <div className="space-y-3">
            {files.map(f => (
              <div key={f.meta.id} className="text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="truncate">{f.meta.name}</span>
                  {f.status === 'done' ? <span className="pill pill-ok shrink-0">saved &middot; verified</span>
                    : f.status === 'failed' ? <span className="pill pill-bad shrink-0">failed</span>
                    : f.status === 'verifying' ? <span className="pill pill-warn shrink-0">verifying</span>
                    : <span className="text-[--color-mut] shrink-0">{Math.round(f.progress * 100)}%</span>}
                </div>
                {(f.status === 'receiving' || f.status === 'verifying') && <ProgressBar value={f.progress} />}
                {f.error && <div className="text-xs text-[--color-bad]">{f.error}</div>}
                <div className="text-xs text-[--color-mut]">{formatBytes(f.meta.size)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-3">Text</div>
        <div className="space-y-2 mb-3 max-h-56 overflow-y-auto">
          {chat.length === 0 && <p className="text-sm text-[--color-mut]">Messages appear as plain text only - nothing clickable or executable.</p>}
          {chat.map(m => (
            <div key={m.id} className={`text-sm rounded-xl px-3 py-2 max-w-[85%] whitespace-pre-wrap break-words ${m.name === 'You' ? 'bg-[rgba(109,92,255,.16)] ml-auto' : 'bg-[--color-panel2]'}`}>
              <div className="text-xs text-[--color-mut] mb-0.5">{m.name}</div>
              {m.text}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="field" placeholder="Type a message&hellip;" value={text} maxLength={MAX_TEXT_CHARS}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendText() }} />
          <button className="btn btn-primary" onClick={sendText} disabled={!text.trim()}>Send</button>
        </div>
      </Card>
    </div>
  )
}
