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
import { deriveSessionKeys, exportPub, generateKxPair, open, seal, sha256Hex, type SessionKeys } from './crypto'
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, sanitizeFilename } from './files'

export const APP_ID = 'proshare-p2p-v1'
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

export class ProShareRoom {
  readonly role: Role
  readonly roomCode: string
  readonly selfId = selfId
  private room: Room
  private peers = new Map<string, PeerInfo>()
  private rejected = new Set<string>()
  private pendingQueue: PendingRequest[] = []
  private pendingActive: PendingRequest | null = null
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
          const session: SessionKeys = await deriveSessionKeys(kx.privateKey, remotePk, this.selfId, peerId)

          // 2. Encrypted hello exchange. A tampered payload fails GCM.
          const hello = { t: 'hello', role, name: myName.slice(0, 40) }
          if (isInitiator) await send(await seal(session.encKey, hello))
          const { data: remote } = await receive()
          if (!isInitiator) await send(await seal(session.encKey, hello))
          const h = (await open(session.encKey, remote)) as Partial<typeof hello> | undefined
          if (!h || h.t !== 'hello' || typeof h.name !== 'string') throw new Error('bad handshake')
          if (h.role === role) throw new Error('same-role peers are not allowed')
          const name = String(h.name).slice(0, 40) || 'Guest'

          if (role === 'host') {
            // A peer the host rejected keeps retrying at the relay level;
            // auto-reject repeats this session without re-prompting the human.
            if (this.rejected.has(peerId)) {
              await send(await seal(session.encKey, { t: 'reject' })).catch(() => {})
              throw new Error('previously declined')
            }
            // Host decides. Ask the human. Requests are queued so two
            // simultaneous joiners never overwrite each other's prompt.
            const approved = await this.enqueuePending(peerId, name)
            await send(await seal(session.encKey, { t: approved ? 'accept' : 'reject' }))
            if (!approved) {
              this.rejected.add(peerId)
              throw new Error('declined by host')
            }
            await this.addPeer(peerId, name, 'guest', session.verifyCode)
          } else {
            const { data: verdict } = await receive()
            const v = (await open(session.encKey, verdict)) as { t?: string } | undefined
            if (v?.t !== 'accept') throw new Error('declined by host')
            await this.addPeer(peerId, name, 'host', session.verifyCode)
          }
        },
        onJoinError: ({ error }) => {
          if (!this.closed) this.ev.onJoinError(String(error ?? 'connection failed'))
        },
      },
    )

    this.sendFileAction = this.room.makeAction('file')
    this.textAction = this.room.makeAction('text')

    this.sendFileAction.onReceive = async ({ byteLength, peerId, metadata }) => {
      // Defense in depth: only approved peers, sane metadata, within size cap.
      const peer = this.peers.get(peerId)
      if (!peer || peer.role !== 'host') return false
      if (typeof byteLength !== 'number' || byteLength < 0 || byteLength > MAX_FILE_BYTES) return false
      const m = metadata as Partial<FileMeta> | undefined
      if (!m || typeof m.id !== 'string' || typeof m.sha256 !== 'string' || m.size !== byteLength) return false
      const meta: FileMeta = {
        id: String(m.id).slice(0, 40),
        name: sanitizeFilename(m.name),
        size: byteLength,
        type: typeof m.type === 'string' ? m.type.slice(0, 120) : 'application/octet-stream',
        sha256: m.sha256,
      }
      this.ev.onFileStart({ meta, progress: 0, status: 'receiving' })
      this.pendingMeta.set(m.id, meta)
      return true
    }
    this.sendFileAction.onReceiveProgress = (progress, { metadata }) => {
      const m = metadata as Partial<FileMeta> | undefined
      if (m?.id) this.ev.onFileProgress(String(m.id), progress)
    }
    this.sendFileAction.onMessage = async (data, { metadata }) => {
      const m = metadata as Partial<FileMeta> | undefined
      const meta = m?.id ? this.pendingMeta.get(String(m.id)) : undefined
      if (!meta) return
      this.pendingMeta.delete(meta.id)
      const buf = data instanceof ArrayBuffer ? data : (data as Uint8Array).buffer as ArrayBuffer
      this.ev.onFileProgress(meta.id, 1)
      this.ev.onFileDone({ meta, progress: 1, status: 'verifying', data: buf })
      try {
        const hash = await sha256Hex(buf)
        if (hash !== meta.sha256) {
          this.ev.onFileDone({ meta, progress: 1, status: 'failed', error: 'integrity check failed - file corrupted in transit' })
          return
        }
        this.ev.onFileDone({ meta, progress: 1, status: 'done', data: buf })
      } catch {
        this.ev.onFileDone({ meta, progress: 1, status: 'failed', error: 'could not verify integrity' })
      }
    }

    this.textAction.onReceive = ({ byteLength, peerId }) => {
      const peer = this.peers.get(peerId)
      return !!peer && byteLength > 0 && byteLength <= MAX_TEXT_CHARS * 4
    }
    this.textAction.onMessage = (data, { peerId }) => {
      const peer = this.peers.get(peerId)
      if (!peer || typeof data !== 'object' || data === null) return
      const m = data as Partial<ChatMsg>
      if (typeof m.text !== 'string' || !m.text || m.text.length > MAX_TEXT_CHARS) return
      this.ev.onText({
        id: String(m.id ?? Math.random()),
        from: peerId,
        name: peer.name,
        text: m.text,
        ts: typeof m.ts === 'number' ? m.ts : Date.now(),
      })
    }

    this.room.onPeerLeave = (peerId: string) => {
      const role = this.peers.get(peerId)?.role ?? null
      this.peers.delete(peerId)
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

  private pendingMeta = new Map<string, FileMeta>()

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

  private async addPeer(id: string, name: string, role: Role, code: string) {
    this.peers.set(id, { id, name, role, code, connectedAt: Date.now() })
    this.emitPeers()
  }

  private emitPeers() {
    this.ev.onPeers([...this.peers.values()])
  }

  approvedPeerIds(): string[] {
    return [...this.peers.values()].filter(p => (this.role === 'host' ? p.role === 'guest' : p.role === 'host')).map(p => p.id)
  }

  async sendFile(peerId: string, file: File, meta: FileMeta, onProgress: (p: number) => void): Promise<void> {
    if (!this.peers.has(peerId)) throw new Error('peer is not approved')
    const buf = await file.arrayBuffer()
    await this.sendFileAction.send(buf, {
      target: peerId,
      metadata: meta,
      onProgress: p => onProgress(p),
    })
  }

  async sendText(text: string): Promise<void> {
    if (text.length > MAX_TEXT_CHARS) throw new Error('message too long')
    await this.textAction.send({ id: crypto.randomUUID(), text, ts: Date.now() })
  }

  leave() {
    this.closed = true
    try { this.room.leave() } catch { /* already gone */ }
    this.peers.clear()
  }
}
