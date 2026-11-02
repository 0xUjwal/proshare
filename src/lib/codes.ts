// Room codes: human-typed rendezvous identifiers. A code names the room;
// it is never key material (see crypto.ts). Guessing a live code lets a
// stranger REQUEST to join - the sender still approves every join - and
// observe that a room exists. Auto codes are 6 digits; custom codes are
// normalized lowercase, 4-32 chars of letters/digits/space/dash.

export function autoCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  return n.toString().padStart(6, '0')
}

export function normalizeCode(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 -]/g, '')
}

export function isValidCode(code: string): boolean {
  if (/^\d+$/.test(code)) return /^\d{6}$/.test(code) // numeric codes are exactly 6 digits
  return /^[a-z0-9][a-z0-9 -]{2,30}[a-z0-9]$/.test(code)
}

export function formatCode(code: string): string {
  return /^\d{6}$/.test(code) ? code.replace(/(\d{3})(\d{3})/, '$1 $2') : code
}

// Honest strength note shown next to custom codes.
export function weakCodeWarning(code: string): string | null {
  if (/^\d{6}$/.test(code)) return null
  const chars = code.replace(/[ -]/g, '')
  if (chars.length < 6 || new Set(chars).size < 3)
    return 'This code is easy to guess. While your room is open, anyone who guesses it can ask to join - you still approve every person, and nothing transfers without approval.'
  return null
}
