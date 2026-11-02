import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoCode, formatCode, isValidCode, normalizeCode, weakCodeWarning } from '../src/lib/codes.ts'

test('autoCode is always 6 digits', () => {
  for (let i = 0; i < 200; i++) assert.match(autoCode(), /^\d{6}$/)
})

test('normalizeCode keeps digits only', () => {
  assert.equal(normalizeCode('482 916'), '482916')
  assert.equal(normalizeCode('482-916'), '482916')
  assert.equal(normalizeCode(' 48 29 16 '), '482916')
  assert.equal(normalizeCode('ab48c2916'), '482916')
})

test('isValidCode requires exactly 6 digits', () => {
  assert.ok(isValidCode('482916'))
  assert.ok(isValidCode('000000'))
  assert.ok(!isValidCode('12345'))
  assert.ok(!isValidCode('1234567'))
  assert.ok(!isValidCode('family-7'))
  assert.ok(!isValidCode(''))
})

test('formatCode groups 6-digit codes 3-3', () => {
  assert.equal(formatCode('482916'), '482 916')
  assert.equal(formatCode('nope'), 'nope')
})

test('weakCodeWarning flags guessable patterns only', () => {
  assert.equal(weakCodeWarning('482916'), null)
  assert.ok(weakCodeWarning('111111'))
  assert.ok(weakCodeWarning('123456'))
  assert.ok(weakCodeWarning('654321'))
  assert.equal(weakCodeWarning('4829163'), null)
})
