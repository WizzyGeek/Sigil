import { useEffect, useState } from 'react'
import { hasLocalKeyMaterial } from '../crypto/keystore'
import { withIdentityLock } from '../crypto/keyLifecycle'
import { ALL_LOCAL_KEYS_CONFIRMATION, deleteEveryLocalIdentity } from '../store/localIdentityDeletion'
import { useIdentity } from '../store/identity'

/** Available before sign-in so abandoned staging keys can also be cleared. */
export default function DeleteLocalKeys({ disabled = false }: { disabled?: boolean }) {
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { clearIdentity } = useIdentity()
  useEffect(() => { void hasLocalKeyMaterial().then(setAvailable).catch(() => {}) }, [])
  if (!available) return null
  return <div className="text-xs">
    <button disabled={disabled || busy} className="text-red-300/70 disabled:opacity-40" onClick={() => {
      if (!window.confirm(ALL_LOCAL_KEYS_CONFIRMATION)) return
      setBusy(true); setError('')
      void withIdentityLock(async () => {
        await deleteEveryLocalIdentity()
        clearIdentity()
        localStorage.setItem('sigil:key-lifecycle', crypto.randomUUID())
        window.location.reload()
      }).catch(err => setError((err as Error).message)).finally(() => setBusy(false))
    }}>Delete all local keys</button>
    {error && <p role="alert" className="text-red-300 mt-2">{error}</p>}
  </div>
}
