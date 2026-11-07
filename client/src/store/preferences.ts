import { config, normalizeUrl } from '../config'

export interface RegistryAccount { url: string; handle: string }
export interface Preferences {
  brokerUrl: string
  channels: string[]
  activeChannel: string
  registries: RegistryAccount[]
  selectedRegistry: string
}

export function loadPreferences(fingerprint: string, initial?: RegistryAccount): Preferences {
  let stored: Partial<Preferences> = {}
  try { stored = JSON.parse(localStorage.getItem(`sigil:preferences:${fingerprint}`) ?? '{}') ?? {} } catch { /* Use deployment suggestions if storage is invalid. */ }
  const channels = [...new Set((Array.isArray(stored.channels) ? stored.channels : config.initialChannels)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0))]
  const accounts = Array.isArray(stored.registries) ? stored.registries.filter(account => account && typeof account.handle === 'string' && typeof account.url === 'string' && normalizeUrl(account.url, 'registry')) : []
  if (initial && !accounts.some(account => account.url === initial.url)) accounts.unshift(initial)
  return {
    brokerUrl: typeof stored.brokerUrl === 'string' ? stored.brokerUrl : normalizeUrl(config.brokerUrl, 'broker') ?? '',
    channels,
    activeChannel: typeof stored.activeChannel === 'string' && channels.includes(stored.activeChannel) ? stored.activeChannel : channels[0] ?? '',
    registries: accounts,
    selectedRegistry: accounts.some(account => account.url === stored.selectedRegistry) ? stored.selectedRegistry! : accounts[0]?.url ?? '',
  }
}

export function savePreferences(fingerprint: string, preferences: Preferences) {
  localStorage.setItem(`sigil:preferences:${fingerprint}`, JSON.stringify(preferences))
}
