/** Freshness is stake age when the note was signed, not the note's current age. */
export function formatDuration(seconds: number, compact = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unavailable'
  const total = Math.floor(seconds)
  const units: [number, string, string][] = [[86400, 'day', 'd'], [3600, 'hour', 'h'], [60, 'minute', 'm'], [1, 'second', 's']]
  let remaining = total
  const parts: string[] = []
  for (const [size, name, symbol] of units) {
    const value = Math.floor(remaining / size)
    remaining %= size
    if (value || (size === 1 && !parts.length)) parts.push(compact ? `${value}${symbol}` : `${value} ${name}${value === 1 ? '' : 's'}`)
  }
  return parts.join(' ')
}
export function freshnessLabel(note: { issuedAt: number; stakeIssuedAt?: number }, compact = false): string {
  if (!Number.isFinite(note.stakeIssuedAt)) return 'Unavailable'
  const seconds = note.issuedAt - note.stakeIssuedAt!
  if (seconds < 0) return compact ? `−${formatDuration(-seconds, true)}` : `Stake issued ${formatDuration(-seconds)} after note`
  return formatDuration(seconds, compact)
}
export function issuedAtLabel(seconds: number): string {
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
}
