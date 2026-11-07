import { config, normalizeUrl } from '../config'

export interface RegistryAccount { url: string; handle: string }
export interface BrokerAccess { read: boolean; publish: boolean }
export function brokerAccess(preferences: Pick<Preferences, 'brokerAccess'>, url: string): BrokerAccess {
  return preferences.brokerAccess?.[url] ?? { read: true, publish: true }
}
export interface Preferences {
  brokerAccess?: Record<string, BrokerAccess>
  brokerUrls: string[]
  channels: string[]
  activeChannel: string
  registries: RegistryAccount[]
  selectedRegistry: string
}

export function loadPreferences(fingerprint: string, initial?: RegistryAccount): Preferences {
  let stored: Partial<Preferences> & { brokerUrl?: unknown } = {}
  try { stored = JSON.parse(localStorage.getItem(`sigil:preferences:${fingerprint}`) ?? '{}') ?? {} } catch { /* Use deployment suggestions if storage is invalid. */ }
  const channels = [...new Set((Array.isArray(stored.channels) ? stored.channels : config.initialChannels)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0))]
  const accounts = Array.isArray(stored.registries) ? stored.registries.filter(account => account && typeof account.handle === 'string' && typeof account.url === 'string' && normalizeUrl(account.url, 'registry')) : []
  if (!Array.isArray(stored.registries) && initial && !accounts.some(account => account.url === initial.url)) accounts.unshift(initial)
  const suggested = Array.isArray(stored.brokerUrls) ? stored.brokerUrls
    : typeof stored.brokerUrl === 'string' ? (stored.brokerUrl ? [stored.brokerUrl] : []) : config.brokerUrls
  const brokerUrls = [...new Set(suggested.filter((value): value is string => typeof value === 'string')
    .map(value => normalizeUrl(value, 'broker')).filter((value): value is string => value !== null))]
  return {
    brokerUrls,
    ...(stored.brokerAccess && typeof stored.brokerAccess === 'object' ? { brokerAccess: Object.fromEntries(brokerUrls.map(url => {
      const access = stored.brokerAccess?.[url]
      return [url, access && typeof access.read === 'boolean' && typeof access.publish === 'boolean' ? { read: access.read, publish: access.publish } : { read: true, publish: true }]
    })) } : {}),
    channels,
    activeChannel: typeof stored.activeChannel === 'string' && channels.includes(stored.activeChannel) ? stored.activeChannel : channels[0] ?? '',
    registries: accounts,
    selectedRegistry: accounts.some(account => account.url === stored.selectedRegistry) ? stored.selectedRegistry! : accounts[0]?.url ?? '',
  }
}

export function savePreferences(fingerprint: string, preferences: Preferences) {
  localStorage.setItem(`sigil:preferences:${fingerprint}`, JSON.stringify(preferences))
}
