import React, { useState, useEffect } from 'react'
import { generateAndStoreKeypair } from '../crypto/keystore'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import { requestChallenge, register } from '../api/registry'
import { useIdentity } from '../store/identity'

interface Props {
  onComplete: () => void
}

type Step = 1 | 2 | 3
type KeypairChoice = 'generate' | 'import' | null

const REGISTRY_URL = (import.meta.env.VITE_REGISTRY_URL as string | undefined) ?? 'localhost:8000'

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
  const [step, setStep] = useState<Step>(1)
  const [keypairChoice, setKeypairChoice] = useState<KeypairChoice>(null)

  // Step 2 fields
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [handleStatus, setHandleStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')

  // Submission state
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<{ fingerprint: string; handle: string } | null>(null)

  const { setIdentity } = useIdentity()

  // Handle availability debounce
  useEffect(() => {
    if (!handle) { setHandleStatus('idle'); return }
    setHandleStatus('checking')
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${REGISTRY_URL}/handle/${encodeURIComponent(handle)}`)
        setHandleStatus(res.ok ? 'taken' : 'available')
      } catch {
        setHandleStatus('idle')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [handle])

  async function handleRegister() {
    setError('')
    setLoading(true)
    try {
      const record = await generateAndStoreKeypair()
      const fp = await fingerprintFromSpki(record.publicKeySpki)

      const spkiB64 = btoa(String.fromCharCode(...new Uint8Array(record.publicKeySpki)))
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`

      const { nonce } = await requestChallenge(fp)

      const enc = new TextEncoder()
      const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', record.privateKey, enc.encode(nonce))
      const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))

      const result = await register({
        public_key: publicKeyPem,
        user_tag: handle,
        display_name: displayName || undefined,
        nonce,
        signature,
      })

      setIdentity({
        fingerprint: result.fingerprint,
        handle: result.handle,
        publicKeySpki: record.publicKeySpki,
        privateKey: record.privateKey,
        stake: null,
      })

      setSummary(result)
      setStep(3)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const canContinueStep1 = keypairChoice !== null
  const canContinueStep2 = handle.length >= 1 && (handleStatus === 'available' || handleStatus === 'idle')

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: '#000', fontFamily: 'Space Grotesk, sans-serif' }}
    >
      <div
        className="w-full"
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
            <h2 className="font-bold text-center mb-2" style={{ fontSize: 22 }}>Establish Your Identity</h2>
            <p className="text-center mb-8" style={{ fontSize: 14, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
              Your private key will be generated in your browser and stored only on this device. It never touches a server.
            </p>

            <div className="grid grid-cols-2 gap-4 mb-6">
              {/* Generate card */}
              <button
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
                  Create a fresh cryptographic identity. Takes under a second.
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
                  Paste or upload a PEM private key from another device or backup.
                </div>
              </button>
            </div>

            {keypairChoice === 'import' && (
              <div className="mb-5 rounded-xl p-4" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <p style={{ fontSize: 12.5, color: 'rgba(251,191,36,0.75)', lineHeight: 1.5 }}>
                  Key import is not yet available in the browser client. Please generate a new keypair or use the desktop app to import an existing key.
                </p>
              </div>
            )}

            <p className="text-center mb-6" style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.25)' }}>
              RSA-4096 · Generated using your browser's Web Crypto API · Non-extractable private key stored in IndexedDB
            </p>

            <button
              onClick={() => keypairChoice === 'import' ? undefined : setStep(2)}
              disabled={!canContinueStep1 || keypairChoice === 'import'}
              className="w-full py-3 font-semibold text-sm text-black rounded-xl transition-all"
              style={{
                background: '#d6b06a',
                opacity: canContinueStep1 && keypairChoice !== 'import' ? 1 : 0.45,
                cursor: canContinueStep1 && keypairChoice !== 'import' ? 'pointer' : 'default',
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

            {/* Registry URL (display-only for now — API module uses env var) */}
            <div className="mb-4">
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                Registry URL
              </label>
              <div
                className="flex items-center px-4 py-2.5 rounded-xl text-sm"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)', fontFamily: 'JetBrains Mono, monospace' }}
              >
                <span className="flex-1">{REGISTRY_URL}</span>
                <span style={{ fontSize: 11, color: 'rgba(74,222,128,0.7)' }}>✓ default</span>
              </div>
            </div>

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
                  value={handle}
                  onChange={e => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
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
                  {handleStatus === 'checking' && <span style={{ color: 'rgba(255,255,255,0.3)' }}>Checking availability…</span>}
                  {handleStatus === 'available' && <span style={{ color: 'rgba(74,222,128,0.8)' }}>Available ✓</span>}
                  {handleStatus === 'taken' && <span style={{ color: 'rgba(251,191,36,0.8)' }}>Taken on this registry</span>}
                </div>
              )}
              {handle && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: 'rgba(255,255,255,0.25)', fontFamily: 'JetBrains Mono, monospace' }}>
                  @{handle}@{REGISTRY_URL}
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
                    value={recoveryEmail}
                    onChange={e => setRecoveryEmail(e.target.value)}
                    className="w-full text-sm outline-none rounded-xl px-4 py-2.5 mb-2"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#f4f1ea' }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
                  />
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
                    Your email is hashed before storage. We never see it. It can only be used to revoke your key if your device is lost.
                  </p>
                </div>
              )}
            </div>

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
              {loading ? 'Creating identity…' : 'CONTINUE →'}
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

            <h2 className="font-bold text-center mb-1" style={{ fontSize: 22 }}>Identity Created</h2>
            <p className="text-center mb-7" style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>
              Your cryptographic identity is ready.
            </p>

            {/* Summary card */}
            <div
              className="rounded-xl p-4 mb-6"
              style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              {[
                { label: 'Fingerprint', value: summary.fingerprint.slice(0, 32) + '…', mono: true },
                { label: 'Handle', value: summary.handle, mono: true },
                { label: 'Registry', value: REGISTRY_URL + ' ✓', mono: true },
                { label: 'Key Strength', value: 'RSA-4096', mono: false },
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
              Your private key is stored in your browser's secure storage. Back it up if you want to use SIGIL on another device.
            </p>

            {/* Export key button (non-functional — keys are non-extractable) */}
            <button
              disabled
              className="w-full py-2 rounded-xl text-sm mb-3 font-medium disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.5)' }}
              title="Non-extractable keys cannot be exported from the browser"
            >
              Export Private Key (PEM)
            </button>

            <button
              onClick={onComplete}
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
