import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProShareRoom, type ChatMsg, type FileMeta, type PeerInfo, type PendingRequest } from '../lib/room'
import { randomToken, sha256Hex } from '../lib/crypto'
import { MAX_FILE_BYTES, MAX_FILES, MAX_TEXT_CHARS, formatBytes } from '../lib/files'
import { Card } from '../components/Chrome'
import { Qr } from '../components/Qr'
import { ProgressBar } from '../components/ProgressBar'

interface Outgoing { meta: FileMeta; target: string; targetName: string; progress: number; status: 'sending' | 'done' | 'failed'; error?: string }

export function Host({ roomId, password }: { roomId: string; password: string }) {
  const [joinLink] = useState(() => `${location.origin}${location.pathname}#/join/${roomId}/${password}`)
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [picked, setPicked] = useState<File[]>([])
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [ended, setEnded] = useState(false)
  const [drag, setDrag] = useState(false)
  const [text, setText] = useState('')
  const roomRef = useRef<ProShareRoom | null>(null)

  useEffect(() => {
    const room = ProShareRoom.host(roomId, password, {
      onPending: setPending,
      onPeers: setPeers,
      onFileStart: () => {}, // hosts send; guests receive
      onFileProgress: () => {},
      onFileDone: () => {},
      onText: m => setChat(c => [...c.slice(-99), m]),
      onError: setNotice,
      onJoinError: () => {},
      onLeft: (_id, role) => { if (role === 'guest') setNotice('A peer left the session.') },
    }, 'Host')
    roomRef.current = room
    return () => { room.leave(); roomRef.current = null }
  }, [roomId, password])

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = [...files]
    const tooBig = list.filter(f => f.size > MAX_FILE_BYTES)
    if (tooBig.length) setNotice(`${tooBig.length} file(s) skipped - over the ${formatBytes(MAX_FILE_BYTES)} per-file limit.`)
    setPicked(p => [...p, ...list.filter(f => f.size <= MAX_FILE_BYTES)].slice(0, MAX_FILES - p.length))
  }, [])

  const sendAll = useCallback(async () => {
    const room = roomRef.current
    if (!room || !picked.length) return
    const targets = room.approvedPeerIds()
    if (!targets.length) { setNotice('No approved recipients yet. Share the link and approve someone first.'); return }
    const toSend = picked
    setPicked([])
    for (const file of toSend) {
      const buf = await file.arrayBuffer()
      const meta: FileMeta = {
        id: randomToken(8), name: file.name, size: file.size,
        type: file.type || 'application/octet-stream', sha256: await sha256Hex(buf),
      }
      for (const peerId of targets) {
        const targetName = peers.find(p => p.id === peerId)?.name ?? 'peer'
        setOutgoing(o => [...o, { meta, target: peerId, targetName, progress: 0, status: 'sending' }])
        room.sendFile(peerId, file, meta, p => {
          setOutgoing(o => o.map(x => x.meta.id === meta.id && x.target === peerId ? { ...x, progress: p } : x))
        }).then(() => {
          setOutgoing(o => o.map(x => x.meta.id === meta.id && x.target === peerId ? { ...x, progress: 1, status: 'done' } : x))
        }).catch(e => {
          setOutgoing(o => o.map(x => x.meta.id === meta.id && x.target === peerId ? { ...x, status: 'failed', error: String(e) } : x))
        })
      }
    }
  }, [picked, peers])

  const sendText = useCallback(async () => {
    const t = text.trim()
    if (!t || !roomRef.current) return
    if (t.length > MAX_TEXT_CHARS) { setNotice(`Message too long (max ${MAX_TEXT_CHARS} chars).`); return }
    const msg: ChatMsg = { id: crypto.randomUUID(), from: roomRef.current.selfId, name: 'You', text: t, ts: Date.now() }
    try { await roomRef.current.sendText(t); setChat(c => [...c.slice(-99), msg]); setText('') }
    catch { setNotice('Could not send - no connected recipients.') }
  }, [text])

  const copyLink = useCallback(async () => {
    try { await navigator.clipboard.writeText(joinLink); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000) }
    catch { setNotice('Clipboard blocked - long-press the link to copy it.') }
  }, [joinLink])

  const endSession = useCallback(() => {
    roomRef.current?.leave()
    setEnded(true)
  }, [])

  const guests = useMemo(() => peers.filter(p => p.role === 'guest'), [peers])

  if (ended) {
    return (
      <div className="fade-up flex flex-col items-center justify-center flex-1 text-center gap-4">
        <div className="text-5xl">&#128274;</div>
        <h2 className="text-2xl font-bold">Session ended</h2>
        <p className="text-[--color-mut] max-w-sm">The room is closed and the link no longer works. Start a new session to share again.</p>
        <a className="btn btn-primary" href="#/">New session</a>
      </div>
    )
  }

  return (
    <div className="fade-up flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Your private room is ready</h1>
        <p className="text-[--color-mut] text-sm">Share the link with one person. They ask to join, you approve, then send. Nothing uploads anywhere.</p>
      </div>

      {notice && (
        <div className="card p-3 text-sm text-[--color-warn] flex justify-between items-center gap-3">
          <span>{notice}</span>
          <button className="text-[--color-mut] hover:text-white" onClick={() => setNotice(null)} aria-label="dismiss">&#10005;</button>
        </div>
      )}

      <Card>
        <div className="flex flex-col sm:flex-row gap-5 sm:items-center">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-2">Invite link (contains the room key)</div>
            <div className="mono text-xs sm:text-sm break-all bg-[--color-panel2] border border-[--color-line] rounded-xl p-3 select-all">{joinLink}</div>
            <div className="flex gap-2 mt-3 flex-wrap">
              <button className="btn btn-primary" onClick={copyLink}>{linkCopied ? 'Copied' : 'Copy link'}</button>
              <button className="btn btn-danger" onClick={endSession}>End session</button>
            </div>
            <p className="text-xs text-[--color-mut] mt-3">Anyone with this link can <i>ask</i> to join - nobody gets in without your approval. Treat it like a key.</p>
          </div>
          <div className="self-center"><Qr value={joinLink} /></div>
        </div>
      </Card>

      {pending && (
        <Card className="pulse-ring border-[--color-brand]">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              <div className="font-semibold text-lg">Join request</div>
              <p className="text-sm text-[--color-mut]"><b className="text-white">{pending.name}</b> is asking to connect. Only approve if you just shared the link with them.</p>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-ok" onClick={() => pending.resolve(true)}>Approve</button>
              <button className="btn btn-danger" onClick={() => pending.resolve(false)}>Reject</button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-3">Connected ({guests.length})</div>
        {guests.length === 0 ? (
          <p className="text-sm text-[--color-mut]">Waiting for someone to join&hellip; keep this tab open.</p>
        ) : (
          <ul className="space-y-3">
            {guests.map(p => (
              <li key={p.id} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-[--color-brand] flex items-center justify-center font-bold">{p.name.slice(0, 1).toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{p.name}</div>
                  <div className="text-xs text-[--color-mut]">verification code <span className="mono text-[--color-brand2]">{p.code}</span> - compare with their screen</div>
                </div>
                <span className="pill pill-ok">connected</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-3">Send files</div>
        <label
          className={`block border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${drag ? 'border-[--color-brand] bg-[rgba(109,92,255,.08)]' : 'border-[--color-line] hover:border-[--color-brand]'}`}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
        >
          <input type="file" multiple className="hidden" onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
          <div className="text-3xl mb-2">&#128228;</div>
          <div className="font-semibold">Drop files here or tap to choose</div>
          <div className="text-xs text-[--color-mut] mt-1">Up to {formatBytes(MAX_FILE_BYTES)} per file - files stay on your device until a peer is approved</div>
        </label>
        {picked.length > 0 && (
          <div className="mt-4 space-y-2">
            {picked.map((f, i) => (
              <div key={i} className="flex items-center gap-3 text-sm bg-[--color-panel2] rounded-xl px-3 py-2">
                <span className="truncate flex-1">{f.name}</span>
                <span className="text-[--color-mut] shrink-0">{formatBytes(f.size)}</span>
                <button className="text-[--color-mut] hover:text-white" onClick={() => setPicked(p => p.filter((_, j) => j !== i))} aria-label="remove">&#10005;</button>
              </div>
            ))}
            <button className="btn btn-primary w-full mt-2" onClick={sendAll} disabled={guests.length === 0}>
              Send {picked.length} file{picked.length > 1 ? 's' : ''} to {guests.length || 'no'} recipient{guests.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
        {outgoing.length > 0 && (
          <div className="mt-4 space-y-3">
            <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider">Transfers</div>
            {outgoing.map((o, i) => (
              <div key={i} className="text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="truncate">{o.meta.name} <span className="text-[--color-mut]">&rarr; {o.targetName}</span></span>
                  {o.status === 'done' ? <span className="pill pill-ok shrink-0">sent &middot; verified</span>
                    : o.status === 'failed' ? <span className="pill pill-bad shrink-0">failed</span>
                    : <span className="text-[--color-mut] shrink-0">{Math.round(o.progress * 100)}%</span>}
                </div>
                {o.status === 'sending' && <ProgressBar value={o.progress} />}
                {o.error && <div className="text-xs text-[--color-bad]">{o.error}</div>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-3">Text</div>
        <div className="space-y-2 mb-3 max-h-56 overflow-y-auto">
          {chat.length === 0 && <p className="text-sm text-[--color-mut]">Text you send appears as plain text only - no links auto-open, no formatting, no scripts.</p>}
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
          <button className="btn btn-primary" onClick={sendText} disabled={!text.trim() || guests.length === 0}>Send</button>
        </div>
      </Card>
    </div>
  )
}
