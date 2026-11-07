import { createContext, useContext, useRef, useState } from 'react'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import { generateBackupKeypair, type KeyRecord } from '../crypto/keystore'

const GenerationContext = createContext<((id: string, label?: string) => Promise<KeyRecord>) | null>(null)
interface Pending { label?: string; fingerprint: string; record: KeyRecord; pem: string; resolve: (record: KeyRecord) => void; reject: (error: Error) => void }

/** All identity-generation entry points share the same backup acknowledgement. */
export function KeyGenerationProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  async function generate(id: string, label?: string): Promise<KeyRecord> {
    if (busy.current) throw new Error('A key generation is already in progress.')
    busy.current = true
    try {
      const { record, pem } = await generateBackupKeypair(id)
      const fingerprint = await fingerprintFromSpki(record.publicKeySpki)
      setAcknowledged(false)
      setError('')
      return await new Promise<KeyRecord>((resolve, reject) => setPending({ label, fingerprint, record, pem, resolve, reject }))
    } finally { busy.current = false }
  }
  function download() {
    if (!pending) return
    const url = URL.createObjectURL(new Blob([pending.pem], { type: 'application/x-pem-file' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `sigil-private-key-${pending.fingerprint.slice(0, 12)}.pem`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <GenerationContext.Provider value={generate}>
    {children}
    {pending && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4" role="dialog" aria-modal="true" aria-labelledby="key-backup-title">
      <div className="bg-[#101010] border border-white/15 rounded-2xl p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto text-white">
        <h2 id="key-backup-title" className="text-lg font-semibold">Back up your private key</h2>
        {pending.label && <p className="text-sm text-gold mt-3 break-words">{pending.label}</p>}
        <p className="text-xs text-white/40 mt-2 break-all">Fingerprint: {pending.fingerprint}</p>
        <p className="text-sm text-amber-200/80 mt-3">This private key is shown once. Save it now. After you continue, Sigil stores a non-exportable signing key and cannot show or recover these bytes again. Anyone with this backup can use your identity.</p>
        <textarea aria-label="Generated private key" readOnly value={pending.pem} spellCheck={false} autoComplete="off" rows={8} className="mt-4 w-full rounded-xl p-3 bg-white/5 border border-white/15 font-mono text-xs" />
        <div className="flex gap-4 mt-3 text-xs text-gold">
          <button onClick={download}>Download private key (.pem)</button>
          <button onClick={() => { void (async () => { try { await navigator.clipboard.writeText(pending.pem) } catch { setError('Copy failed. Select the key text or download the PEM file.') } })() }}>Copy private key</button>
        </div>
        <p className="text-xs text-white/50 mt-3">The PEM backup is unencrypted. Store it somewhere private and secure. It is never sent to a registry or broker.</p>
        <label className="flex items-start gap-2 text-sm mt-5"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 accent-[#d6b06a]" /> I saved my private key and understand Sigil cannot recover it later.</label>
        {error && <p role="alert" className="text-xs text-red-300 mt-3">{error}</p>}
        <div className="flex justify-end gap-4 mt-6 text-sm">
          <button onClick={() => { pending.reject(new Error('Key generation cancelled. No registration was changed.')); setPending(null) }}>Cancel</button>
          <button disabled={!acknowledged} className="bg-gold text-black rounded-xl px-4 py-2 disabled:opacity-30" onClick={() => { pending.resolve(pending.record); setPending(null) }}>Use this key</button>
        </div>
      </div>
    </div>}
  </GenerationContext.Provider>
}
export function useKeyGeneration() {
  const generate = useContext(GenerationContext)
  if (!generate) throw new Error('KeyGenerationProvider is missing.')
  return generate
}
