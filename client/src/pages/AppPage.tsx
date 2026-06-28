import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useIdentity } from '../store/identity'
import { BrokerClient } from '../api/broker'
import { saveNote, getNotesByChannel, hasNote, deleteNotesByAuthor } from '../store/notes'
import { verifyUnt } from '../crypto/unt'
import { importPublicKeyPem } from '../crypto/jwt'
import { fetchRegistryPublicKey, lookupKey } from '../api/registry'
import { loadKeypair } from '../crypto/keystore'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import type { Note, ServerCommand } from '../types/protocol'
import Header from '../components/Header'
import Sidebar, { type ChannelItem } from '../components/Sidebar'
import NoteList from '../components/MasonryGrid'
import BottomBar from '../components/BottomBar'

const DEFAULT_BROKER = import.meta.env.VITE_DEFAULT_BROKER_URL as string
const DEFAULT_REGISTRY = (import.meta.env.VITE_REGISTRY_URL as string | undefined) ?? 'localhost:8000'

export default React.memo(function AppPage() {
  const { identity } = useIdentity()
  const [connected, setConnected] = useState(false)
  const [channels, setChannels] = useState<ChannelItem[]>([
    { name: 'general', unread: 0 },
    { name: 'crypto', unread: 0 },
    { name: 'dev', unread: 0 },
    { name: 'signal', unread: 0 },
  ])
  const [activeChannel, setActiveChannel] = useState('general')
  const [notes, setNotes] = useState<Note[]>([])
  const [broker, setBroker] = useState<BrokerClient | null>(null)
  const [registryKey, setRegistryKey] = useState<CryptoKey | null>(null)

  // Settings panel
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  // Registries / stake provider
  const derivedRegistry = identity?.handle?.split('@').slice(-1)[0] ?? DEFAULT_REGISTRY
  const [registries, setRegistries] = useState<string[]>([derivedRegistry])
  const [selectedRegistry, setSelectedRegistry] = useState(derivedRegistry)

  // Add Registry modal
  const [addRegistryOpen, setAddRegistryOpen] = useState(false)
  const [modalUrl, setModalUrl] = useState('')
  const [modalConnecting, setModalConnecting] = useState(false)
  const [modalReachable, setModalReachable] = useState(false)
  const [modalConnError, setModalConnError] = useState('')
  const [modalHandle, setModalHandle] = useState('')
  const [modalHandleStatus, setModalHandleStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
  const [modalRegistering, setModalRegistering] = useState(false)
  const [modalRegError, setModalRegError] = useState('')

  // Key cache: fingerprint → CryptoKey
  const keyCache = useRef(new Map<string, CryptoKey>())
  const fetchAuthorKey = useCallback(async (fp: string): Promise<CryptoKey> => {
    if (keyCache.current.has(fp)) return keyCache.current.get(fp)!
    const { public_key } = await lookupKey(fp)
    const key = await importPublicKeyPem(public_key)
    keyCache.current.set(fp, key)
    return key
  }, [])

  useEffect(() => {
    fetchRegistryPublicKey()
      .then(pem => importPublicKeyPem(pem))
      .then(setRegistryKey)
      .catch(console.error)
  }, [])

  const activeChannelRef = useRef(activeChannel)
  useEffect(() => { activeChannelRef.current = activeChannel }, [activeChannel])

  const handleMessage = useCallback(
    async (msg: ServerCommand) => {
      if (!registryKey) return

      if (msg.type === 'note_response') {
        try {
          const note = await verifyUnt(msg.unt, registryKey, fetchAuthorKey)
          if (await hasNote(note.jti)) return
          await saveNote(note)
          if (note.channel === activeChannelRef.current) {
            setNotes(prev => [...prev, note])
          } else {
            setChannels(prev =>
              prev.map(ch => ch.name === note.channel ? { ...ch, unread: ch.unread + 1 } : ch)
            )
          }
        } catch {
          // drop unverifiable notes
        }
      }

      if (msg.type === 'revoke_key') {
        await deleteNotesByAuthor(msg.fingerprint)
        setNotes(prev => prev.filter(n => n.authorFp !== msg.fingerprint))
      }
    },
    [registryKey, fetchAuthorKey],
  )

  useEffect(() => {
    const client = new BrokerClient(DEFAULT_BROKER, handleMessage, setConnected)
    setBroker(client)
    return () => client.close()
  }, [handleMessage])

  useEffect(() => {
    if (!broker || !identity) return
    broker.send({ type: 'subscribe', channel: activeChannel, unt: identity.stake ?? '' })
    getNotesByChannel(activeChannel).then(setNotes)
  }, [broker, activeChannel, identity])

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return
    function onDoc(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [settingsOpen])

  // Handle availability check (debounced)
  useEffect(() => {
    if (!modalHandle || !modalReachable || !modalUrl) {
      setModalHandleStatus('idle')
      return
    }
    setModalHandleStatus('checking')
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${modalUrl}/handle/${encodeURIComponent(modalHandle)}`)
        setModalHandleStatus(res.ok ? 'taken' : 'available')
      } catch {
        setModalHandleStatus('available')
      }
    }, 600)
    return () => clearTimeout(t)
  }, [modalHandle, modalReachable, modalUrl])

  function handleSelectChannel(name: string) {
    setActiveChannel(name)
    setChannels(prev => prev.map(ch => ch.name === name ? { ...ch, unread: 0 } : ch))
  }

  function handleAddChannel(ch: string) {
    setChannels(prev => {
      if (prev.some(c => c.name === ch)) return prev
      return [...prev, { name: ch, unread: 0 }]
    })
  }

  const sendNote = useCallback(
    async (_body: string) => {
      if (!broker || !identity?.stake) return
      broker.send({
        type: 'note_response',
        channel: activeChannel,
        unt: identity.stake,
      })
    },
    [broker, identity, activeChannel],
  )

  async function connectRegistry() {
    if (!modalUrl) return
    setModalConnecting(true)
    setModalConnError('')
    setModalReachable(false)
    try {
      const url = modalUrl.replace(/\/$/, '')
      const res = await fetch(`${url}/registry/public-key`)
      if (res.ok) {
        setModalReachable(true)
      } else {
        setModalConnError('Could not reach this registry')
      }
    } catch {
      setModalConnError('Could not reach this registry')
    } finally {
      setModalConnecting(false)
    }
  }

  async function registerOnRegistry() {
    if (!identity || !modalHandle || !modalUrl) return
    setModalRegistering(true)
    setModalRegError('')
    try {
      const record = await loadKeypair()
      if (!record) throw new Error('No keypair found in this browser')

      const fp = await fingerprintFromSpki(record.publicKeySpki)
      const spkiB64 = btoa(String.fromCharCode(...new Uint8Array(record.publicKeySpki)))
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`

      const url = modalUrl.replace(/\/$/, '')
      const challengeRes = await fetch(`${url}/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: fp }),
      })
      if (!challengeRes.ok) throw new Error('Challenge request failed')
      const { nonce } = await challengeRes.json() as { nonce: string }

      const enc = new TextEncoder()
      const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', record.privateKey, enc.encode(nonce))
      const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))

      const regRes = await fetch(`${url}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: publicKeyPem, user_tag: modalHandle, nonce, signature }),
      })
      if (!regRes.ok) {
        const err = await regRes.json().catch(() => ({})) as { detail?: string }
        throw new Error(err.detail ?? 'Registration failed')
      }

      setRegistries(prev => [...new Set([...prev, url])])
      setSelectedRegistry(url)
      setAddRegistryOpen(false)
      setModalUrl('')
      setModalHandle('')
      setModalReachable(false)
      setModalHandleStatus('idle')
    } catch (e) {
      setModalRegError((e as Error).message)
    } finally {
      setModalRegistering(false)
    }
  }

  const relayCount = connected ? 1 : 0

  return (
    <div className="h-screen flex flex-col bg-black text-[#f4f1ea] overflow-hidden" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
      <Header
        channelTitle={activeChannel}
        relayCount={relayCount}
        settingsOpen={settingsOpen}
        onToggleSettings={e => { e.stopPropagation(); setSettingsOpen(o => !o) }}
      />

      <div className="flex flex-1 overflow-hidden relative">
        <Sidebar
          channels={channels}
          activeChannel={activeChannel}
          onSelect={handleSelectChannel}
          onAddChannel={handleAddChannel}
        />

        <main className="flex-1 overflow-y-auto">
          <NoteList notes={notes} />
        </main>

        {/* Settings panel */}
        {settingsOpen && (
          <div
            ref={settingsRef}
            className="absolute z-40 rounded-2xl overflow-hidden"
            style={{
              top: 12,
              right: 12,
              width: 296,
              background: 'rgba(12,12,12,0.97)',
              border: '1px solid rgba(255,255,255,0.08)',
              backdropFilter: 'blur(20px)',
              animation: 'sgSlideDown 0.18s ease',
            }}
          >
            {/* Identity */}
            <div className="px-4 pt-4 pb-3">
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8 }}>
                Identity
              </div>
              <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] transition-colors text-left" style={{ color: 'rgba(255,255,255,0.7)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span style={{ color: 'rgba(255,255,255,0.4)' }}>↻</span>
                Rotate Key
                <span className="ml-auto" style={{ color: 'rgba(255,255,255,0.2)' }}>›</span>
              </button>
              <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] transition-colors text-left" style={{ color: 'rgba(248,113,113,0.7)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span>⚠</span>
                Revoke Key
                <span className="ml-auto" style={{ color: 'rgba(255,255,255,0.2)' }}>›</span>
              </button>
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '12px 16px' }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 4 }}>
                Stake Provider
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginBottom: 10 }}>
                Registry that endorses your next note
              </div>
              {registries.map(r => (
                <button
                  key={r}
                  onClick={() => setSelectedRegistry(r)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors"
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0"
                    style={{ borderColor: r === selectedRegistry ? '#d6b06a' : 'rgba(255,255,255,0.2)' }}
                  >
                    {r === selectedRegistry && (
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#d6b06a' }} />
                    )}
                  </span>
                  <span className="flex-1 truncate text-left" style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontFamily: 'JetBrains Mono, monospace' }}>
                    {identity?.handle ? `@${identity.handle.replace(/^@/, '').split('@')[0]} · ` : ''}{r}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: connected ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.5)' }} />
                </button>
              ))}
              <button
                onClick={() => { setAddRegistryOpen(true); setSettingsOpen(false) }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left"
                style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: 'rgba(255,255,255,0.2)' }}>+</span>
                Add Registry
              </button>
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '12px 16px 16px' }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8 }}>
                Brokers
              </div>
              <div className="flex items-center gap-3 px-3 py-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: connected ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.5)' }} />
                <span className="flex-1 truncate" style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: 'JetBrains Mono, monospace' }}>
                  {DEFAULT_BROKER || 'ws://localhost:8080/ws'}
                </span>
                {connected && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>live</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      <BottomBar
        handle={identity?.handle ?? '@user'}
        registries={registries}
        selectedRegistry={selectedRegistry}
        onSelectRegistry={setSelectedRegistry}
        onSend={sendNote}
      />

      {/* Add Registry modal */}
      {addRegistryOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.75)', animation: 'sgFadeIn 0.2s ease' }}
          onMouseDown={() => setAddRegistryOpen(false)}
        >
          <div
            className="rounded-2xl w-full relative"
            style={{
              maxWidth: 480,
              margin: '0 16px',
              background: 'rgba(12,12,12,0.98)',
              border: '1px solid rgba(255,255,255,0.1)',
              backdropFilter: 'blur(20px)',
              padding: 32,
              animation: 'sgFadeUp 0.2s ease',
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            <button
              onClick={() => setAddRegistryOpen(false)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
              style={{ color: 'rgba(255,255,255,0.3)', fontSize: 18 }}
              onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.7)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
            >
              ✕
            </button>

            <h2 className="text-lg font-semibold mb-1">Add Registry</h2>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginBottom: 24, lineHeight: 1.5 }}>
              Registries are identity providers. Your same keypair can be registered on multiple registries with different handles.
            </p>

            {/* URL */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                Registry URL
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={modalUrl}
                  onChange={e => { setModalUrl(e.target.value); setModalReachable(false); setModalConnError('') }}
                  placeholder="https://"
                  className="flex-1 text-sm outline-none rounded-xl px-4 py-2.5"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#f4f1ea' }}
                  onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                  onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
                />
                <button
                  onClick={connectRegistry}
                  disabled={!modalUrl || modalConnecting}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-40"
                  style={{ border: '1px solid rgba(214,176,106,0.4)', color: '#d6b06a', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(214,176,106,0.1)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {modalConnecting ? '…' : 'Connect'}
                </button>
              </div>
              {modalReachable && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(74,222,128,0.85)' }}>Registry reachable ✓</div>
              )}
              {modalConnError && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(248,113,113,0.85)' }}>{modalConnError}</div>
              )}
            </div>

            {/* Handle (shown after connect) */}
            {modalReachable && (
              <div style={{ marginBottom: 24, animation: 'sgFadeUp 0.2s ease' }}>
                <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                  Choose Your Handle
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>@</span>
                  <input
                    type="text"
                    value={modalHandle}
                    onChange={e => setModalHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    placeholder="handle"
                    className="w-full text-sm outline-none rounded-xl py-2.5 pr-4"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#f4f1ea', paddingLeft: 28 }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.4)')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
                  />
                </div>
                {modalHandleStatus === 'checking' && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>Checking availability…</div>
                )}
                {modalHandleStatus === 'available' && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(74,222,128,0.85)' }}>Available ✓</div>
                )}
                {modalHandleStatus === 'taken' && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(251,191,36,0.85)' }}>Taken — choose another</div>
                )}
              </div>
            )}

            {/* Register button */}
            {modalReachable && modalHandle && modalHandleStatus === 'available' && (
              <div style={{ animation: 'sgFadeUp 0.15s ease' }}>
                {modalRegError && (
                  <div style={{ marginBottom: 12, fontSize: 12, color: 'rgba(248,113,113,0.85)' }}>{modalRegError}</div>
                )}
                <button
                  onClick={registerOnRegistry}
                  disabled={modalRegistering}
                  className="w-full py-3 rounded-xl font-semibold text-sm text-black transition-all disabled:opacity-50"
                  style={{ background: '#d6b06a' }}
                >
                  {modalRegistering ? 'Registering…' : 'Register on this Registry →'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
