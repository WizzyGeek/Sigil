import { listIdentityKeys } from '../crypto/keystore'
import { fingerprintFromSpki } from '../crypto/fingerprint'

export interface IdentitySummary { fingerprint: string; handle: string; registryUrl?: string }

export async function readIdentitySummaries(): Promise<IdentitySummary[]> {
  const saved: IdentitySummary[] = []
  for (const record of await listIdentityKeys()) {
    const fingerprint = await fingerprintFromSpki(record.publicKeySpki)
    const metadata = record.identityMetadata
    saved.push({ fingerprint, handle: metadata?.handle ?? 'Unregistered key', registryUrl: metadata?.registryUrl })
  }
  return saved
}
