// Executed tests for the content-transfer protocol (ECDH + AEAD + sequencing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSessionKeys, exportPub, generateKxPair, seal, b64ToBytes } from '../src/lib/crypto.ts'
import { ContentSender, ContentReceiver, CHUNK_BYTES, MAX_WIRE_BYTES, chunkCount } from '../src/lib/transfer.ts'
import { sha256Hex } from '../src/lib/crypto.ts'

async function makePair() {
  const a = await generateKxPair()
  const b = await generateKxPair()
  const aPub = await exportPub(a)
  const bPub = await exportPub(b)
  const host = await deriveSessionKeys(a.privateKey, bPub, 'host-id', 'guest-id', 'host')
  const guest = await deriveSessionKeys(b.privateKey, aPub, 'guest-id', 'host-id', 'guest')
  return { host, guest }
}

function meta(id = 'f1', size = 100) {
  return { id, name: 'x.bin', size, type: 'application/octet-stream', sha256: 'abc' }
}

test('ECDH agreement: both sides derive matching verification codes', async () => {
  const { host, guest } = await makePair()
  assert.equal(host.verifyCode, guest.verifyCode)
})

test('direction separation: host sendKey opens on guest recvKey, fails under wrong-direction key', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const m = await hs.sealFileMeta(meta(), 1)
  const ev = await gr.acceptFileMessage(m.data, m.wire)
  assert.equal(ev[0].type, 'start')
  // A receiver holding only the guest SEND key (same direction as host->guest traffic is not) must fail.
  const wrongDir = new ContentReceiver({ ...guest, recvKey: guest.sendKey })
  const ev2 = await wrongDir.acceptFileMessage(m.data, m.wire)
  assert.equal(ev2[0].type, 'drop')
})

test('tampered ciphertext is dropped', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const m = await hs.sealFileMeta(meta(), 1)
  const raw = b64ToBytes(m.data)
  raw[raw.length - 1] ^= 1
  const tampered = Buffer.from(raw).toString('base64')
  const ev = await gr.acceptFileMessage(tampered, m.wire)
  assert.equal(ev[0].type, 'drop')
})

test('tampered wire metadata (chunk index) is dropped', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const m = await hs.sealFileMeta(meta(), 2)
  await gr.acceptFileMessage(m.data, m.wire)
  const c0 = await hs.sealChunk('f1', 0, new Uint8Array(10).fill(1))
  // replay chunk 0's ciphertext as if it were chunk 1
  const ev = await gr.acceptFileMessage(c0.data, { id: 'f1', k: 'c', i: 1 })
  assert.equal(ev[0].type, 'drop')
})

test('replay of an accepted message is dropped', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const m = await hs.sealFileMeta(meta(), 1)
  assert.equal((await gr.acceptFileMessage(m.data, m.wire))[0].type, 'start')
  assert.equal((await gr.acceptFileMessage(m.data, m.wire))[0].type, 'drop') // replayed meta
})

test('reordered chunks (sequence skip) are dropped', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const m = await hs.sealFileMeta(meta(), 2)
  await gr.acceptFileMessage(m.data, m.wire)
  const c0 = await hs.sealChunk('f1', 0, new Uint8Array(10).fill(1))
  const c1 = await hs.sealChunk('f1', 1, new Uint8Array(10).fill(2))
  // deliver chunk 1 before chunk 0
  assert.equal((await gr.acceptFileMessage(c1.data, c1.wire))[0].type, 'drop')
  // receiver sequence unchanged: proper order still accepted
  assert.equal((await gr.acceptFileMessage(c0.data, c0.wire))[0].type, 'progress')
  const done = await gr.acceptFileMessage(c1.data, c1.wire)
  assert.equal(done.at(-1)!.type, 'file')
})

test('full file roundtrip reassembles identical bytes', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const payload = new Uint8Array(CHUNK_BYTES + 12345) // 2 chunks
  for (let off = 0; off < payload.length; off += 65536) crypto.getRandomValues(payload.subarray(off, off + 65536))
  const sha = await sha256Hex(payload)
  const m = await hs.sealFileMeta({ id: 'big', name: 'big.bin', size: payload.length, type: 'application/octet-stream', sha256: sha }, chunkCount(payload.length))
  assert.equal((await gr.acceptFileMessage(m.data, m.wire))[0].type, 'start')
  let final
  for (let i = 0; i < chunkCount(payload.length); i++) {
    const c = await hs.sealChunk('big', i, payload.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES))
    final = (await gr.acceptFileMessage(c.data, c.wire)).at(-1)
  }
  assert.equal(final!.type, 'file')
  if (final!.type === 'file') {
    assert.equal(final!.meta.sha256, sha)
    assert.deepEqual(new Uint8Array(final!.data), payload)
  }
})

test('text roundtrip + oversized text dropped', async () => {
  const { host, guest } = await makePair()
  const hs = new ContentSender(host)
  const gr = new ContentReceiver(guest)
  const sealed = await hs.sealText('m1', 'hello', 123)
  const ev = await gr.acceptText(sealed)
  assert.equal(ev[0].type, 'text')
  // forged oversize: seal a validly-keyed but over-limit message (defense in depth inside envelope)
  const big = await hs.sealText('m2', 'x'.repeat(21000), 124)
  assert.equal((await gr.acceptText(big))[0].type, 'drop')
})

test('nonces are unique across many messages and transfers', async () => {
  const { host } = await makePair()
  const hs = new ContentSender(host)
  const ivs = new Set<string>()
  for (let i = 0; i < 600; i++) {
    const t = await hs.sealText(`m${i}`, 'x', i)
    ivs.add(t.slice(0, 16)) // base64 of 12-byte IV
    const c = await hs.sealChunk('f', i, new Uint8Array(4))
    ivs.add(c.data.slice(0, 16))
  }
  assert.equal(ivs.size, 1200)
})

test('reconnect (fresh handshake) yields fresh keys; old ciphertext unreadable', async () => {
  const first = await makePair()
  const second = await makePair()
  assert.notEqual(first.host.verifyCode, second.host.verifyCode) // overwhelming probability
  const hs1 = new ContentSender(first.host)
  const sealed = await hs1.sealText('m', 'secret', 1)
  const gr2 = new ContentReceiver(second.guest)
  assert.equal((await gr2.acceptText(sealed))[0].type, 'drop')
})

test('wire cap admits a sealed full chunk', async () => {
  const { host } = await makePair()
  const hs = new ContentSender(host)
  const c = await hs.sealChunk('f', 0, new Uint8Array(CHUNK_BYTES).fill(7))
  assert.ok(c.data.length <= MAX_WIRE_BYTES, `${c.data.length} > ${MAX_WIRE_BYTES}`)
})
