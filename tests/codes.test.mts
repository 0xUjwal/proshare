import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoCode, formatCode, isValidCode, normalizeCode, weakCodeWarning } from '../src/lib/codes.ts'

test('autoCode is always 6 digits', () => {
  for (let i = 0; i < 200; i++) assert.match(autoCode(), /^\d{6}$/)
})

test('normalizeCode lowercases, trims, collapses spaces, strips unsafe chars', () => {
  assert.equal(normalizeCode('  Family   Photos 7 '), 'family photos 7')
  assert.equal(normalizeCode('AB$%^CD'), 'abcd')
  assert.equal(normalizeCode('482 916'), '482 916')
})

test('isValidCode accepts 6-digit and sane custom codes', () => {
  assert.ok(isValidCode('482916'))
  assert.ok(isValidCode('family-photos-7'))
  assert.ok(isValidCode('my room 7'))
  assert.ok(!isValidCode('ab'))            // too short
  assert.ok(!isValidCode('-lead'))         // leading dash
  assert.ok(!isValidCode('trail-'))        // trailing dash
  assert.ok(!isValidCode('x'.repeat(33)))  // too long
  assert.ok(!isValidCode(''))
  assert.ok(!isValidCode('12345'))         // 5 digits, not custom-charset length either
})

test('formatCode groups 6-digit codes 3-3', () => {
  assert.equal(formatCode('482916'), '482 916')
  assert.equal(formatCode('family-7'), 'family-7')
})

test('weakCodeWarning flags guessable custom codes only', () => {
  assert.equal(weakCodeWarning('482916'), null)
  assert.ok(weakCodeWarning('aaaaaa'))
  assert.ok(weakCodeWarning('abc1'))
  assert.equal(weakCodeWarning('family-photos-7'), null)
})
