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
import { joinRoom, selfId, getRelaySockets, type MessageAction, type Room } from 'trystero'
import { deriveSessionKeys, exportPub, generateKxPair, open, seal, sha256Hex, type SessionKeys } from './crypto'
import { ContentReceiver, ContentSender, CHUNK_BYTES, chunkCount, MAX_WIRE_BYTES, newGate, type ConfirmGate, type FileMeta } from './transfer'
import { MAX_TEXT_CHARS } from './files'

export type { FileMeta } from './transfer'

export const APP_ID = 'proshare-p2p-v1'

// ICE servers. STUN is always on. TURN (relay fallback for devices on different
// networks, e.g. laptop on Wi-Fi + phone on mobile data) is added only when
// VITE_METERED_APP and VITE_METERED_KEY are set at build time. Relayed bytes
// are still end-to-end encrypted (DTLS + our AEAD layer): the relay sees ciphertext.
export const STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
export async function loadIceServers(): Promise<RTCIceServer[]> {
  const base: RTCIceServer[] = [{ urls: STUN_URLS }]
  const app = import.meta.env.VITE_METERED_APP as string | undefined
  const key = import.meta.env.VITE_METERED_KEY as string | undefined
  if (!app || !key) return base
  try {
    const r = await fetch(`https://${encodeURIComponent(app)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`)
    if (!r.ok) return base
    const list = (await r.json()) as RTCIceServer[]
    return Array.isArray(list) ? [...base, ...list] : base
  } catch { return base }
}
export const turnConfigured = (): boolean => !!(import.meta.env.VITE_METERED_APP && import.meta.env.VITE_METERED_KEY)

// Rendezvous relays. Trystero's default is a fixed shuffle of 5 public relays
// for every app id; on 2 Nov 2026 several of those (stakey rate-limited,
// hackshed/flashapp refused connections) were unhealthy, so everyone shared a
// mostly-dead set. These six accepted connections and relayed an event in a
// simple probe that day (not a rigorous health check). Signaling only - never carries contents.
export const RELAY_URLS = [
  'wss://relay.aarpia.com',
  'wss://nostr.chaima.info',
  'wss://relay.nostr.dev.br',
  'wss://nostrcity-club.fly.dev',
  'wss://nostr.christiansass.de',
  'wss://bendernostur.duckdns.org:8443',
]

export interface Diagnostics { relaysOpen: number; relaysTotal: number; stage: string; error: string | null }
export type Role = 'host' | 'guest'
const PAIR_PREFIX = '\u0001proshare-pair:'
async function pairMac(secretB64: string, a: string, b: string): Promise<string> {
  const raw = Uint8Array.from(atob(secretB64), c => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const msg = new TextEncoder().encode(['proshare-pair-auth-v1', ...[a, b].sort()].join('|'))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
  return btoa(String.fromCharCode(...sig))
}

export interface PeerInfo {
  id: string
  name: string
  role: Role
  code: string // out-of-band verification code for this pairing
  connectedAt: number
  // Mutual confirmation: local = our user pressed the match button,
  // remote = authenticated confirm control received from this peer.
  // Content is sealed/accepted only when both are true.
  localConfirmed: boolean
  remoteConfirmed: boolean
}
export const peerMutual = (p: PeerInfo): boolean => p.localConfirmed && p.remoteConfirmed

export interface PendingRequest {
  peerId: string
  name: string
  resolve: (approved: boolean) => void
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
  // Remote pairing control ("offer:<secret>" or "ok"); only delivered after mutual code confirmation.
  onPair?: (payload: string, peer: PeerInfo) => void
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
  private sessions = new Map<string, { sender: ContentSender; receiver: ContentReceiver; gate: ConfirmGate }>()
  private ev: RoomEvents
  private closed = false
  private nearby = false
  private pairSecret?: string
  private stage = 'looking for the other device'
  private hsError: string | null = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendFileAction: MessageAction<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private textAction: MessageAction<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ctrlAction: MessageAction<any>

  private constructor(role: Role, roomCode: string, ev: RoomEvents, myName: string, iceServers: RTCIceServer[] = [{ urls: STUN_URLS }], opts: { nearby?: boolean; pairSecret?: string } = {}) {
    this.nearby = !!opts.nearby
    this.pairSecret = opts.pairSecret
    this.role = role
    this.roomCode = roomCode
    this.ev = ev

    this.room = joinRoom(
      { appId: APP_ID, maxReceiveBytes: 1024 * 1024 * 1024 + 64 * 1024 * 1024, relayConfig: { urls: RELAY_URLS }, rtcConfig: { iceServers } },
      roomCode,
      {
        handshakeTimeoutMs: 120_000, // a human needs time to approve
        onPeerHandshake: async (peerId, send, receive, isInitiator) => {
          this.stage = 'device found, exchanging keys'
          this.hsError = null
          // 1. Ephemeral ECDH key exchange (fixed order: initiator first).
          const kx = await generateKxPair()
          const myPub = await exportPub(kx)
          if (isInitiator) await send({ t: 'kx', pk: myPub })
          const { data: kxMsg } = await receive()
          if (!isInitiator) await send({ t: 'kx', pk: myPub })
          const remotePk = (kxMsg as { t?: string; pk?: string } | undefined)?.pk
          if ((kxMsg as { t?: string } | undefined)?.t !== 'kx' || typeof remotePk !== 'string') throw new Error('bad handshake')
          // Nearby mode is symmetric: each pair picks roles deterministically from ids.
          const pairRole: Role = this.nearby ? (this.selfId < peerId ? 'host' : 'guest') : role
          const session: SessionKeys = await deriveSessionKeys(kx.privateKey, remotePk, this.selfId, peerId, pairRole)

          // 2. Encrypted hello exchange. A tampered payload fails GCM.
          const hello = { t: 'hello', role: pairRole, name: myName.slice(0, 40) }
          if (isInitiator) await send(await seal(session.hsKey, hello))
          const { data: remote } = await receive()
          if (!isInitiator) await send(await seal(session.hsKey, hello))
          const h = (await open(session.hsKey, remote)) as Partial<typeof hello> | undefined
          if (!h || h.t !== 'hello' || typeof h.name !== 'string') throw new Error('bad handshake')
          if (h.role === pairRole) throw new Error('same-role peers are not allowed')
          const name = String(h.name).slice(0, 40) || 'Guest'
          // Paired rooms: both sides prove knowledge of the pair secret over the exact
          // key exchange, which defeats a man in the middle (including a relay).
          if (this.pairSecret) {
            const mine = await pairMac(this.pairSecret, myPub, remotePk)
            if (isInitiator) await send({ t: 'pa', m: mine })
            const { data: pa } = await receive()
            if (!isInitiator) await send({ t: 'pa', m: mine })
            if ((pa as { m?: string } | undefined)?.m !== mine) throw new Error('pair authentication failed')
          }
          this.stage = pairRole === 'host' ? 'request received' : 'request delivered, waiting for approval'

          if (pairRole === 'host') {
            // A peer the host rejected keeps retrying at the relay level;
            // auto-reject repeats this session without re-prompting the human.
            if (this.rejected.has(peerId)) {
              await send(await seal(session.hsKey, { t: 'reject' })).catch(() => {})
              throw new Error('previously declined')
            }
            // Host decides. Ask the human. Requests are queued so two
            // simultaneous joiners never overwrite each other's prompt.
            // Nearby: no join prompt. Safety is the per-pair code match, which gates all content.
            const approved = this.nearby ? true : await this.enqueuePending(peerId, name)
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
          if (this.pairSecret) {
            // Both sides have registered the session; now confirm automatically.
            if (isInitiator) await send({ t: 'ready' })
            await receive()
            if (!isInitiator) await send({ t: 'ready' })
            setTimeout(() => { this.confirmPeer(peerId).catch(() => {}) }, 300)
          }
        },
        onJoinError: ({ error }) => {
          if (!this.closed) this.ev.onJoinError(String(error ?? 'connection failed'))
        },
      },
    )

    this.sendFileAction = this.room.makeAction('file')
    this.textAction = this.room.makeAction('text')
    this.ctrlAction = this.room.makeAction('ctrl')

    // Every content payload is AEAD-sealed under the pair's ECDH session key
    // (see transfer.ts): direction-separated keys, strict sequencing, all
    // metadata inside the envelope. A relay or active MITM without the session
    // key can drop messages but cannot read, alter, or forge them - and
    // dropping breaks the sequence, failing the transfer loudly.
    this.ctrlAction.onReceive = ({ byteLength, peerId }) => {
      return this.sessions.has(peerId) && typeof byteLength === 'number' && byteLength > 0 && byteLength <= 8192
    }
    this.ctrlAction.onMessage = async (data, { peerId }) => {
      const sess = this.sessions.get(peerId)
      if (!sess) return
      for (const ev of await sess.receiver.acceptControl(data)) {
        if (ev.type === 'confirm') {
          const peer = this.peers.get(peerId)
          if (peer) { peer.remoteConfirmed = true; this.emitPeers() }
        }
      }
    }

    this.sendFileAction.onReceive = ({ byteLength, peerId }) => {
      if (!this.sessions.has(peerId)) return false
      return typeof byteLength === 'number' && byteLength > 0 && byteLength <= MAX_WIRE_BYTES
    }
    this.sendFileAction.onMessage = async (data, { peerId, metadata }) => {
      const sess = this.sessions.get(peerId)
      if (!sess) return
      for (const ev of await sess.receiver.acceptFileMessage(data, metadata as Record<string, unknown>)) {
        if (ev.type === 'start') this.ev.onFileStart({ meta: ev.meta, progress: 0, status: 'receiving' })
        else if (ev.type === 'progress') this.ev.onFileProgress(ev.id, ev.progress)
        else if (ev.type === 'file') {
          this.ev.onFileDone({ meta: ev.meta, progress: 1, status: 'verifying', data: ev.data })
          try {
            const hash = await sha256Hex(ev.data)
            if (hash !== ev.meta.sha256) {
              this.ev.onFileDone({ meta: ev.meta, progress: 1, status: 'failed', error: 'integrity check failed - file corrupted in transit' })
              continue
            }
            this.ev.onFileDone({ meta: ev.meta, progress: 1, status: 'done', data: ev.data })
          } catch {
            this.ev.onFileDone({ meta: ev.meta, progress: 1, status: 'failed', error: 'could not verify integrity' })
          }
        }
      }
    }

    this.textAction.onReceive = ({ byteLength, peerId }) => {
      return this.sessions.has(peerId) && byteLength > 0 && byteLength <= MAX_TEXT_CHARS * 6 + 4096
    }
    this.textAction.onMessage = async (data, { peerId }) => {
      const sess = this.sessions.get(peerId)
      const peer = this.peers.get(peerId)
      if (!sess || !peer) return
      for (const ev of await sess.receiver.acceptText(data)) {
        if (ev.type === 'text' && ev.text.startsWith(PAIR_PREFIX)) {
          const peerNow = this.peers.get(peerId)
          if (peerNow && peerMutual(peerNow) && !this.pairSecret) this.ev.onPair?.(ev.text.slice(PAIR_PREFIX.length), peerNow)
          continue
        }
        if (ev.type === 'text') this.ev.onText({ id: ev.id || String(Math.random()), from: peerId, name: peer.name, text: ev.text, ts: ev.ts })
      }
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

  diagnostics(): Diagnostics {
    let open = 0
    let total = RELAY_URLS.length
    try {
      const socks = Object.values(getRelaySockets() as Record<string, { readyState?: number }>)
      total = RELAY_URLS.length
      open = socks.filter(x => x && x.readyState === 1).length
    } catch { /* diagnostics only */ }
    return { relaysOpen: open, relaysTotal: total, stage: this.stage, error: this.hsError }
  }

  static host(roomCode: string, ev: RoomEvents, name: string, ice?: RTCIceServer[]) {
    return new ProShareRoom('host', roomCode, ev, name, ice)
  }
  static guest(roomCode: string, ev: RoomEvents, name: string, ice?: RTCIceServer[]) {
    return new ProShareRoom('guest', roomCode, ev, name, ice)
  }
  // Auto-discovery room: every device on the same public IP joins the same room.
  static nearby(roomName: string, ev: RoomEvents, name: string, ice?: RTCIceServer[]) {
    return new ProShareRoom('host', roomName, ev, name, ice, { nearby: true })
  }
  // A room only paired devices know: room name and handshake auth derive from a shared secret.
  static paired(roomName: string, secret: string, ev: RoomEvents, name: string, ice?: RTCIceServer[]) {
    return new ProShareRoom('host', roomName, ev, name, ice, { nearby: true, pairSecret: secret })
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
    this.peers.set(id, { id, name, role, code: session.verifyCode, connectedAt: Date.now(), localConfirmed: false, remoteConfirmed: false })
    const gate = newGate()
    this.sessions.set(id, { sender: new ContentSender(session, gate), receiver: new ContentReceiver(session, gate), gate })
    this.emitPeers()
  }

  // The local user confirmed the verification code for this peer. Marks the
  // local half of the gate and sends the authenticated confirm control; the
  // peer's matching control completes mutual confirmation. Content stays
  // blocked at the protocol layer until both halves are set.
  async confirmPeer(peerId: string): Promise<void> {
    const sess = this.sessions.get(peerId)
    const peer = this.peers.get(peerId)
    if (!sess || !peer || peer.localConfirmed) return
    const data = await sess.sender.sealConfirm()
    peer.localConfirmed = true
    this.emitPeers()
    await this.ctrlAction.send(data, { target: peerId })
  }

  private emitPeers() {
    this.ev.onPeers([...this.peers.values()])
  }

  approvedPeerIds(): string[] {
    return [...this.peers.values()].filter(p => this.nearby || (this.role === 'host' ? p.role === 'guest' : p.role === 'host')).map(p => p.id)
  }

  async sendFile(peerId: string, file: File, meta: FileMeta, onProgress: (p: number) => void): Promise<void> {
    const sess = this.sessions.get(peerId)
    if (!sess) throw new Error('peer is not approved')
    if (!(sess.gate.local && sess.gate.remote)) throw new Error('both sides must confirm the verification code before anything is sent')
    const buf = new Uint8Array(await file.arrayBuffer())
    const n = chunkCount(buf.length)
    const m = await sess.sender.sealFileMeta(meta, n)
    await this.sendFileAction.send(m.data, { target: peerId, metadata: m.wire })
    for (let i = 0; i < n; i++) {
      const c = await sess.sender.sealChunk(meta.id, i, buf.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES))
      await this.sendFileAction.send(c.data, { target: peerId, metadata: c.wire })
      onProgress((i + 1) / n)
    }
  }

  async sendText(text: string, targets?: string[]): Promise<void> {
    if (text.length > MAX_TEXT_CHARS) throw new Error('message too long')
    const ids = targets && targets.length ? targets : this.approvedPeerIds()
    for (const t of ids) {
      const sess = this.sessions.get(t)
      if (!sess) continue
      if (!(sess.gate.local && sess.gate.remote)) throw new Error('both sides must confirm the verification code before anything is sent')
      await this.textAction.send(await sess.sender.sealText(crypto.randomUUID(), text, Date.now()), { target: t })
    }
  }

  // Send a pairing control message (sealed like any content, only after code confirmation).
  async sendPair(peerId: string, payload: string): Promise<void> {
    const sess = this.sessions.get(peerId)
    if (!sess || !(sess.gate.local && sess.gate.remote)) throw new Error('confirm the verification code first')
    await this.textAction.send(await sess.sender.sealText(crypto.randomUUID(), PAIR_PREFIX + payload, Date.now()), { target: peerId })
  }

  leave() {
    this.closed = true
    try { this.room.leave() } catch { /* already gone */ }
    this.peers.clear()
  }
}
