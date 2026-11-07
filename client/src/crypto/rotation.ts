import type { KeyRecord } from './keystore'
import type { Preferences } from '../store/preferences'

export interface RotationIdentity { fingerprint: string; handle: string; registryUrl?: string }
export interface RotationJob { oldFingerprint: string; url: string; handle: string; replacementFingerprint: string }
export interface RotationSource { fingerprint: string; preferences: Preferences }
export interface RotationJournal {
  oldFingerprint: string
  preferences: Preferences
  completed: string[]
  jobs?: RotationJob[]
  replacements?: KeyRecord[]
  sources?: RotationSource[]
}
export function handleName(handle: string): string { return handle.replace(/^@/, '').split('@')[0] }
export function rotationGroups(identities: RotationIdentity[], active: RotationIdentity, scope: 'registration' | 'key' | 'all') {
  const selected = identities.filter(item => item.registryUrl && (scope === 'all' || (item.fingerprint === active.fingerprint && (scope === 'key' || item.registryUrl === active.registryUrl))))
  const groups = new Map<string, RotationIdentity[]>()
  for (const item of selected) {
    const name = handleName(item.handle)
    groups.set(name, [...groups.get(name) ?? [], item])
  }
  return [...groups].map(([name, registrations]) => ({ name, registrations }))
}
export function rotationJobId(job: RotationJob): string { return JSON.stringify([job.oldFingerprint, job.url]) }

/** Rebuild from immutable snapshots, so finalization can be retried after a storage failure. */
export function rotatedPreferences(journal: RotationJournal): Map<string, Preferences> {
  if (!journal.jobs || !journal.sources) throw new Error('Rotation journal is missing its plan.')
  const result = new Map(journal.sources.map(source => [source.fingerprint, { ...source.preferences, registries: [...source.preferences.registries] }]))
  for (const job of journal.jobs) {
    const source = result.get(job.oldFingerprint)
    if (!source) throw new Error('Rotation source preferences are missing.')
    source.registries = source.registries.filter(account => account.url !== job.url)
  }
  for (const job of journal.jobs) {
    let target = result.get(job.replacementFingerprint)
    if (!target) {
      target = { ...journal.preferences, registries: [], selectedRegistry: '' }
      result.set(job.replacementFingerprint, target)
    }
    target.registries = [...target.registries.filter(account => account.url !== job.url), { url: job.url, handle: job.handle }]
  }
  for (const preferences of result.values()) {
    if (!preferences.registries.some(account => account.url === preferences.selectedRegistry)) preferences.selectedRegistry = preferences.registries[0]?.url ?? ''
  }
  return result
}
