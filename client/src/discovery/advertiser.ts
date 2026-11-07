import { normalizeUrl } from '../config'
import { advertiseEndpoints, requestChallenge, RegistryError } from '../api/registry'
import { canonicalJsonString } from '../crypto/jwt'
import { signNonce } from '../crypto/keyLifecycle'
import { loadIdentityKey } from '../crypto/keystore'

export interface Advertisement { registry: string; fingerprint: string; registries: string[]; brokers: string[] }
const storageKey = 'sigil:discovery-outbox'
let queue: Advertisement[] | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let flushing = false
let lastSent = new Map<string, Set<string>>()

/** Connection tokens are never public advertisements. */
export function publicEndpoint(value: string, kind: 'registry' | 'broker'): string | null {
  const normalized = normalizeUrl(value, kind)
  if (!normalized || normalized.length > 2048 || new URL(normalized).search) return null
  const host = new URL(normalized).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (host === 'localhost' || ['.localhost', '.local', '.internal', '.home.arpa'].some(suffix => host.endsWith(suffix))) return null
  const ip = host.split('.').map(Number)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && (ip[0] === 0 || ip[0] === 10 || ip[0] === 127 || ip[0] >= 224 || (ip[0] === 169 && ip[1] === 254) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127))) return null
  if (host.includes(':') && (host === '::' || host === '::1' || /^(fc|fd|fe[89ab]|::ffff)/i.test(host))) return null
  return normalized
}
function pending(): Advertisement[] {
  if (queue) return queue
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    queue = Array.isArray(parsed) ? parsed.filter((item): item is Advertisement => item && typeof item.registry === 'string' && typeof item.fingerprint === 'string' && Array.isArray(item.registries) && Array.isArray(item.brokers)).map(item => ({ ...item,
      registries: item.registries.filter((url): url is string => typeof url === 'string' && !!publicEndpoint(url, 'registry')),
      brokers: item.brokers.filter((url): url is string => typeof url === 'string' && !!publicEndpoint(url, 'broker')),
    })) : []
  } catch { queue = [] }
  return queue
}
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(pending())) } catch { /* In-memory retry remains available. */ } }
function schedule(delay = 500) {
  if (timer) return
  timer = setTimeout(() => { timer = undefined; void flushAdvertisements() }, delay)
}
export function queueAdvertisement(registry: string, fingerprint: string, entries: { registries?: string[]; brokers?: string[] }) {
  const source = normalizeUrl(registry, 'registry')
  if (!source) return
  const key = JSON.stringify([source, fingerprint])
  const sent = lastSent.get(key) ?? new Set<string>()
  const urls = (values: string[], kind: 'registry' | 'broker') => values.map(value => publicEndpoint(value, kind)).filter((url): url is string => !!url && !sent.has(`${kind}:${url}`))
  const registries = urls(entries.registries ?? [], 'registry'), brokers = urls(entries.brokers ?? [], 'broker')
  const current = pending().find(item => item.registry === source && item.fingerprint === fingerprint)
  if (current) {
    current.registries = [...new Set([...current.registries, ...registries])]
    current.brokers = [...new Set([...current.brokers, ...brokers])]
  } else if (registries.length || brokers.length) pending().push({ registry: source, fingerprint, registries: [...new Set(registries)], brokers: [...new Set(brokers)] })
  persist()
  if (pending().length) schedule()
}

/** Runs only while a registered client is active; requests remain independent of UI mounts. */
export async function flushAdvertisements(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (const item of [...pending()]) {
      if (!pending().includes(item)) continue
      try {
        const key = await loadIdentityKey({ fingerprint: item.fingerprint, registryUrl: item.registry })
        if (!key) { queue = pending().filter(job => job !== item); persist(); continue }
        const attempted = new Set<string>()
        while (pending().includes(item) && (item.registries.length || item.brokers.length)) {
          const registries = item.registries.filter(url => !attempted.has(`registry:${url}`)).slice(0, 8)
          const brokers = item.brokers.filter(url => !attempted.has(`broker:${url}`)).slice(0, 8 - registries.length)
          if (!registries.length && !brokers.length) break
          for (const url of registries) attempted.add(`registry:${url}`)
          for (const url of brokers) attempted.add(`broker:${url}`)
          const { nonce } = await requestChallenge(item.fingerprint, item.registry)
          if (!pending().includes(item)) break
          const payload = { fingerprint: item.fingerprint, nonce, registries, brokers }
          const result = await advertiseEndpoints(item.registry, { ...payload, signature: await signNonce(key.privateKey, canonicalJsonString(payload)) })
          const finished = new Set([...result.accepted, ...result.rejected.filter(entry => entry.reason === 'not_public')].map(entry => `${entry.kind}:${entry.url}`))
          const sentKey = JSON.stringify([item.registry, item.fingerprint])
          const sent = lastSent.get(sentKey) ?? new Set<string>()
          for (const url of registries) if (finished.has(`registry:${url}`)) sent.add(`registry:${url}`)
          for (const url of brokers) if (finished.has(`broker:${url}`)) sent.add(`broker:${url}`)
          lastSent.set(sentKey, sent)
          item.registries = item.registries.filter(url => !finished.has(`registry:${url}`))
          item.brokers = item.brokers.filter(url => !finished.has(`broker:${url}`))
          persist()
        }
        if (!item.registries.length && !item.brokers.length) queue = pending().filter(job => job !== item)
      } catch (error) {
        // An older registry may not support discovery; revoked identities cannot advertise.
        if (error instanceof RegistryError && [401, 403, 404, 405, 422].includes(error.status)) queue = pending().filter(job => job !== item)
      }
      persist()
    }
  } finally {
    flushing = false
    if (pending().length) schedule(30000)
  }
}

/** Forget queued work when an identity/key is removed locally; never revoke remotely. */
export function forgetAdvertisements(fingerprint?: string, registry?: string): void {
  queue = pending().filter(item => fingerprint !== undefined && (item.fingerprint !== fingerprint || (registry !== undefined && item.registry !== registry)))
  for (const key of lastSent.keys()) {
    const [source, fp] = JSON.parse(key) as [string, string]
    if (fingerprint === undefined || (fp === fingerprint && (registry === undefined || source === registry))) lastSent.delete(key)
  }
  if (!queue.length && timer) { clearTimeout(timer); timer = undefined }
  persist()
}
