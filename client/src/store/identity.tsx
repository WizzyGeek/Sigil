import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { loadKeypair, storeKeypair, loadIdentityKey, migrateIdentityRecords } from '../crypto/keystore'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import { readIdentitySummaries } from './identityInventory'
import { withIdentityLock } from '../crypto/keyLifecycle'

export interface Identity {
  fingerprint: string
  handle: string
  registryUrl?: string
  publicKeySpki: ArrayBuffer
  privateKey: CryptoKey
}
export type IdentitySummary = Pick<Identity, 'fingerprint' | 'handle' | 'registryUrl'>
interface IdentityContextValue {
  identity: Identity | null
  identities: IdentitySummary[]
  restoring: boolean
  setIdentity: (id: Identity) => Promise<void>
  selectIdentity: (id: IdentitySummary) => Promise<void>
  refreshIdentities: () => Promise<void>
  clearIdentity: () => void
}
const IdentityContext = createContext<IdentityContextValue | null>(null)
export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentityState] = useState<Identity | null>(null)
  const [identities, setIdentities] = useState<IdentitySummary[]>([])
  const [restoring, setRestoring] = useState(true)
  const refreshIdentities = useCallback(async () => {
    setIdentities(await readIdentitySummaries())
  }, [])
  useEffect(() => {
    let cancelled = false
    const onChange = (event: StorageEvent) => { if (event.key === 'sigil:key-lifecycle') window.location.reload() }
    window.addEventListener('storage', onChange)
    void (async () => {
      const restore = async () => {
        let record = await loadKeypair()
        const stored = localStorage.getItem('sigil:identity')
        const metadata = record?.identityMetadata ?? (stored ? JSON.parse(stored) as IdentitySummary : undefined)
        if (record && metadata && metadata.fingerprint !== await fingerprintFromSpki(record.publicKeySpki)) throw new Error('Stored identity does not match its key.')
        await migrateIdentityRecords(metadata)
        record = await loadKeypair()
        if (record?.identityMetadata && stored && !cancelled) setIdentityState({ ...record.identityMetadata, privateKey: record.privateKey, publicKeySpki: record.publicKeySpki })
      }
      // Startup migration must not race another tab’s rotation or selection.
      if (navigator.locks) await navigator.locks.request('sigil-key-lifecycle', restore)
      else await restore()
      if (!cancelled) await refreshIdentities()
    })().catch(console.error).finally(() => { if (!cancelled) setRestoring(false) })
    return () => { cancelled = true; window.removeEventListener('storage', onChange) }
  }, [refreshIdentities])

  const setIdentity = async (id: Identity) => {
    const metadata = { fingerprint: id.fingerprint, handle: id.handle, registryUrl: id.registryUrl }
    await storeKeypair({ id: 'primary', privateKey: id.privateKey, publicKeySpki: id.publicKeySpki, identityMetadata: metadata })
    localStorage.setItem('sigil:identity', JSON.stringify(metadata))
    await refreshIdentities()
    setIdentityState(id)
  }
  const selectIdentity = async (summary: IdentitySummary) => {
    await withIdentityLock(async () => {
      if (await loadKeypair('pending-rotation')) throw new Error('Finish the pending rotation before switching identities.')
      const record = await loadIdentityKey(summary)
      if (!record) throw new Error('This identity key is no longer stored. Reload and try again.')
      await setIdentity({ ...summary, privateKey: record.privateKey, publicKeySpki: record.publicKeySpki })
      localStorage.setItem('sigil:key-lifecycle', crypto.randomUUID())
    })
  }
  const clearIdentity = () => {
    setIdentityState(null)
    localStorage.removeItem('sigil:identity')
  }
  return <IdentityContext.Provider value={{ identity, identities, restoring, setIdentity, selectIdentity, refreshIdentities, clearIdentity }}>{children}</IdentityContext.Provider>
}
export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider')
  return ctx
}
