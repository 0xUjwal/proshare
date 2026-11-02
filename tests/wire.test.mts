import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_WIRE_BYTES } from '../src/lib/transfer.ts'

test('wire cap admits a full base64-sealed chunk', () => {
  const CHUNK = 256 * 1024
  const sealedLen = Math.ceil((12 + CHUNK + 16) / 3) * 4 // iv + data + gcm tag, base64
  assert.ok(MAX_WIRE_BYTES >= sealedLen, `${MAX_WIRE_BYTES} < ${sealedLen}`)
})
