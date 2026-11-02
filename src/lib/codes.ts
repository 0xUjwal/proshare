// Room codes: human-typed rendezvous identifiers. A code names the room;
// it is never key material (see crypto.ts). Guessing a live code lets a
// stranger REQUEST to join - the sender still approves every join - and
// observe that a room exists. Codes are exactly 6 digits, auto-generated
// or chosen by the sender.

export function autoCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return n.toString().padStart(6, '0')
}

// Digits only; typing "482 916" or "482-916" normalizes to "482916".
export function normalizeCode(raw: string): string {
  return raw.replace(/[^0-9]/g, '')
}

export function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code)
}

export function formatCode(code: string): string {
  return /^\d{6}$/.test(code) ? code.replace(/(\d{3})(\d{3})/, '$1 $2') : code
}

// Honest strength note for sender-chosen codes.
export function weakCodeWarning(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null
  const allSame = new Set(code).size === 1
  const sequential = '01234567890123456789'.includes(code) || '98765432109876543210'.includes(code)
  const common = ['123456', '111111', '000000', '121212', '654321', '112233'].includes(code)
  if (allSame || sequential || common)
    return 'This code is very easy to guess. While your room is open, anyone who guesses it can ask to join - you still approve every person, and nothing transfers without approval.'
  return null
}
