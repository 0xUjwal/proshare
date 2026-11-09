import { CopyButton } from '../components/CopyButton'
import { Diag } from '../components/Diag'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProShareRoom, peerMutual, type ChatMsg, type FileMeta, type PeerInfo, type PendingRequest } from '../lib/room'
import { randomToken, sha256Hex } from '../lib/crypto'
import { MAX_FILE_BYTES, MAX_FILES, MAX_TEXT_CHARS, formatBytes } from '../lib/files'
import { formatCode } from '../lib/codes'
import { Card } from '../components/Chrome'
import { Qr } from '../components/Qr'
import { deviceName, newSecret, savePair } from '../lib/pairs'
import { ProgressBar } from '../components/ProgressBar'

interface Outgoing { meta: FileMeta; target: string; targetName: string; progress: number; status: 'sending' | 'done' | 'failed'; error?: string }

export function Host({ roomCode }: { roomCode: string }) {
  const [joinLink] = useState(() => `${location.origin}${location.pathname}#/join/${encodeURIComponent(roomCode)}`)
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
  const pairSecretRef = useRef<string | null>(null)
  const [pairState, setPairState] = useState<'idle' | 'asked' | 'saved'>('idle')

  const guests = useMemo(() => peers.filter(p => p.role === 'guest'), [peers])


  useEffect(() => {
    const room = ProShareRoom.host(roomCode, {
      onPending: setPending,
      onPeers: setPeers,
      onFileStart: () => {}, // hosts send; guests receive
      onFileProgress: () => {},
      onFileDone: () => {},
      onText: m => setChat(c => [...c.slice(-99), m]),
      onPair: (payload, peer) => {
        if (payload === 'ok' && pairSecretRef.current) { savePair(peer.name, pairSecretRef.current); pairSecretRef.current = null; setPairState('saved') }
      },
      onError: setNotice,
      onJoinError: msg => {
        // Another live host claimed the same code - tell the sender to pick another.
        if (/same-role/i.test(msg)) setNotice('That code is already in use by another open room. Go back and choose a different one.')
      },
      onLeft: (_id, role) => {
        if (role === 'guest') setNotice('A peer left the session.')
      },
    }, deviceName())
    roomRef.current = room
    // Closing the tab or navigating away ends the room right away (best effort:
    // browsers may skip this on a crash or lost network, in which case peers
    // notice when the connection drops).
    const bye = () => { try { room.leave() } catch { /* already gone */ } }
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); room.leave(); roomRef.current = null }
  }, [roomCode])

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = [...files]
    const tooBig = list.filter(f => f.size > MAX_FILE_BYTES)
    if (tooBig.length) setNotice(`${tooBig.length} file(s) skipped - over the ${formatBytes(MAX_FILE_BYTES)} per-file limit.`)
    setPicked(p => [...p, ...list.filter(f => f.size <= MAX_FILE_BYTES)].slice(0, MAX_FILES - p.length))
  }, [])

  const sendAll = useCallback(async () => {
    const room = roomRef.current
    if (!room || !picked.length) return
    const mutualIds = guests.filter(peerMutual).map(g => g.id)
    const targets = room.approvedPeerIds().filter(id => mutualIds.includes(id))
    if (!targets.length) { setNotice('No verified recipients yet. Both sides must confirm the verification code first.'); return }
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
  }, [picked, peers, guests])

  const sendText = useCallback(async () => {
    const t = text.trim()
    if (!t || !roomRef.current) return
    if (t.length > MAX_TEXT_CHARS) { setNotice(`Message too long (max ${MAX_TEXT_CHARS} chars).`); return }
    const msg: ChatMsg = { id: crypto.randomUUID(), from: roomRef.current.selfId, name: 'You', text: t, ts: Date.now() }
    const mutualIds = guests.filter(peerMutual).map(g => g.id)
    try { await roomRef.current.sendText(t, roomRef.current.approvedPeerIds().filter(id => mutualIds.includes(id))); setChat(c => [...c.slice(-99), msg]); setText('') }
    catch { setNotice('Could not send - both sides must confirm the verification code first.') }
  }, [text, guests])

  const copyLink = useCallback(async () => {
    try { await navigator.clipboard.writeText(joinLink); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000) }
    catch { setNotice('Clipboard blocked - long-press the link to copy it.') }
  }, [joinLink])

  const offerPair = useCallback(async (peerId: string) => {
    const room = roomRef.current
    if (!room) return
    const secret = newSecret()
    pairSecretRef.current = secret
    try { await room.sendPair(peerId, 'offer:' + secret); setPairState('asked') }
    catch { setNotice('Could not ask - confirm the verification code on both sides first.') }
  }, [])

  const endSession = useCallback(() => {
    roomRef.current?.leave()
    setEnded(true)
  }, [])

  if (ended) {
    return (
      <div className="fade-up flex flex-col items-center justify-center flex-1 text-center gap-4">
        <div className="text-5xl">&#128274;</div>
        <h2 className="text-2xl font-bold">Session ended</h2>
        <p className="text-[--color-mut] max-w-sm">The room is closed and its code no longer connects to you. Start a new session to share again.</p>
        <a className="btn btn-primary" href="#/">New session</a>
      </div>
    )
  }

  return (
    <div className="fade-up flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Your room is open</h1>
        <p className="text-[--color-mut] text-sm">Share the code or link. They ask to join, you approve, then send. Keep this tab open - closing it ends the room.</p>
      </div>

      {notice && (
        <div className="card p-3 text-sm text-[--color-warn] flex justify-between items-center gap-3">
          <span>{notice}</span>
          <button className="text-[--color-mut] hover:text-white" onClick={() => setNotice(null)} aria-label="dismiss">&#10005;</button>
        </div>
      )}

      {guests.filter(peerMutual).length === 1 && (
        <Card className="flex flex-col gap-2">
          <div className="font-semibold">Remember {guests.filter(peerMutual)[0].name}?</div>
          <p className="text-sm text-[--color-mut]">Pair these two devices so they find each other automatically next time, on any network, with no code.</p>
          {pairState === 'idle' && <button className="btn btn-primary" onClick={() => offerPair(guests.filter(peerMutual)[0].id)}>Remember this device</button>}
          {pairState === 'asked' && <p className="text-sm text-[--color-warn]">Waiting for them to accept on their device&hellip;</p>}
          {pairState === 'saved' && <p className="text-sm text-[--color-ok]">Paired. Open <a className="underline" href="#/devices">My devices</a> any time.</p>}
        </Card>
      )}

      <Card>
        <div className="flex flex-col sm:flex-row gap-5 sm:items-center">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mb-2">Room code</div>
            <div className="mono text-3xl sm:text-4xl font-bold tracking-[0.2em] text-[--color-brand2] select-all">{formatCode(roomCode)}</div>
            <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider mt-4 mb-2">Or share the link</div>
            <div className="mono text-xs sm:text-sm break-all bg-[--color-panel2] border border-[--color-line] rounded-xl p-3 select-all">{joinLink}</div>
            <div className="flex gap-2 mt-3 flex-wrap">
              <button className="btn btn-primary" onClick={copyLink}>{linkCopied ? 'Copied' : 'Copy link'}</button>
              <button className="btn btn-danger" onClick={endSession}>End session</button>
            </div>
            <p className="text-xs text-[--color-mut] mt-3">Anyone with the code can <i>ask</i> to join - nobody gets in without your approval, and nothing transfers until you send it.</p>
          </div>
          <div className="self-center"><Qr value={joinLink} /></div>
        </div>
      </Card>

      {pending && (
        <Card className="pulse-ring border-[--color-brand]">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              <div className="font-semibold text-lg">Join request</div>
              <p className="text-sm text-[--color-mut]"><b className="text-white">{pending.name}</b> is asking to connect. Only approve if you just shared the code with them.</p>
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
          <>
            <p className="text-sm text-[--color-mut]">Waiting for someone to join&hellip; keep this tab open.</p>
            <Diag get={() => roomRef.current?.diagnostics() ?? null} />
          </>
        ) : (
          <ul className="space-y-3">
            {guests.map(p => (
              <li key={p.id} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-[--color-brand] flex items-center justify-center font-bold">{p.name.slice(0, 1).toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{p.name}</div>
                  <div className="text-xs text-[--color-mut]">verification code <span className="mono text-[--color-brand2] text-sm">{p.code}</span> - read it to them and check theirs matches</div>
                </div>
                {peerMutual(p)
                  ? <span className="pill pill-ok">code confirmed</span>
                  : p.localConfirmed
                  ? <span className="pill pill-warn">waiting for them to confirm</span>
                  : <button className="btn btn-ok" onClick={() => { roomRef.current?.confirmPeer(p.id).catch(() => setNotice('Could not send confirmation - the peer may have left.')) }}>Codes match</button>}
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
            <button className="btn btn-primary w-full mt-2" onClick={sendAll} disabled={guests.filter(peerMutual).length === 0}>
              Send {picked.length} file{picked.length > 1 ? 's' : ''} to {guests.filter(peerMutual).length || 'no'} verified recipient{guests.filter(peerMutual).length === 1 ? '' : 's'}
            </button>
            {guests.length > 0 && guests.filter(peerMutual).length === 0 && (
              <p className="text-xs text-[--color-warn] mt-2">Compare the 6-digit verification code with your recipient (call or another chat) and press "Codes match". Nothing can be sent until both sides confirm - the comparison protects against interception.</p>
            )}
          </div>
        )}
        {outgoing.length > 0 && (
          <div className="mt-4 space-y-3">
            <div className="text-xs font-semibold text-[--color-mut] uppercase tracking-wider">Transfers</div>
            {outgoing.map((o, i) => (
              <div key={i} className="text-sm space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="truncate">{o.meta.name} <span className="text-[--color-mut]">&rarr; {o.targetName}</span></span>
                  {o.status === 'done' ? <span className="pill pill-ok shrink-0">sent</span>
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
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <span className="text-xs text-[--color-mut]">{m.name}</span>
                {m.name !== 'You' && <CopyButton text={m.text} />}
              </div>
              {m.text}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="field" placeholder="Type a message&hellip;" value={text} maxLength={MAX_TEXT_CHARS}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendText() }} />
          <button className="btn btn-primary" onClick={sendText} disabled={!text.trim() || guests.filter(peerMutual).length === 0}>Send</button>
        </div>
      </Card>
    </div>
  )
}
