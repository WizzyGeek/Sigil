import React, { useState, useEffect } from 'react'
import { importKeypair, loadKeypair, loadIdentityKey, storeKeypair, deleteKeypair, type KeyRecord } from '../crypto/keystore'
import { fingerprintFromSpki, hashEmail } from '../crypto/fingerprint'
import { requestChallenge, register, requestStake, fetchRegistryPublicKey, isHandleAvailable, lookupKey, RegistryError } from '../api/registry'
import { useIdentity, type Identity } from '../store/identity'
import DeleteLocalKeys from '../components/DeleteLocalKeys'
import { withIdentityLock } from '../crypto/keyLifecycle'
import EndpointInput from '../components/EndpointInput'
import { useKeyGeneration } from '../components/KeyGeneration'
import { useSearchParams } from 'react-router-dom'
import { config, normalizeUrl } from '../config'
import { importPublicKeyPem } from '../crypto/jwt'
import { createRegistryKeyring, verifyStake } from '../crypto/registryTrust'

interface Props {
  onComplete: () => void
}

type Step = 1 | 2 | 3
type KeypairChoice = 'generate' | 'import' | 'stored' | null

function DiamondLogo() {
  return (
    <div
      style={{
        width: 20,
        height: 20,
        background: 'linear-gradient(135deg, #e3c485, #c79a4f)',
        transform: 'rotate(45deg)',
        borderRadius: 3,
        margin: '0 auto 20px',
      }}
    />
  )
}

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {([1, 2, 3] as Step[]).map(s => (
        <div
          key={s}
          className="flex items-center justify-center rounded-full text-[11px] font-semibold transition-all"
          style={{
            width: 28,
            height: 28,
            border: s <= current ? '2px solid #d6b06a' : '2px solid rgba(255,255,255,0.12)',
            background: s < current ? 'rgba(214,176,106,0.15)' : 'transparent',
            color: s <= current ? '#d6b06a' : 'rgba(255,255,255,0.3)',
          }}
        >
          {s < current ? '✓' : s}
        </div>
      ))}
    </div>
  )
}

export default React.memo(function Onboarding({ onComplete }: Props) {
  const generateKey = useKeyGeneration()
  const [params] = useSearchParams()
  const restoreMode = params.get('mode') === 'signin'
  const [privateKeyPem, setPrivateKeyPem] = useState('')
  const [pendingIdentity, setPendingIdentity] = useState<Identity | null>(null)
  const [step, setStep] = useState<Step>(1)
  const [keypairChoice, setKeypairChoice] = useState<KeypairChoice>(restoreMode ? 'import' : null)
  const restoring = restoreMode || keypairChoice === 'stored'
  const [storedKey, setStoredKey] = useState<KeyRecord | null>(null)
  const [restoredRegistration, setRestoredRegistration] = useState(false)

  // Step 2 fields
  const [registryUrl, setRegistryUrl] = useState(config.registryUrl)
  const registryBase = normalizeUrl(registryUrl, 'registry')
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0)
  const [handleStatus, setHandleStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle')

  // Submission state
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<{ fingerprint: string; handle: string } | null>(null)

  const { setIdentity } = useIdentity()

  useEffect(() => {
    void loadKeypair().then(setStoredKey).catch(error => setError((error as Error).message))
  }, [])

  // Handle availability debounce
  useEffect(() => {
    if (restoring || !handle || !registryBase) { setHandleStatus('idle'); return }
    const controller = new AbortController()
    setHandleStatus('checking')
    const t = setTimeout(async () => {
      try {
        const available = await isHandleAvailable(registryBase, handle, controller.signal)
        if (!controller.signal.aborted) setHandleStatus(available ? 'available' : 'taken')
      } catch {
        if (!controller.signal.aborted) setHandleStatus('error')
      }
    }, 600)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [handle, registryBase, restoring, availabilityAttempt])

  async function handleRegister() {
    if (!canContinueStep2 || !registryBase || loading) return
    setError('')
    setLoading(true)
    try {
      await withIdentityLock(async () => {
      const record = keypairChoice === 'stored' ? storedKey : keypairChoice === 'import'
        ? await importKeypair(privateKeyPem)
        : await loadKeypair('pending-onboarding') ?? await generateKey('pending-onboarding', `@${handle}@${new URL(registryBase).host}`)
      if (!record) throw new Error('No key is available in this browser. Import a PEM backup instead.')
      if (keypairChoice === 'generate') await storeKeypair(record)
      const fp = await fingerprintFromSpki(record.publicKeySpki)

      const spkiB64 = btoa(String.fromCharCode(...new Uint8Array(record.publicKeySpki)))
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`

      const { nonce } = await requestChallenge(fp, registryBase)

      const enc = new TextEncoder()
      const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', record.privateKey, enc.encode(nonce))
      const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))

      let result: { fingerprint: string; handle: string }
      let existingRegistration = restoring
      if (!existingRegistration) {
        try { await lookupKey(fp, registryBase); existingRegistration = true }
        catch (error) { if (!(error instanceof RegistryError && error.status === 404)) throw error }
      }
      if (existingRegistration) {
        const { stake } = await requestStake({ fingerprint: fp, nonce, signature }, registryBase)
        const key = await importPublicKeyPem(await fetchRegistryPublicKey(registryBase))
        const claims = await verifyStake(stake, createRegistryKeyring([[registryBase, key]]))
        const claimedSpki = Uint8Array.from(atob(claims.public_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0)).buffer
        if (await fingerprintFromSpki(claimedSpki) !== fp) throw new Error('Registry returned a stake for a different key.')
        result = { fingerprint: fp, handle: `@${claims.user_tag.replace(/^@/, '')}@${claims.iss}` }
      } else {
        result = await register({
          public_key: publicKeyPem,
          user_tag: handle,
          display_name: displayName || undefined,
          nonce,
          signature,
          recovery_email_hash: recoveryEmail.trim() ? await hashEmail(recoveryEmail) : undefined,
        }, registryBase)
      }
      if (result.fingerprint !== fp) throw new Error('Registry returned a different key fingerprint.')
      if (typeof result.handle !== 'string' || !result.handle.toLowerCase().endsWith('@' + new URL(registryBase).host.toLowerCase())) throw new Error('Registry returned a handle for a different issuer.')
      await storeKeypair({ ...record, id: 'primary', identityMetadata: { ...result, registryUrl: registryBase } })
      if (keypairChoice === 'generate') await deleteKeypair('pending-onboarding')
      setRestoredRegistration(existingRegistration)
      setPrivateKeyPem('')
      setPendingIdentity({
        fingerprint: result.fingerprint,
        handle: result.handle,
        registryUrl: registryBase,
        publicKeySpki: record.publicKeySpki,
        privateKey: record.privateKey,
      })

      setSummary(result)
      setStep(3)
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const canContinueStep1 = keypairChoice === 'generate' || (keypairChoice === 'stored' && storedKey !== null) || (keypairChoice === 'import' && privateKeyPem.trim().length > 0)
  const canContinueStep2 = registryBase !== null && (restoring || (handle.length >= 1 && handleStatus === 'available')) && (!recoveryEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail.trim()))

  return (
    <div
      className="h-full overflow-y-auto flex flex-col px-4 py-8"
      style={{ background: '#000', fontFamily: 'Space Grotesk, sans-serif' }}
    >
      <div
        className="w-full my-auto mx-auto shrink-0"
        style={{
          maxWidth: 600,
          background: 'rgba(255,255,255,0.025)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 22,
          padding: '40px 36px',
          backdropFilter: 'blur(16px)',
          animation: 'sgStep 0.4s ease both',
        }}
      >
        <DiamondLogo />
        <StepIndicator current={step} />

        {/* Step 1 — Choose keypair method */}
        {step === 1 && (
          <div style={{ animation: 'sgStep 0.3s ease both' }}>
            <h2 className="font-bold text-center mb-2" style={{ fontSize: 22 }}>{restoring ? 'Restore Your Identity' : 'Establish Your Identity'}</h2>
            <p className="text-center mb-8" style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
              Your private key stays on this device. Generate a new key or import an existing PKCS#8 PEM backup.
            </p>

            <div className="grid grid-cols-2 gap-4 mb-6">
              {/* Generate card */}
              <button
                disabled={restoreMode}
                onClick={() => setKeypairChoice('generate')}
                className="relative rounded-2xl p-5 text-left transition-all"
                style={{
                  background: keypairChoice === 'generate' ? 'rgba(214,176,106,0.07)' : 'rgba(255,255,255,0.025)',
                  border: keypairChoice === 'generate' ? '1.5px solid #d6b06a' : '1.5px solid rgba(255,255,255,0.1)',
                }}
              >
                {/* Recommended badge */}
                <span
                  className="absolute top-3 right-3 px-2 py-0.5 rounded text-[10px] font-semibold"
                  style={{ background: 'rgba(214,176,106,0.15)', color: '#d6b06a', letterSpacing: '0.05em' }}
                >
                  RECOMMENDED
                </span>
                <div
                  className="flex items-center justify-center rounded-xl mb-3"
                  style={{ width: 40, height: 40, background: 'rgba(214,176,106,0.1)', border: '1px solid rgba(214,176,106,0.2)' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d6b06a" strokeWidth="1.8" strokeLinecap="round">
                    <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
                  </svg>
                </div>
                <div className="font-semibold mb-1" style={{ fontSize: 14 }}>Generate New Keypair</div>
                <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
                  Create a fresh cryptographic identity in your browser.
                </div>
              </button>

              {/* Import card */}
              <button
                onClick={() => setKeypairChoice('import')}
                className="rounded-2xl p-5 text-left transition-all"
                style={{
                  background: keypairChoice === 'import' ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.015)',
                  border: keypairChoice === 'import' ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid rgba(255,255,255,0.1)',
                }}
              >
                <div
                  className="flex items-center justify-center rounded-xl mb-3"
                  style={{ width: 40, height: 40, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="7,10 12,15 17,10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <div className="font-semibold mb-1" style={{ fontSize: 14 }}>Import Existing Keypair</div>
                <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
                  Paste a PKCS#8 PEM private key from your backup.
                </div>
              </button>
            </div>

            {storedKey && <button
              onClick={() => setKeypairChoice('stored')}
              className="w-full rounded-xl border border-white/15 p-3 text-sm text-left mb-5"
              style={{ color: keypairChoice === 'stored' ? '#d6b06a' : 'rgba(255,255,255,0.65)' }}
            >Restore the key stored in this browser</button>}
            {keypairChoice === 'generate' && storedKey && <p className="text-xs text-amber-200/70 mb-4">A key already exists in this browser. Restore it to keep that identity. Generating another identity keeps this key available in the identity menu.</p>}

            <DeleteLocalKeys disabled={loading} />
            {keypairChoice === 'import' && (
              <div className="mb-5">
                <label htmlFor="private-key" className="block text-xs text-white/50 mb-2">Private key (PKCS#8 PEM)</label>
                <textarea id="private-key" value={privateKeyPem} onChange={e => setPrivateKeyPem(e.target.value)} rows={5} spellCheck={false} autoComplete="off" className="w-full rounded-xl p-3 bg-white/5 border border-white/10 text-xs font-mono" placeholder="-----BEGIN PRIVATE KEY-----" />
              </div>
            )}

            <p className="text-center mb-6" style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.25)' }}>
              Generated keys use RSA-4096. You will see the private key once for backup before it is stored as a non-exportable signing key.
            </p>

            <button
              onClick={() => setStep(2)}
              disabled={!canContinueStep1}
              className="w-full py-3 font-semibold text-sm text-black rounded-xl transition-all"
              style={{
                background: '#d6b06a',
                opacity: canContinueStep1 ? 1 : 0.45,
                cursor: canContinueStep1 ? 'pointer' : 'default',
              }}
            >
              CONTINUE →
            </button>
          </div>
        )}

        {/* Step 2 — Registry & Handle */}
        {step === 2 && (
          <div style={{ animation: 'sgStep 0.3s ease both' }}>
            <h2 className="font-bold text-center mb-2" style={{ fontSize: 22 }}>Choose a Registry</h2>
            <p className="text-center mb-8" style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
              A registry endorses your public key. It is your identity provider. You can add more later.
            </p>

            {/* Registry URL */}
            <div className="mb-4">
              <label htmlFor="registry-url" style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                Registry URL
              </label>
              <EndpointInput
                kind="registry"
                discoveryRegistry={normalizeUrl(config.registryUrl, 'registry') ?? undefined}
                id="registry-url"
                type="url"
                placeholder="https://registry.example.com"
                value={registryUrl}
                disabled={loading}
                onValueChange={value => { setRegistryUrl(value); setHandleStatus('idle'); setError('') }}
                aria-describedby="registry-url-help"
                aria-invalid={registryUrl.trim() !== '' && !registryBase}
                className="w-full text-sm outline-none rounded-xl px-4 py-2.5"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#f4f1ea', fontFamily: 'JetBrains Mono, monospace' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
              />
              <p id="registry-url-help" style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                {registryUrl.trim() && !registryBase
                  ? 'Use an HTTPS registry URL without credentials, a query, or a fragment. HTTP is allowed on localhost for development.'
                  : 'Choose any registry. The suggested URL is editable.'}
              </p>
            </div>

            {!restoring && <>
            {/* Handle */}
            <div className="mb-4">
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                Handle
              </label>
              <div className="relative">
                <span
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-sm"
                  style={{ color: 'rgba(255,255,255,0.35)' }}
                >
                  @
                </span>
                <input
                  type="text"
                  placeholder="yourhandle"
                  disabled={loading}
                  aria-label="Handle"
                  value={handle}
                  onChange={e => { setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setHandleStatus('idle') }}
                  className="w-full text-sm outline-none rounded-xl py-2.5 pr-4"
                  style={{
                    paddingLeft: 26,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#f4f1ea',
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                  onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
                />
              </div>
              {handle && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {handleStatus === 'error' && <span className="text-red-300">Could not check availability. <button onClick={() => setAvailabilityAttempt(value => value + 1)} className="underline">Retry</button> or check the registry URL.</span>}
                  {handleStatus === 'checking' && <span style={{ color: 'rgba(255,255,255,0.3)' }}>Checking availability…</span>}
                  {handleStatus === 'available' && <span style={{ color: 'rgba(74,222,128,0.8)' }}>Available ✓</span>}
                  {handleStatus === 'taken' && <span style={{ color: 'rgba(251,191,36,0.8)' }}>Taken on this registry</span>}
                </div>
              )}
              {handle && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: 'rgba(255,255,255,0.25)', fontFamily: 'JetBrains Mono, monospace' }}>
                  @{handle}@{registryBase ? new URL(registryBase).host : ''}
                </div>
              )}
            </div>

            {/* Display name */}
            <div className="mb-4">
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                Display Name <span style={{ color: 'rgba(255,255,255,0.2)', textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
              </label>
              <input
                type="text"
                placeholder="Your Name"
                disabled={loading}
                aria-label="Display name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className="w-full text-sm outline-none rounded-xl px-4 py-2.5"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#f4f1ea' }}
                onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
              />
            </div>

            {/* Recovery email accordion */}
            <div className="mb-6">
              <button
                onClick={() => setRecoveryOpen(o => !o)}
                className="flex items-center gap-2 text-left transition-colors"
                style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.65)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}
              >
                <span style={{ fontSize: 10, transition: 'transform 0.15s' }}>{recoveryOpen ? '▾' : '▸'}</span>
                Add Recovery Email (optional)
              </button>
              {recoveryOpen && (
                <div style={{ marginTop: 10, animation: 'sgFadeUp 0.2s ease' }}>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    disabled={loading}
                    aria-label="Recovery email"
                    value={recoveryEmail}
                    onChange={e => setRecoveryEmail(e.target.value)}
                    className="w-full text-sm outline-none rounded-xl px-4 py-2.5 mb-2"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#f4f1ea' }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
                  />
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
                    {recoveryEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail.trim()) && <span className="block text-red-300">Enter a valid email address.</span>}
                    Only a SHA-256 hash of your email is sent to the registry. Recovery requires support from your registry operator.
                  </p>
                </div>
              )}
            </div>

            </>}

            <button onClick={() => setStep(1)} disabled={loading} className="text-sm text-white/50 mb-4">← Back</button>
            {error && (
              <div className="mb-4 rounded-xl px-4 py-3" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', fontSize: 13, color: 'rgba(248,113,113,0.85)' }}>
                {error}
              </div>
            )}

            <button
              onClick={handleRegister}
              disabled={!canContinueStep2 || loading}
              className="w-full py-3 font-semibold text-sm text-black rounded-xl transition-all"
              style={{ background: '#d6b06a', opacity: canContinueStep2 && !loading ? 1 : 0.45 }}
            >
              {loading ? (restoring ? 'Restoring identity…' : 'Creating identity…') : 'CONTINUE →'}
            </button>
          </div>
        )}

        {/* Step 3 — Confirmation */}
        {step === 3 && summary && (
          <div style={{ animation: 'sgStep 0.3s ease both' }}>
            {/* Animated checkmark */}
            <div
              className="flex items-center justify-center mx-auto mb-6 rounded-full"
              style={{
                width: 72,
                height: 72,
                background: 'rgba(214,176,106,0.1)',
                border: '2px solid rgba(214,176,106,0.35)',
                animation: 'sgGlowPulse 2.5s ease-in-out infinite',
              }}
            >
              <svg width="32" height="32" viewBox="0 0 52 52" fill="none">
                <circle cx="26" cy="26" r="24" stroke="#d6b06a" strokeWidth="2" fill="none" />
                <path
                  d="M14 27l9 9 15-18"
                  stroke="#d6b06a"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  strokeDasharray="52"
                  strokeDashoffset="0"
                  style={{ animation: 'sgCheckDraw 0.6s ease 0.2s both' }}
                />
              </svg>
            </div>

            <h2 className="font-bold text-center mb-1" style={{ fontSize: 22 }}>{restoredRegistration ? 'Identity Restored' : 'Identity Created'}</h2>
            <p className="text-center mb-7" style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>
              Your cryptographic identity is ready.
            </p>

            {error && <p role="alert" className="text-sm text-red-300 mb-3">{error}</p>}
            {/* Summary card */}
            <div
              className="rounded-xl p-4 mb-6"
              style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              {[
                { label: 'Fingerprint', value: summary.fingerprint.slice(0, 32) + '…', mono: true },
                { label: 'Handle', value: summary.handle, mono: true },
                { label: 'Registry', value: registryBase + ' ✓', mono: true },
                { label: 'Key Strength', value: `RSA-${(pendingIdentity?.privateKey.algorithm as RsaKeyAlgorithm | undefined)?.modulusLength ?? ''}`, mono: false },
              ].map(({ label, value, mono }) => (
                <div
                  key={label}
                  className="flex items-start justify-between gap-4 py-2.5"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>{label}</span>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.7)',
                      wordBreak: 'break-all',
                      textAlign: 'right',
                      fontFamily: mono ? 'JetBrains Mono, monospace' : undefined,
                    }}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>

            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginBottom: 20, lineHeight: 1.5 }}>
              Your private key is stored only in this browser and cannot be exported. Keep any original PEM backup safe. Clearing browser data removes access on this device.
            </p>

            <button
              onClick={async () => {
                if (!pendingIdentity) return
                try {
                  await withIdentityLock(async () => {
                    const record = await loadIdentityKey(pendingIdentity)
                    if (!record) throw new Error('This identity was removed locally. Start again or import your PEM backup.')
                    await setIdentity({ ...pendingIdentity, privateKey: record.privateKey, publicKeySpki: record.publicKeySpki })
                    onComplete()
                  })
                }
                catch (err) { setError((err as Error).message) }
              }}
              className="w-full py-3 font-semibold text-sm text-black rounded-xl transition-all"
              style={{ background: '#d6b06a' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#e3c485')}
              onMouseLeave={e => (e.currentTarget.style.background = '#d6b06a')}
            >
              ENTER SIGIL →
            </button>
          </div>
        )}
      </div>
    </div>
  )
})
