export const MAX_FILE_BYTES = 1024 * 1024 * 1024 // 1 GiB per file (in-memory transfer)
export const MAX_TEXT_CHARS = 20_000
export const MAX_FILES = 50

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

// Never trust a name that arrived over the wire: strip path parts,
// control chars and anything that could be unsafe as a download name.
export function sanitizeFilename(name: unknown, fallback = 'file'): string {
  if (typeof name !== 'string') return fallback
  let clean = name.split(/[\\/]/).pop() ?? fallback
  // eslint-disable-next-line no-control-regex
  clean = clean.replace(/[\x00-\x1f\x7f"<>|?*:]/g, '').trim()
  if (!clean || clean === '.' || clean === '..') return fallback
  if (clean.length > 120) {
    const dot = clean.lastIndexOf('.')
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : ''
    clean = clean.slice(0, 120 - ext.length) + ext
  }
  return clean
}

export function saveBlob(data: ArrayBuffer | Blob, name: string, type?: string): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
