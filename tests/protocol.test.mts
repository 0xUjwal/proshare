// Executed tests for the content-transfer protocol (ECDH + AEAD + sequencing
// + mutual-confirmation gate).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSessionKeys, exportPub, generateKxPair, seal, b64ToBytes } from '../src/lib/crypto.ts'
import { ContentSender, ContentReceiver, CHUNK_BYTES, MAX_WIRE_BYTES, chunkCount, newGate, type ConfirmGate } from '../src/lib/transfer.ts'
import { sha256Hex } from '../src/lib/crypto.ts'

interface Session {
  hs: ContentSender; hr: ContentReceiver // host side
  gs: ContentSender; gr: ContentReceiver // guest side
  hostGate: ConfirmGate; guestGate: ConfirmGate
  hostCode: string; guestCode: string
}

async function makePair() {
  const a = await generateKxPair()
  const b = await generateKxPair()
  const aPub = await exportPub(a)
  const bPub = await exportPub(b)
  const host = await deriveSessionKeys(a.privateKey, bPub, 'host-id', 'guest-id', 'host')
  const guest = await deriveSessionKeys(b.privateKey, aPub, 'guest-id', 'host-id', 'guest')
  return { host, guest }
}

async function makeSession(): Promise<Session> {
  const { host, guest } = await makePair()
  const hostGate = newGate()
  const guestGate = newGate()
  return {
    hs: new ContentSender(host, hostGate), hr: new ContentReceiver(host, hostGate),
    gs: new ContentSender(guest, guestGate), gr: new ContentReceiver(guest, guestGate),
    hostGate, guestGate, hostCode: host.verifyCode, guestCode: guest.verifyCode,
  }
}

// Exchange the authenticated confirm control messages exactly as the app does.
async function confirmBoth(s: Session) {
  const hc = await s.hs.sealConfirm()
  assert.deepEqual(await s.gr.acceptControl(hc), [{ type: 'confirm' }])
  const gc = await s.gs.sealConfirm()
  assert.deepEqual(await s.hr.acceptControl(gc), [{ type: 'confirm' }])
  assert.ok(s.hostGate.local && s.hostGate.remote && s.guestGate.local && s.guestGate.remote)
}

function meta(id = 'f1', size = 100) {
  return { id, name: 'x.bin', size, type: 'application/octet-stream', sha256: 'abc' }
}

test('ECDH agreement: both sides derive matching verification codes', async () => {
  const { host, guest } = await makePair()
  assert.equal(host.verifyCode, guest.verifyCode)
})

test('confirm exchange: mutual confirmation completes both gates, bound to session code', async () => {
  const s = await makeSession()
  assert.ok(!(s.hostGate.local || s.hostGate.remote || s.guestGate.local || s.guestGate.remote))
  await confirmBoth(s)
})

test('sender refuses to seal any content before mutual confirmation', async () => {
  const s = await makeSession()
  // neither side confirmed
  await assert.rejects(() => s.hs.sealFileMeta(meta(), 1), /both sides must confirm/)
  await assert.rejects(() => s.hs.sealText('m', 'hi', 1))
  await assert.rejects(() => s.hs.sealChunk('f', 0, new Uint8Array(4)))
  // local user confirmed, peer has not: still blocked
  await s.hs.sealConfirm()
  await assert.rejects(() => s.hs.sealFileMeta(meta(), 1), /both sides must confirm/)
  await assert.rejects(() => s.hs.sealText('m', 'hi', 1))
  // peer confirm arrives: unblocked
  const gc = await s.gs.sealConfirm()
  await s.hr.acceptControl(gc)
  const m = await s.hs.sealFileMeta(meta(), 1)
  assert.ok(m.data.length > 0)
})

test('receiver drops content arriving before LOCAL confirmation, even from a malicious peer that ignores the gate', async () => {
  const s = await makeSession()
  await confirmBoth(s) // legitimate state for reference
  // fresh session where the receiver's user has NOT confirmed, but the sender
  // is malicious/buggy and force-opens its own gate
  const t = await makeSession()
  t.hostGate.local = true
  t.hostGate.remote = true // forged local state - the peer never really confirmed
  const m = await t.hs.sealFileMeta(meta(), 1)
  const c = await t.hs.sealChunk('f1', 0, new Uint8Array(100).fill(9))
  // receiver side: user never pressed the button
  assert.deepEqual(await t.gr.acceptFileMessage(m.data, m.wire), [{ type: 'drop' }])
  assert.deepEqual(await t.gr.acceptFileMessage(c.data, c.wire), [{ type: 'drop' }])
  const sealedText = await t.hs.sealText('m1', 'early text', 1)
  assert.deepEqual(await t.gr.acceptText(sealedText), [{ type: 'drop' }])
  // nothing surfaced: no start, no text, no file event reached the app.
  // Even after the local user confirms, the gate is not mutual until an
  // authenticated confirm from the peer arrives - which this malicious peer
  // never sent (it skipped straight to content).
  t.guestGate.local = true
  assert.ok(!(t.guestGate.local && t.guestGate.remote))
})

test('confirm control is authenticated: tampered, wrong-code, transplanted and replayed confirms are dropped', async () => {
  const s = await makeSession()
  const good = await s.hs.sealConfirm()
  // tampered ciphertext
  const raw = b64ToBytes(good)
  raw[raw.length - 1] ^= 1
  assert.deepEqual(await s.gr.acceptControl(Buffer.from(raw).toString('base64')), [{ type: 'drop' }])
  // wrong code sealed by the real peer key (simulates cross-session transplant of payload)
  const wrong = await seal((s.hs as unknown as { keys: { sendKey: CryptoKey } }).keys.sendKey, { s: 2, t: 'confirm', v: '000 000' })
  assert.deepEqual(await s.gr.acceptControl(wrong), [{ type: 'drop' }])
  // valid confirm now lands
  assert.deepEqual(await s.gr.acceptControl(good), [{ type: 'confirm' }])
  // replay of the same confirm is dropped (sequence already consumed)
  assert.deepEqual(await s.gr.acceptControl(good), [{ type: 'drop' }])
  // confirm from a DIFFERENT session cannot be opened at all
  const other = await makeSession()
  const foreign = await other.hs.sealConfirm()
  const s2 = await makeSession()
  assert.deepEqual(await s2.gr.acceptControl(foreign), [{ type: 'drop' }])
})

test('direction separation: host sendKey opens on guest recvKey, fails under wrong-direction key', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const m = await s.hs.sealFileMeta(meta(), 1)
  const ev = await s.gr.acceptFileMessage(m.data, m.wire)
  assert.equal(ev[0].type, 'start')
  // Same session, but the receiver's opening key replaced by the opposite
  // direction's key: the exact same session secrets, wrong direction. Fails.
  const guestKeys = (s.gr as unknown as { keys: { sendKey: CryptoKey; recvKey: CryptoKey; verifyCode: string; hsKey: CryptoKey } }).keys
  const wrongDir = new ContentReceiver({ ...guestKeys, recvKey: guestKeys.sendKey }, newGate())
  ;(wrongDir as unknown as { gate: ConfirmGate }).gate = { local: true, remote: true }
  const ev2 = await wrongDir.acceptFileMessage(m.data, m.wire)
  assert.equal(ev2[0].type, 'drop')
})

test('tampered ciphertext is dropped', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const m = await s.hs.sealFileMeta(meta(), 1)
  const raw = b64ToBytes(m.data)
  raw[raw.length - 1] ^= 1
  const tampered = Buffer.from(raw).toString('base64')
  const ev = await s.gr.acceptFileMessage(tampered, m.wire)
  assert.equal(ev[0].type, 'drop')
})

test('tampered wire metadata (chunk index) is dropped', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const m = await s.hs.sealFileMeta(meta(), 2)
  await s.gr.acceptFileMessage(m.data, m.wire)
  const c0 = await s.hs.sealChunk('f1', 0, new Uint8Array(10).fill(1))
  // replay chunk 0's ciphertext as if it were chunk 1
  const ev = await s.gr.acceptFileMessage(c0.data, { id: 'f1', k: 'c', i: 1 })
  assert.equal(ev[0].type, 'drop')
})

test('replay of an accepted message is dropped', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const m = await s.hs.sealFileMeta(meta(), 1)
  assert.equal((await s.gr.acceptFileMessage(m.data, m.wire))[0].type, 'start')
  assert.equal((await s.gr.acceptFileMessage(m.data, m.wire))[0].type, 'drop') // replayed meta
})

test('reordered chunks (sequence skip) are dropped', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const m = await s.hs.sealFileMeta(meta(), 2)
  await s.gr.acceptFileMessage(m.data, m.wire)
  const c0 = await s.hs.sealChunk('f1', 0, new Uint8Array(10).fill(1))
  const c1 = await s.hs.sealChunk('f1', 1, new Uint8Array(10).fill(2))
  // deliver chunk 1 before chunk 0
  assert.equal((await s.gr.acceptFileMessage(c1.data, c1.wire))[0].type, 'drop')
  // receiver sequence unchanged: proper order still accepted
  assert.equal((await s.gr.acceptFileMessage(c0.data, c0.wire))[0].type, 'progress')
  const done = await s.gr.acceptFileMessage(c1.data, c1.wire)
  assert.equal(done.at(-1)!.type, 'file')
})

test('full file roundtrip reassembles identical bytes', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const payload = new Uint8Array(CHUNK_BYTES + 12345) // 2 chunks
  for (let off = 0; off < payload.length; off += 65536) crypto.getRandomValues(payload.subarray(off, off + 65536))
  const sha = await sha256Hex(payload)
  const m = await s.hs.sealFileMeta({ id: 'big', name: 'big.bin', size: payload.length, type: 'application/octet-stream', sha256: sha }, chunkCount(payload.length))
  assert.equal((await s.gr.acceptFileMessage(m.data, m.wire))[0].type, 'start')
  let final
  for (let i = 0; i < chunkCount(payload.length); i++) {
    const c = await s.hs.sealChunk('big', i, payload.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES))
    final = (await s.gr.acceptFileMessage(c.data, c.wire)).at(-1)
  }
  assert.equal(final!.type, 'file')
  if (final!.type === 'file') {
    assert.equal(final!.meta.sha256, sha)
    assert.deepEqual(new Uint8Array(final!.data), payload)
  }
})

test('text roundtrip + oversized text dropped', async () => {
  const s = await makeSession()
  await confirmBoth(s)
  const sealed = await s.hs.sealText('m1', 'hello', 123)
  const ev = await s.gr.acceptText(sealed)
  assert.equal(ev[0].type, 'text')
  // forged oversize: seal a validly-keyed but over-limit message (defense in depth inside envelope)
  const big = await s.hs.sealText('m2', 'x'.repeat(21000), 124)
  assert.equal((await s.gr.acceptText(big))[0].type, 'drop')
})

test('nonces are unique across many messages and transfers', async () => {
  const s = await makeSession()
  s.hostGate.local = true
  s.hostGate.remote = true
  const ivs = new Set<string>()
  for (let i = 0; i < 600; i++) {
    const t = await s.hs.sealText(`m${i}`, 'x', i)
    ivs.add(t.slice(0, 16)) // base64 of 12-byte IV
    const c = await s.hs.sealChunk('f', i, new Uint8Array(4))
    ivs.add(c.data.slice(0, 16))
  }
  assert.equal(ivs.size, 1200)
})

test('reconnect (fresh handshake) yields fresh keys; old ciphertext unreadable', async () => {
  const first = await makeSession()
  const second = await makeSession()
  assert.notEqual(first.hostCode, second.hostCode) // overwhelming probability
  await confirmBoth(first)
  await confirmBoth(second)
  const sealed = await first.hs.sealText('m', 'secret', 1)
  assert.equal((await second.gr.acceptText(sealed))[0].type, 'drop')
})

test('wire cap admits a sealed full chunk', async () => {
  const s = await makeSession()
  s.hostGate.local = true
  s.hostGate.remote = true
  const c = await s.hs.sealChunk('f', 0, new Uint8Array(CHUNK_BYTES).fill(7))
  assert.ok(c.data.length <= MAX_WIRE_BYTES, `${c.data.length} > ${MAX_WIRE_BYTES}`)
})
