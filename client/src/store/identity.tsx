import React, { createContext, useContext, useEffect, useState } from 'react'
import { loadKeypair } from '../crypto/keystore'

export interface Identity {
  fingerprint: string
  handle: string
  registryUrl?: string
  publicKeySpki: ArrayBuffer
  privateKey: CryptoKey
}

interface IdentityContextValue {
  identity: Identity | null
  restoring: boolean
  setIdentity: (id: Identity) => void
  clearIdentity: () => void
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentityState] = useState<Identity | null>(null)

  const [restoring, setRestoring] = useState(true)

  useEffect(() => {
    // Try to restore identity from IndexedDB on mount
    let cancelled = false
    loadKeypair().then(record => {
      if (cancelled) return
      if (!record) return
      const stored = localStorage.getItem('sigil:identity')
      if (!stored) return
      const { fingerprint, handle, registryUrl } = JSON.parse(stored) as {
        fingerprint: string
        handle: string
        registryUrl?: string
      }
      setIdentityState({
        fingerprint,
        handle,
        registryUrl,
        publicKeySpki: record.publicKeySpki,
        privateKey: record.privateKey,
      })
    }).catch(console.error).finally(() => { if (!cancelled) setRestoring(false) })
    return () => { cancelled = true }
  }, [])

  const setIdentity = (id: Identity) => {
    localStorage.setItem(
      'sigil:identity',
      JSON.stringify({ fingerprint: id.fingerprint, handle: id.handle, registryUrl: id.registryUrl }),
    )
    setIdentityState(id)
  }

  const clearIdentity = () => {
    setIdentityState(null)
    localStorage.removeItem('sigil:identity')
  }

  return (
    <IdentityContext.Provider value={{ identity, restoring, setIdentity, clearIdentity }}>
      {children}
    </IdentityContext.Provider>
  )
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider')
  return ctx
}
