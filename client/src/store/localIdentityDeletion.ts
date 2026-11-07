import { deleteAllLocalKeys, deleteStoredIdentity, loadKeypair, loadIdentityKey } from '../crypto/keystore'
import { forgetAdvertisements } from '../discovery/advertiser'
import { loadPreferences, savePreferences, type Preferences } from './preferences'
import type { IdentitySummary } from './identityInventory'

export const ALL_LOCAL_KEYS_CONFIRMATION = 'Delete ALL private keys and saved identities from this client without revoking any registrations? You will need PEM backups to restore them. Staging keys and unfinished rotation keys will also be deleted, and pending rotations cannot be resumed. Stored notes will be kept.'

/** Remove the selected identity from its saved configuration. */
export function withoutLocalIdentity(preferences: Preferences, registryUrl?: string): Preferences {
  const registries = preferences.registries.filter(account => account.url !== registryUrl)
  return { ...preferences, registries, selectedRegistry: registries.some(account => account.url === preferences.selectedRegistry) ? preferences.selectedRegistry : registries[0]?.url ?? '' }
}

/** Caller holds the cross-tab identity lock. This module makes no registry API calls. */
export async function deleteLocalIdentity(target: IdentitySummary): Promise<void> {
  if (await loadKeypair('pending-rotation')) throw new Error('Finish the pending rotation before deleting one identity or key. Delete all local keys can discard the entire unfinished rotation.')
  const record = await loadIdentityKey(target)
  if (!record) throw new Error('This key has already been removed. Reload to refresh the identity list.')
  const metadata = record.identityMetadata
  const preferences = loadPreferences(target.fingerprint, metadata?.registryUrl ? { url: metadata.registryUrl, handle: metadata.handle } : undefined)
  const remaining = withoutLocalIdentity(preferences, target.registryUrl)
  await deleteStoredIdentity(target)
  forgetAdvertisements(target.fingerprint, target.registryUrl)
  savePreferences(target.fingerprint, remaining)
}

/** Remove all private material and saved identity configurations, preserving the note database. */
export async function deleteEveryLocalIdentity(): Promise<void> {
  await deleteAllLocalKeys()
  forgetAdvertisements()
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith('sigil:preferences:')) keys.push(key)
  }
  for (const key of keys) localStorage.removeItem(key)
}
