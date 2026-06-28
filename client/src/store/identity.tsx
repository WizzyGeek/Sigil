import React, { createContext, useContext, useEffect, useState } from 'react'
import { loadKeypair } from '../crypto/keystore'

interface Identity {
  fingerprint: string
  handle: string
  publicKeySpki: ArrayBuffer
  privateKey: CryptoKey
}

interface IdentityContextValue {
  identity: Identity | null
  setIdentity: (id: Identity) => void
  clearIdentity: () => void
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentityState] = useState<Identity | null>(null)

  useEffect(() => {
    // Try to restore identity from IndexedDB on mount
    loadKeypair().then(record => {
      if (!record) return
      const stored = localStorage.getItem('sigil:identity')
      if (!stored) return
      const { fingerprint, handle } = JSON.parse(stored) as {
        fingerprint: string
        handle: string
      }
      setIdentityState({
        fingerprint,
        handle,
        publicKeySpki: record.publicKeySpki,
        privateKey: record.privateKey,
      })
    })
  }, [])

  const setIdentity = (id: Identity) => {
    setIdentityState(id)
    localStorage.setItem(
      'sigil:identity',
      JSON.stringify({ fingerprint: id.fingerprint, handle: id.handle }),
    )
  }

  const clearIdentity = () => {
    setIdentityState(null)
    localStorage.removeItem('sigil:identity')
  }

  return (
    <IdentityContext.Provider value={{ identity, setIdentity, clearIdentity }}>
      {children}
    </IdentityContext.Provider>
  )
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider')
  return ctx
}
