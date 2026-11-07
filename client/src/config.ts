function positiveInteger(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= min ? Math.min(max, Math.floor(number)) : fallback
}

function suggestedBrokers(): string[] {
  const plural = import.meta.env.VITE_DEFAULT_BROKER_URLS as string | undefined
  if (plural !== undefined) {
    try {
      const parsed: unknown = JSON.parse(plural)
      if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === 'string')
    } catch { /* Fall back to the legacy single suggestion for invalid JSON. */ }
  }
  const single = (import.meta.env.VITE_DEFAULT_BROKER_URL as string | undefined) ?? ''
  return single ? [single] : []
}

/** Deployment values are suggestions; user connection choices live in preferences. */
export const config = {
  registryUrl: (import.meta.env.VITE_REGISTRY_URL as string | undefined) ?? '',
  brokerUrls: suggestedBrokers(),
  initialChannels: ((import.meta.env.VITE_DEFAULT_CHANNELS as string | undefined) ?? '')
    .split(',').map(value => value.trim()).filter(Boolean),
  registryTimeoutMs: positiveInteger(import.meta.env.VITE_REGISTRY_TIMEOUT_MS, 10000, 500, 120000),
  maxNoteBytes: positiveInteger(import.meta.env.VITE_MAX_NOTE_BYTES, 4096),
  maxFrameBytes: positiveInteger(import.meta.env.VITE_MAX_FRAME_BYTES, 262144, 1024),
  historyTimeoutMs: positiveInteger(import.meta.env.VITE_HISTORY_TIMEOUT_MS, 5000, 500, 60000),
  historyBatchSize: positiveInteger(import.meta.env.VITE_HISTORY_BATCH_SIZE, 25, 1, 25),
  repositoryUrl: (import.meta.env.VITE_REPOSITORY_URL as string | undefined)?.trim() || 'https://github.com/WizzyGeek/Sigil',
}

export function normalizeUrl(value: string, kind: 'registry' | 'broker'): string | null {
  try {
    const url = new URL(value.trim(), kind === 'broker' && value.trim().startsWith('/') ? window.location.href : undefined)
    if (kind === 'broker' && value.trim().startsWith('/')) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const protocols = kind === 'registry' ? ['http:', 'https:'] : ['ws:', 'wss:']
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
    if (kind === 'registry' && url.protocol === 'http:' && !loopback) return null
    if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || (kind === 'registry' && url.search)) return null
    return kind === 'registry' ? url.href.replace(/\/+$/, '') : url.href
  } catch {
    return null
  }
}
