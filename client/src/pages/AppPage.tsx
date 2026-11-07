import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useIdentity } from '../store/identity'
import { BrokerPool } from '../api/brokerPool'
import { saveNoteIfNew, getNotesByChannel, getHistoryPage } from '../store/notes'
import { verifyUnt, buildUnt, buildCommand } from '../crypto/unt'
import { importPublicKeyPem } from '../crypto/jwt'
import { fetchRegistryPublicKey, requestChallenge, requestStake, register, isHandleAvailable, lookupKey, RegistryError } from '../api/registry'
import { loadKeypair } from '../crypto/keystore'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import type { Note, UNTFrame, StakeFrame } from '../types/protocol'
import Header from '../components/Header'
import Sidebar, { type ChannelItem } from '../components/Sidebar'
import NoteFeed from '../components/NoteFeed'
import { mergeNotes } from '../store/feed'
import BottomBar from '../components/BottomBar'
import { createRegistryKeyring, registryIssuer, verifyStake, type RegistryKeyring } from '../crypto/registryTrust'
import { config, normalizeUrl } from '../config'
import { PeerHistory, peerFingerprint, type HistoryStatus } from '../history/peerHistory'
import { loadPreferences, savePreferences } from '../store/preferences'

export default React.memo(function AppPage() {
  const { identity } = useIdentity()
  const [preferences, setPreferences] = useState(() => {
    const url = normalizeUrl(identity?.registryUrl ?? config.registryUrl, 'registry')
    return loadPreferences(identity!.fingerprint, url ? { url, handle: identity!.handle } : undefined)
  })
  const { brokerUrls, registries: accounts, selectedRegistry, activeChannel } = preferences
  const registries = accounts.map(account => account.url)
  const selectedAccount = accounts.find(account => account.url === selectedRegistry)
  const registryUrl = selectedRegistry
  const [brokerDraft, setBrokerDraft] = useState('')
  const [connections, setConnections] = useState<Record<string, boolean>>({})
  const connectedUrls = Object.keys(connections).filter(url => connections[url]).sort()
  const connected = connectedUrls.length > 0
  const [unread, setUnread] = useState<Record<string, number>>({})
  const channels: ChannelItem[] = preferences.channels.map(name => ({ name, unread: unread[name] ?? 0 }))
  const [notes, setNotes] = useState<Note[]>([])
  const [registryRefresh, setRegistryRefresh] = useState(0)
  const [registryKeys, setRegistryKeys] = useState<RegistryKeyring>(new Map())
  const registryKey = registryUrl ? registryKeys.get(registryIssuer(registryUrl)) : undefined
  const [error, setError] = useState('')
  const historyPeerId = useRef(crypto.randomUUID())
  const history = useRef(new Map<string, PeerHistory>())
  const [historyStatuses, setHistoryStatuses] = useState<Record<string, HistoryStatus>>({})
  const statusList = Object.values(historyStatuses)
  const historyStatus = statusList.length ? {
    phase: statusList.some(s => s.phase === 'syncing') ? 'syncing' : statusList.some(s => s.phase === 'incomplete') ? 'incomplete' : statusList.some(s => s.phase === 'synced') ? 'synced' : 'no-peers',
    received: statusList.reduce((sum, s) => sum + s.received, 0),
    skipped: statusList.reduce((sum, s) => sum + (s.skipped ?? 0), 0),
  } : null
  const [followToken, setFollowToken] = useState(0)
  const handleFrameRef = useRef<(url: string, frame: UNTFrame) => Promise<void>>(async () => {})
  const [brokers] = useState(() => new BrokerPool({
    onFrame: (url, frame) => { void handleFrameRef.current(url, frame).catch(console.error) },
    onChange: setConnections,
    onError: error => setError(error.message),
  }))
  const [replyTo, setReplyTo] = useState<Note | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  const setSelectedRegistry = (url: string) => setPreferences(prev => ({ ...prev, selectedRegistry: url }))

  useEffect(() => {
    try { savePreferences(identity!.fingerprint, preferences) }
    catch { setError('Could not save settings in this browser.') }
  }, [identity?.fingerprint, preferences])

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

  const stakeCache = useRef(new Map<string, StakeFrame>())
  const registryUrls = JSON.stringify(registries)
  useEffect(() => {
    let cancelled = false
    setRegistryKeys(new Map())
    stakeCache.current.clear()
    const urls = JSON.parse(registryUrls) as string[]
    Promise.all(urls.map(async url => {
      try {
        const key = await importPublicKeyPem(await fetchRegistryPublicKey(url))
        return [url, key] as const
      } catch (err) {
        if (!cancelled) setError(`Registry ${url}: ${(err as Error).message}`)
        return null
      }
    })).then(entries => {
      if (cancelled) return
      try { setRegistryKeys(createRegistryKeyring(entries.filter(entry => entry !== null))) }
      catch (err) { setError((err as Error).message) }
    })
    return () => { cancelled = true }
  }, [registryUrls, registryRefresh])

  const getStake = useCallback(async (): Promise<StakeFrame> => {
    if (!identity || !registryUrl) throw new Error('Choose a registered stake provider in Settings.')
    const cached = stakeCache.current.get(registryUrl)
    const providerKey = registryKeys.get(registryIssuer(registryUrl))
    if (!providerKey) throw new Error('Registry verification key is not available. Reconnect the registry.')
    const providerKeys = createRegistryKeyring([[registryUrl, providerKey]])
    if (cached && Math.floor(Date.now() / 1000) - cached[0].iat < 25) {
      await verifyStake(cached, providerKeys)
      return cached
    }
    const { nonce } = await requestChallenge(identity.fingerprint, registryUrl)
    const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', identity.privateKey, new TextEncoder().encode(nonce))
    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    const { stake } = await requestStake({ fingerprint: identity.fingerprint, nonce, signature }, registryUrl)
    const claims = await verifyStake(stake, providerKeys)
    if (await peerFingerprint(claims.public_key) !== 'sha256:' + identity.fingerprint) throw new Error('Registry returned a stake for a different key.')
    const handle = `@${claims.user_tag.replace(/^@/, '')}@${claims.iss}`
    setPreferences(prev => {
      const account = prev.registries.find(account => account.url === registryUrl)
      if (!account || account.handle === handle) return prev
      return { ...prev, registries: prev.registries.map(account => account.url === registryUrl ? { ...account, handle } : account) }
    })
    stakeCache.current.set(registryUrl, stake)
    return stake
  }, [identity, registryUrl, registryKeys])

  const verifyNote = useCallback((frame: UNTFrame) => verifyUnt(frame, registryKeys), [registryKeys])

  const activeChannelRef = useRef(activeChannel)
  useEffect(() => { activeChannelRef.current = activeChannel }, [activeChannel])

  const acceptNote = useCallback((note: Note) => {
    if (note.channel === activeChannelRef.current) {
      setNotes(prev => mergeNotes(prev, [note]))
    } else {
      setUnread(prev => ({ ...prev, [note.channel]: (prev[note.channel] ?? 0) + 1 }))
    }
  }, [])

  const handleFrame = useCallback(async (url: string, frame: UNTFrame) => {
    const type = frame?.[0]?.type
    if (type === 'request_notes' || type === 'note_relay') {
      await history.current.get(url)?.handle(frame)
    } else if (type === 'note') {
      const note = await verifyNote(frame)
      if (await saveNoteIfNew(note)) acceptNote(note)
    }
  }, [verifyNote, acceptNote])

  useEffect(() => { handleFrameRef.current = handleFrame }, [handleFrame])
  useEffect(() => () => brokers.close(), [brokers])
  const brokerList = JSON.stringify(brokerUrls)
  useEffect(() => { brokers.updateUrls(JSON.parse(brokerList) as string[]) }, [brokers, brokerList])

  // Local history remains available while disconnected.
  useEffect(() => {
    let cancelled = false
    setNotes([])
    setReplyTo(null)
    if (activeChannel) getNotesByChannel(activeChannel).then(async cached => {
      const verified: Note[] = []
      for (const note of cached) {
        try { verified.push(await verifyNote(JSON.parse(note.raw) as UNTFrame)) }
        catch { /* Old cached notes must satisfy the current registry trust mapping. */ }
      }
      if (!cancelled) setNotes(prev => mergeNotes(prev, verified))
    }).catch(err => { if (!cancelled) setError((err as Error).message) })
    return () => { cancelled = true }
  }, [activeChannel, verifyNote])

  const joinedChannels = JSON.stringify(preferences.channels)
  const connectedBrokers = JSON.stringify(connectedUrls)
  useEffect(() => {
    setHistoryStatuses({})
    if (!identity || !registryKey) return
    const urls = JSON.parse(connectedBrokers) as string[]
    if (!urls.length) return
    let cancelled = false
    const sessions = new Map<string, PeerHistory>()
    for (const url of urls) {
      sessions.set(url, new PeerHistory({
        fingerprint: 'sha256:' + identity.fingerprint,
        peerId: historyPeerId.current,
        privateKey: identity.privateKey,
        keys: registryKeys,
        getStake,
        // History replies and continuation requests stay on the arrival broker.
        send: frame => brokers.sendTo(url, frame),
        readPage: getHistoryPage,
        save: saveNoteIfNew,
        onNote: acceptNote,
        onStatus: (channel, status) => { if (!cancelled && channel === activeChannelRef.current) setHistoryStatuses(prev => ({ ...prev, [url]: status })) },
        onError: err => { if (!cancelled) setError(err.message) },
        batchSize: config.historyBatchSize,
        maxFrameBytes: config.maxFrameBytes,
        timeoutMs: config.historyTimeoutMs,
      }))
    }
    history.current = sessions
    void (async () => {
      try {
        const stake = await getStake()
        await Promise.all(urls.map(async url => {
          try {
            for (const channel of JSON.parse(joinedChannels) as string[]) {
              const frame = await buildCommand('subscribe', channel, stake, identity.privateKey)
              if (cancelled) return
              brokers.sendTo(url, frame)
            }
            if (activeChannel && !cancelled) await sessions.get(url)!.start(activeChannel)
          } catch (err) {
            if (!cancelled) {
              setError((err as Error).message)
              setHistoryStatuses(prev => ({ ...prev, [url]: { phase: 'incomplete', peers: 0, received: 0 } }))
            }
          }
        }))
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message)
          setHistoryStatuses(Object.fromEntries(urls.map(url => [url, { phase: 'incomplete', peers: 0, received: 0 }])))
        }
      }
    })()
    return () => {
      cancelled = true
      for (const session of sessions.values()) session.dispose()
      if (history.current === sessions) history.current = new Map()
    }
  }, [brokers, joinedChannels, connectedBrokers, activeChannel, identity, getStake, registryKey, registryKeys, acceptNote])

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
    const controller = new AbortController()
    setModalHandleStatus('checking')
    const t = setTimeout(async () => {
      try {
        const available = await isHandleAvailable(modalUrl, modalHandle, controller.signal)
        if (!controller.signal.aborted) setModalHandleStatus(available ? 'available' : 'taken')
      } catch (err) {
        if (!controller.signal.aborted) {
          setModalHandleStatus('idle')
          setModalRegError((err as Error).message)
        }
      }
    }, 600)
    return () => { clearTimeout(t); controller.abort() }
  }, [modalHandle, modalReachable, modalUrl])

  function handleSelectChannel(name: string) {
    activeChannelRef.current = name
    setPreferences(prev => ({ ...prev, activeChannel: name }))
    setUnread(prev => ({ ...prev, [name]: 0 }))
  }

  function handleAddChannel(name: string) {
    setPreferences(prev => ({ ...prev, channels: [...new Set([...prev.channels, name])], activeChannel: name }))
    activeChannelRef.current = name
  }

  async function sendNote(content: string) {
    if (new TextEncoder().encode(content).length > config.maxNoteBytes) throw new Error(`Note exceeds the configured ${config.maxNoteBytes}-byte limit.`)
    if (!identity || !registryKey || !connected || !activeChannel) throw new Error('Connect a broker, choose a registry, and join a channel before sending.')
    const channel = activeChannel
    const stake = await getStake()
    const frame = await buildUnt(content, channel, stake, identity.privateKey, replyTo?.jti)
    const note = await verifyNote(frame)
    const publication = brokers.publish(frame)
    if (publication.failed.length) setError(`Note sent, but ${publication.failed.length} broker connection(s) failed.`)
    try {
      await saveNoteIfNew(note)
    } catch {
      setError('Note was sent, but could not be saved in this browser.')
    }
    if (activeChannelRef.current === channel) {
      setNotes(prev => mergeNotes(prev, [note]))
      setReplyTo(null)
      setFollowToken(token => token + 1)
    }
  }

  function updateBroker(e: React.FormEvent) {
    e.preventDefault()
    const url = normalizeUrl(brokerDraft, 'broker')
    if (!url) { setError('Enter a valid ws:// or wss:// broker URL.'); return }
    setError('')
    setPreferences(prev => ({ ...prev, brokerUrls: [...new Set([...prev.brokerUrls, url])] }))
    setBrokerDraft('')
  }

  async function connectRegistry() {
    if (!modalUrl || modalConnecting || modalRegistering) return
    setModalConnecting(true)
    setModalConnError('')
    setModalReachable(false)
    try {
      const url = normalizeUrl(modalUrl, 'registry')
      if (!url) throw new Error('Use HTTPS for registries, or HTTP on localhost for development.')
      const registryKey = await importPublicKeyPem(await fetchRegistryPublicKey(url))
      try {
        await lookupKey(identity!.fingerprint, url)
        const { nonce } = await requestChallenge(identity!.fingerprint, url)
        const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', identity!.privateKey, new TextEncoder().encode(nonce))
        const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
        const { stake } = await requestStake({ fingerprint: identity!.fingerprint, nonce, signature }, url)
        const claims = await verifyStake(stake, createRegistryKeyring([[url, registryKey]]))
        setPreferences(prev => ({ ...prev, registries: [...prev.registries.filter(account => account.url !== url), { url, handle: `@${claims.user_tag.replace(/^@/, '')}@${claims.iss}` }], selectedRegistry: url }))
        setAddRegistryOpen(false)
        setModalUrl('')
        setModalHandle('')
        return
      } catch (err) {
        if (!(err instanceof RegistryError && err.status === 404)) throw err
      }
      setModalUrl(url)
      setModalReachable(true)
    } catch (err) {
      setModalConnError((err as Error).message)
    } finally {
      setModalConnecting(false)
    }
  }

  async function registerOnRegistry() {
    if (!identity || !modalHandle || !modalUrl || !modalReachable || modalRegistering) return
    setModalRegistering(true)
    setModalRegError('')
    try {
      const record = await loadKeypair()
      if (!record) throw new Error('No keypair found in this browser')

      const fp = await fingerprintFromSpki(record.publicKeySpki)
      const spkiB64 = btoa(String.fromCharCode(...new Uint8Array(record.publicKeySpki)))
      const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`

      const url = modalUrl.replace(/\/$/, '')
      const { nonce } = await requestChallenge(fp, url)

      const enc = new TextEncoder()
      const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', record.privateKey, enc.encode(nonce))
      const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))

      const result = await register({ public_key: publicKeyPem, user_tag: modalHandle, nonce, signature }, url)
      setPreferences(prev => ({
        ...prev,
        registries: [...prev.registries.filter(account => account.url !== url), { url, handle: result.handle }],
        selectedRegistry: url,
      }))
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

  const relayCount = connectedUrls.length

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

        <main className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
          {activeChannel && <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2 text-xs text-white/45 border-b border-white/5">
            <span role="status">{!connected ? 'Offline · showing stored notes' : historyStatus?.phase === 'syncing' ? `Fetching peer history · ${historyStatus.received} notes received` : historyStatus?.phase === 'synced' ? `History checked on ${statusList.length} broker${statusList.length === 1 ? '' : 's'}${historyStatus.skipped ? ` · ${historyStatus.skipped} unverified entries skipped` : ''}` : historyStatus?.phase === 'no-peers' ? 'No peers replied · stored notes remain available' : historyStatus?.phase === 'incomplete' ? 'History transfer incomplete · retry to continue' : 'Preparing peer history'}</span>
            <button disabled={!connected || !registryKey || historyStatus?.phase === 'syncing'} onClick={() => { for (const session of history.current.values()) void session.start(activeChannel) }} className="text-gold disabled:opacity-40 shrink-0">Refresh history</button>
          </div>}
          <NoteFeed channel={activeChannel} notes={notes} onReply={setReplyTo} followToken={followToken} emptyMessage={activeChannel ? "No notes in this channel yet." : "Add a channel to read and write notes."} />
        </main>

        {/* Settings panel */}
        {settingsOpen && (
          <div
            ref={settingsRef}
            className="absolute z-40 rounded-2xl overflow-y-auto"
            style={{
              top: 12,
              right: 12,
              width: 'min(296px, calc(100% - 24px))',
              maxHeight: 'calc(100% - 24px)',
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
              <p className="text-xs break-all text-white/60">{selectedAccount?.handle ?? identity?.handle}</p>
              <p className="mt-2 text-xs break-all text-white/40">{identity?.fingerprint}</p>
              <p className="mt-2 text-xs text-white/40">Key rotation and revocation are not available in this client.</p>
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '12px 16px' }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 4 }}>
                Stake Provider
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginBottom: 10 }}>
                Registry that endorses your next note
              </div>
              <button className="text-xs text-gold mb-2" onClick={() => { stakeCache.current.clear(); setRegistryRefresh(value => value + 1) }}>Refresh registry connections</button>
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
                    {accounts.find(account => account.url === r)?.handle} · {r}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" title={registryKeys.has(registryIssuer(r)) ? 'Verification key loaded' : 'Verification key unavailable'} style={{ background: registryKeys.has(registryIssuer(r)) ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.5)' }} />
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
              {brokerUrls.length === 0 && <p className="text-xs text-white/40">No brokers configured</p>}
              {brokerUrls.map(url => <div key={url} className="flex items-center gap-2 py-2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: connections[url] ? 'rgba(74,222,128,0.7)' : 'rgba(248,113,113,0.5)' }} />
                <div className="flex-1 min-w-0">
                  <p className="truncate text-xs text-white/60" title={url}>{url}</p>
                  <p className="text-[11px] text-white/40">{connections[url] ? 'Connected' : 'Connecting / retrying'}</p>
                </div>
                <button className="text-white/50 px-2" aria-label={`Remove broker ${url}`} title="Remove broker" onClick={() => setPreferences(prev => ({ ...prev, brokerUrls: prev.brokerUrls.filter(value => value !== url) }))}>×</button>
              </div>)}
              <form onSubmit={updateBroker} className="flex flex-col gap-2 mt-3">
                <label htmlFor="broker-url" className="text-xs text-white/50">Broker WebSocket URL</label>
                <input id="broker-url" value={brokerDraft} onChange={e => setBrokerDraft(e.target.value)} placeholder="wss://" className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-xs" />
                <button className="text-xs text-gold border border-white/10 rounded-lg p-2" type="submit">Add broker</button>
                {brokerUrls.length > 0 && <button type="button" className="text-xs text-white/50" onClick={() => setPreferences(prev => ({ ...prev, brokerUrls: [] }))}>Disconnect all brokers</button>}
              </form>
            </div>
          </div>
        )}
      </div>

      {error && <div role="alert" className="px-4 py-2 text-sm text-red-300 flex justify-between gap-3">
        {error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button>
      </div>}
      <BottomBar
        handle={selectedAccount?.handle ?? identity?.handle ?? ''}
        registries={registries}
        selectedRegistry={selectedRegistry}
        onSelectRegistry={setSelectedRegistry}
        onSend={sendNote}
        disabled={!connected || !registryKey || !activeChannel}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />

      {/* Add Registry modal */}
      {addRegistryOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.75)', animation: 'sgFadeIn 0.2s ease' }}
          onMouseDown={() => { if (!modalRegistering && !modalConnecting) setAddRegistryOpen(false) }}
        >
          <div
            className="rounded-2xl w-full relative overflow-y-auto"
            style={{
              maxWidth: 480,
              maxHeight: '90vh',
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
              disabled={modalRegistering || modalConnecting}
              aria-label="Close registry dialog"
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
                  disabled={modalConnecting || modalRegistering}
                  aria-label="Registry URL"
                  value={modalUrl}
                  onChange={e => { setModalUrl(e.target.value); setModalReachable(false); setModalConnError(''); setModalRegError('') }}
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
                <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(74,222,128,0.85)' }}>Registry verification key loaded ✓</div>
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
                    disabled={modalRegistering}
                    aria-label="Handle"
                    value={modalHandle}
                    onChange={e => { setModalHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setModalHandleStatus('idle'); setModalRegError('') }}
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

            {modalRegError && <div role="alert" className="mb-3 text-sm text-red-300">{modalRegError}</div>}
            {/* Register button */}
            {modalReachable && modalHandle && modalHandleStatus === 'available' && (
              <div style={{ animation: 'sgFadeUp 0.15s ease' }}>
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
