// ProShare room layer - wraps Trystero (serverless WebRTC rendezvous).
//
// Security properties this layer is built around:
//  - The room code is a human-typed rendezvous identifier only - never an
//    encryption key (a 6-digit code would be offline-brute-forceable).
//  - Each peer pair runs ephemeral ECDH inside the handshake; the derived
//    key encrypts handshake payloads and yields the verification code that
//    detects a man-in-the-middle when compared out of band.
//  - onPeerHandshake = hard admission control: until the host approves, the
//    pending peer is invisible to all room events and its data is dropped.
//  - Every reconnection is a new handshake -> approval is never carried over.
//  - Receiver-side onReceive gates every payload (peer must be approved,
//    size must be within limits) as defense in depth.
//  - No TURN servers: file bytes travel direct P2P (DTLS encrypted) and are
//    never relayed. Downside: restrictive/symmetric NATs can block a pair.
//  - Signaling itself (SDP offers/answers) passes public Nostr relays in
//    readable form: relays and anyone who guesses a live code can see
//    connection metadata (IPs, timing). Never file contents.
import { joinRoom, selfId, type MessageAction, type Room } from 'trystero'
import { deriveSessionKeys, exportPub, generateKxPair, open, openRaw, seal, sealRaw, sha256Hex, type SessionKeys } from './crypto'
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, sanitizeFilename } from './files'

export const APP_ID = 'proshare-p2p-v1'
const CHUNK_BYTES = 256 * 1024
const MAX_WIRE_BYTES = CHUNK_BYTES + 4096 // chunk + AEAD/base64 overhead
export type Role = 'host' | 'guest'

export interface PeerInfo {
  id: string
  name: string
  role: Role
  code: string // out-of-band verification code for this pairing
  connectedAt: number
}

export interface PendingRequest {
  peerId: string
  name: string
  resolve: (approved: boolean) => void
}

export interface FileMeta {
  [key: string]: string | number
  id: string
  name: string
  size: number
  type: string
  sha256: string
}

export interface IncomingFile {
  meta: FileMeta
  progress: number // 0..1
  status: 'receiving' | 'verifying' | 'done' | 'failed'
  data?: ArrayBuffer
  error?: string
}

export interface ChatMsg { id: string; from: string; name: string; text: string; ts: number }

export interface RoomEvents {
  onPending: (req: PendingRequest | null) => void
  onPeers: (peers: PeerInfo[]) => void
  onFileStart: (f: IncomingFile) => void
  onFileProgress: (id: string, progress: number) => void
  onFileDone: (f: IncomingFile) => void
  onText: (m: ChatMsg) => void
  onError: (msg: string) => void
  onJoinError: (msg: string) => void
  onLeft: (peerId: string, role: Role | null) => void
}

function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out.buffer
}

export class ProShareRoom {
  readonly role: Role
  readonly roomCode: string
  readonly selfId = selfId
  private room: Room
  private peers = new Map<string, PeerInfo>()
  private rejected = new Set<string>()
  private pendingQueue: PendingRequest[] = []
  private pendingActive: PendingRequest | null = null
  private sessions = new Map<string, { keys: SessionKeys; sendSeq: number; recvSeq: number }>()
  private ev: RoomEvents
  private closed = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendFileAction: MessageAction<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private textAction: MessageAction<any>

  private constructor(role: Role, roomCode: string, ev: RoomEvents, myName: string) {
    this.role = role
    this.roomCode = roomCode
    this.ev = ev

    this.room = joinRoom(
      { appId: APP_ID, maxReceiveBytes: MAX_FILE_BYTES + 64 * 1024 * 1024 },
      roomCode,
      {
        handshakeTimeoutMs: 120_000, // a human needs time to approve
        onPeerHandshake: async (peerId, send, receive, isInitiator) => {
          // 1. Ephemeral ECDH key exchange (fixed order: initiator first).
          const kx = await generateKxPair()
          const myPub = await exportPub(kx)
          if (isInitiator) await send({ t: 'kx', pk: myPub })
          const { data: kxMsg } = await receive()
          if (!isInitiator) await send({ t: 'kx', pk: myPub })
          const remotePk = (kxMsg as { t?: string; pk?: string } | undefined)?.pk
          if ((kxMsg as { t?: string } | undefined)?.t !== 'kx' || typeof remotePk !== 'string') throw new Error('bad handshake')
          const session: SessionKeys = await deriveSessionKeys(kx.privateKey, remotePk, this.selfId, peerId, role)

          // 2. Encrypted hello exchange. A tampered payload fails GCM.
          const hello = { t: 'hello', role, name: myName.slice(0, 40) }
          if (isInitiator) await send(await seal(session.hsKey, hello))
          const { data: remote } = await receive()
          if (!isInitiator) await send(await seal(session.hsKey, hello))
          const h = (await open(session.hsKey, remote)) as Partial<typeof hello> | undefined
          if (!h || h.t !== 'hello' || typeof h.name !== 'string') throw new Error('bad handshake')
          if (h.role === role) throw new Error('same-role peers are not allowed')
          const name = String(h.name).slice(0, 40) || 'Guest'

          if (role === 'host') {
            // A peer the host rejected keeps retrying at the relay level;
            // auto-reject repeats this session without re-prompting the human.
            if (this.rejected.has(peerId)) {
              await send(await seal(session.hsKey, { t: 'reject' })).catch(() => {})
              throw new Error('previously declined')
            }
            // Host decides. Ask the human. Requests are queued so two
            // simultaneous joiners never overwrite each other's prompt.
            const approved = await this.enqueuePending(peerId, name)
            await send(await seal(session.hsKey, { t: approved ? 'accept' : 'reject' }))
            if (!approved) {
              this.rejected.add(peerId)
              throw new Error('declined by host')
            }
            await this.addPeer(peerId, name, 'guest', session)
          } else {
            const { data: verdict } = await receive()
            const v = (await open(session.hsKey, verdict)) as { t?: string } | undefined
            if (v?.t !== 'accept') throw new Error('declined by host')
            await this.addPeer(peerId, name, 'host', session)
          }
        },
        onJoinError: ({ error }) => {
          if (!this.closed) this.ev.onJoinError(String(error ?? 'connection failed'))
        },
      },
    )

    this.sendFileAction = this.room.makeAction('file')
    this.textAction = this.room.makeAction('text')

    // Every content payload is AEAD-sealed under the pair's ECDH session key:
    // direction-separated keys, strictly increasing sequence numbers (order and
    // replay binding), and all transfer metadata inside the envelope. A relay or
    // active MITM without the session key can drop messages but cannot read,
    // alter, or forge them - and dropping breaks the sequence, failing the transfer.
    this.sendFileAction.onReceive = ({ byteLength, peerId }) => {
      const sess = this.sessions.get(peerId)
      if (!sess) return false
      if (typeof byteLength !== 'number' || byteLength <= 0 || byteLength > MAX_WIRE_BYTES) return false
      return true
    }
    this.sendFileAction.onMessage = async (data, { peerId, metadata }) => {
      const sess = this.sessions.get(peerId)
      if (!sess || typeof data !== 'string') return
      const wm = metadata as { id?: string; k?: string; i?: number } | undefined
      if (!wm || typeof wm.id !== 'string' || (wm.k !== 'm' && wm.k !== 'c')) return
      try {
        if (wm.k === 'm') {
          const env = (await open(sess.keys.recvKey, data)) as { s?: number; t?: string; id?: string; name?: unknown; size?: number; type?: unknown; sha256?: string; n?: number }
          if (env.s !== sess.recvSeq + 1 || env.t !== 'meta' || env.id !== wm.id) return
          sess.recvSeq = env.s
          if (typeof env.size !== 'number' || env.size < 0 || env.size > MAX_FILE_BYTES) return
          if (typeof env.sha256 !== 'string' || typeof env.n !== 'number' || env.n < 1 || env.n > Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)) return
          const meta: FileMeta = {
            id: env.id.slice(0, 40),
            name: sanitizeFilename(env.name),
            size: env.size,
            type: typeof env.type === 'string' ? env.type.slice(0, 120) : 'application/octet-stream',
            sha256: env.sha256,
          }
          this.incoming.set(meta.id, { meta, chunks: new Array(env.n), got: 0, total: env.n })
          this.ev.onFileStart({ meta, progress: 0, status: 'receiving' })
        } else {
          if (typeof wm.i !== 'number' || wm.i < 0) return
          const rec = this.incoming.get(wm.id)
          if (!rec || wm.i >= rec.total) return
          const ad = new TextEncoder().encode(JSON.stringify({ s: sess.recvSeq + 1, id: wm.id, i: wm.i }))
          const chunk = await openRaw(sess.keys.recvKey, data, ad)
          sess.recvSeq++
          rec.chunks[wm.i] = chunk
          rec.got++
          this.ev.onFileProgress(rec.meta.id, rec.got / rec.total)
          if (rec.got === rec.total) {
            this.incoming.delete(rec.meta.id)
            const buf = concatChunks(rec.chunks as Uint8Array[])
            this.ev.onFileDone({ meta: rec.meta, progress: 1, status: 'verifying', data: buf })
            try {
              const hash = await sha256Hex(buf)
              if (hash !== rec.meta.sha256) {
                this.ev.onFileDone({ meta: rec.meta, progress: 1, status: 'failed', error: 'integrity check failed - file corrupted in transit' })
                return
              }
              this.ev.onFileDone({ meta: rec.meta, progress: 1, status: 'done', data: buf })
            } catch {
              this.ev.onFileDone({ meta: rec.meta, progress: 1, status: 'failed', error: 'could not verify integrity' })
            }
          }
        }
      } catch { /* undecryptable or out-of-sequence payload: drop */ }
    }

    this.textAction.onReceive = ({ byteLength, peerId }) => {
      return this.sessions.has(peerId) && byteLength > 0 && byteLength <= MAX_TEXT_CHARS * 6 + 4096
    }
    this.textAction.onMessage = async (data, { peerId }) => {
      const sess = this.sessions.get(peerId)
      const peer = this.peers.get(peerId)
      if (!sess || !peer || typeof data !== 'string') return
      try {
        const m = (await open(sess.keys.recvKey, data)) as { s?: number; t?: string; id?: string; text?: unknown; ts?: number }
        if (m.s !== sess.recvSeq + 1 || m.t !== 'text') return
        sess.recvSeq = m.s
        if (typeof m.text !== 'string' || !m.text || m.text.length > MAX_TEXT_CHARS) return
        this.ev.onText({
          id: String(m.id ?? Math.random()),
          from: peerId,
          name: peer.name,
          text: m.text,
          ts: typeof m.ts === 'number' ? m.ts : Date.now(),
        })
      } catch { /* drop */ }
    }

    this.room.onPeerLeave = (peerId: string) => {
      const role = this.peers.get(peerId)?.role ?? null
      this.peers.delete(peerId)
      this.sessions.delete(peerId)
      if (this.pendingActive?.peerId === peerId) {
        this.pendingActive = null
        this.showNextPending()
      } else if (this.pendingQueue.some(r => r.peerId === peerId)) {
        this.pendingQueue = this.pendingQueue.filter(r => r.peerId !== peerId)
      }
      this.ev.onLeft(peerId, role)
      this.emitPeers()
    }
  }

  private incoming = new Map<string, { meta: FileMeta; chunks: (Uint8Array | undefined)[]; got: number; total: number }>()

  static host(roomCode: string, ev: RoomEvents, name: string) {
    return new ProShareRoom('host', roomCode, ev, name)
  }
  static guest(roomCode: string, ev: RoomEvents, name: string) {
    return new ProShareRoom('guest', roomCode, ev, name)
  }

  private enqueuePending(peerId: string, name: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const req: PendingRequest = {
        peerId,
        name,
        resolve: (approved: boolean) => {
          resolve(approved)
          if (this.pendingActive === req) {
            this.pendingActive = null
            this.showNextPending()
          } else {
            this.pendingQueue = this.pendingQueue.filter(r => r !== req)
          }
        },
      }
      this.pendingQueue.push(req)
      if (!this.pendingActive) this.showNextPending()
    })
  }

  private showNextPending() {
    if (this.pendingActive) return
    this.pendingActive = this.pendingQueue.shift() ?? null
    this.ev.onPending(this.pendingActive)
  }

  private async addPeer(id: string, name: string, role: Role, session: SessionKeys) {
    this.peers.set(id, { id, name, role, code: session.verifyCode, connectedAt: Date.now() })
    this.sessions.set(id, { keys: session, sendSeq: 0, recvSeq: 0 })
    this.emitPeers()
  }

  private emitPeers() {
    this.ev.onPeers([...this.peers.values()])
  }

  approvedPeerIds(): string[] {
    return [...this.peers.values()].filter(p => (this.role === 'host' ? p.role === 'guest' : p.role === 'host')).map(p => p.id)
  }

  async sendFile(peerId: string, file: File, meta: FileMeta, onProgress: (p: number) => void): Promise<void> {
    const sess = this.sessions.get(peerId)
    if (!sess) throw new Error('peer is not approved')
    const buf = new Uint8Array(await file.arrayBuffer())
    const n = Math.max(1, Math.ceil(buf.length / CHUNK_BYTES))
    const sealedMeta = await seal(sess.keys.sendKey, { s: ++sess.sendSeq, t: 'meta', id: meta.id, name: meta.name, size: meta.size, type: meta.type, sha256: meta.sha256, n })
    await this.sendFileAction.send(sealedMeta, { target: peerId, metadata: { id: meta.id, k: 'm' } })
    for (let i = 0; i < n; i++) {
      const seq = sess.sendSeq + 1
      const ad = new TextEncoder().encode(JSON.stringify({ s: seq, id: meta.id, i }))
      const sealed = await sealRaw(sess.keys.sendKey, buf.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), ad)
      sess.sendSeq = seq
      await this.sendFileAction.send(sealed, { target: peerId, metadata: { id: meta.id, k: 'c', i } })
      onProgress((i + 1) / n)
    }
  }

  async sendText(text: string, targets?: string[]): Promise<void> {
    if (text.length > MAX_TEXT_CHARS) throw new Error('message too long')
    const ids = targets && targets.length ? targets : this.approvedPeerIds()
    for (const t of ids) {
      const sess = this.sessions.get(t)
      if (!sess) continue
      const msg = { s: ++sess.sendSeq, t: 'text', id: crypto.randomUUID(), text, ts: Date.now() }
      await this.textAction.send(await seal(sess.keys.sendKey, msg), { target: t })
    }
  }

  leave() {
    this.closed = true
    try { this.room.leave() } catch { /* already gone */ }
    this.peers.clear()
  }
}
