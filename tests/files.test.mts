import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFilename, formatBytes, MAX_FILE_BYTES, MAX_TEXT_CHARS } from '../src/lib/files.ts'

test('filename traversal is stripped', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFilename('..\\..\\win\\system32\\x.dll'), 'x.dll')
  assert.equal(sanitizeFilename('/abs/path/report.pdf'), 'report.pdf')
})
test('dotfiles and empty names fall back', () => {
  assert.equal(sanitizeFilename('..'), 'file')
  assert.equal(sanitizeFilename('.'), 'file')
  assert.equal(sanitizeFilename(''), 'file')
  assert.equal(sanitizeFilename('   '), 'file')
  assert.equal(sanitizeFilename(null), 'file')
  assert.equal(sanitizeFilename(42), 'file')
})
test('control chars and unsafe chars removed', () => {
  assert.equal(sanitizeFilename('a\x00b\x1fc.txt'), 'abc.txt')
  assert.equal(sanitizeFilename('a<b>|c?.txt'), 'abc.txt')
  assert.equal(sanitizeFilename('quote"name*.zip'), 'quotename.zip')
})
test('long names are capped with extension preserved', () => {
  const long = 'x'.repeat(200) + '.pdf'
  const out = sanitizeFilename(long)
  assert.ok(out.length <= 120)
  assert.ok(out.endsWith('.pdf'))
})
test('size limits are as documented', () => {
  assert.equal(MAX_FILE_BYTES, 1024 * 1024 * 1024)
  assert.equal(MAX_TEXT_CHARS, 20_000)
  assert.equal(formatBytes(MAX_FILE_BYTES), '1.00 GB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.00 MB')
})
