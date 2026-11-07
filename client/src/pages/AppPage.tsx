import './AppPage.css'
import { PeerNoteRequests } from '../history/peerNoteRequests'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { readIdentitySummaries, type IdentitySummary } from '../store/identityInventory'
import { deleteLocalIdentity, deleteEveryLocalIdentity, ALL_LOCAL_KEYS_CONFIRMATION } from '../store/localIdentityDeletion'
import { useIdentity } from '../store/identity'
import { BrokerPool } from '../api/brokerPool'
import { saveNoteIfNew, getNotesByChannel, getHistoryPage, getNoteByJti } from '../store/notes'
import { verifyUnt, buildUnt, buildCommand } from '../crypto/unt'
import { importPublicKeyPem } from '../crypto/jwt'
import { fetchRegistryPublicKey, requestChallenge, requestStake, register, isHandleAvailable, lookupKey, RegistryError } from '../api/registry'
import { loadKeypair, loadIdentityKey, storeKeypair, finishRotation, deleteIdentityKeys, deleteKeypair, importKeypair, type KeyRecord } from '../crypto/keystore'
import { rotateRegistry, revokeRegistry, withIdentityLock, signNonce, publicKeyPem } from '../crypto/keyLifecycle'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import type { Note, UNTFrame, StakeFrame } from '../types/protocol'
import Header from '../components/Header'
import EndpointInput from '../components/EndpointInput'
import { queueAdvertisement } from '../discovery/advertiser'
import { useKeyGeneration } from '../components/KeyGeneration'
import Sidebar, { type ChannelItem } from '../components/Sidebar'
import NoteFeed from '../components/NoteFeed'
import { mergeNotes } from '../store/feed'
import BottomBar from '../components/BottomBar'
import { createRegistryKeyring, registryIssuer, verifyStake, type RegistryKeyring } from '../crypto/registryTrust'
import { config, normalizeUrl } from '../config'
import { rotationGroups, rotationJobId, rotatedPreferences, handleName, type RotationJob, type RotationJournal } from '../crypto/rotation'
import { PeerHistory, peerFingerprint, type HistoryStatus } from '../history/peerHistory'
import { loadPreferences, savePreferences, brokerAccess } from '../store/preferences'

export default React.memo(function AppPage() {
  const generateKey = useKeyGeneration()
  const { identity, identities, setIdentity, selectIdentity, refreshIdentities, clearIdentity } = useIdentity()
  const [preferences, setPreferences] = useState(() => {
    const url = normalizeUrl(identity?.registryUrl ?? config.registryUrl, 'registry')
    const saved = loadPreferences(identity!.fingerprint, url ? { url, handle: identity!.handle } : undefined)
    return { ...saved, selectedRegistry: url ?? saved.selectedRegistry }
  })
  const { brokerUrls, registries: accounts, selectedRegistry, activeChannel } = preferences
  const registries = [...new Set([...accounts.map(account => account.url), ...identities.flatMap(account => account.registryUrl ? [account.registryUrl] : [])])]
  const selectedAccount = accounts.find(account => account.url === selectedRegistry)
  const registryUrl = selectedRegistry
  const [connections, setConnections] = useState<Record<string, boolean>>({})
  const connectedUrls = Object.keys(connections).filter(url => connections[url]).sort()
  const readUrls = connectedUrls.filter(url => brokerAccess(preferences, url).read)
  const canPublish = connectedUrls.some(url => brokerAccess(preferences, url).publish)
  const connected = readUrls.length > 0
  const [unread, setUnread] = useState<Record<string, number>>({})
  const channels: ChannelItem[] = preferences.channels.map(name => ({ name, unread: unread[name] ?? 0 }))
  const [notes, setNotes] = useState<Note[]>([])
  const [registryRefresh, setRegistryRefresh] = useState(0)
  const [registryKeys, setRegistryKeys] = useState<RegistryKeyring>(new Map())
  const registryKey = registryUrl ? registryKeys.get(registryIssuer(registryUrl)) : undefined
  const [error, setError] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const keyEpoch = useRef(0)
  const [keyStatus, setKeyStatus] = useState('')
  const [keyError, setKeyError] = useState('')
  const [keyReady, setKeyReady] = useState(false)
  const [pendingRotation, setPendingRotation] = useState<KeyRecord | null>(null)
  const [rotationOpen, setRotationOpen] = useState(false)
  const [rotationScope, setRotationScope] = useState<'registration' | 'key' | 'all'>('registration')
  const [rotationImport, setRotationImport] = useState(false)
  const [rotationPems, setRotationPems] = useState<Record<string, string>>({})
  const groupsToRotate = rotationGroups(identities.filter(item => item.registryUrl && loadPreferences(item.fingerprint).registries.some(account => account.url === item.registryUrl)), { ...identity!, registryUrl: registryUrl || undefined }, rotationScope)
  useEffect(() => {
    void loadKeypair('pending-rotation').then(record => { setPendingRotation(record); setKeyReady(true) }).catch(err => setError((err as Error).message))
  }, [])
  const notifyKeyChange = () => localStorage.setItem('sigil:key-lifecycle', crypto.randomUUID())
  const historyPeerId = useRef(crypto.randomUUID())
  const history = useRef(new Map<string, PeerHistory>())
  const noteRequests = useRef(new Map<string, PeerNoteRequests>())
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
  const [modalImport, setModalImport] = useState(false)
  const [modalPem, setModalPem] = useState('')
  const [pendingNewIdentity, setPendingNewIdentity] = useState(false)
  useEffect(() => { void loadKeypair('pending-identity').then(record => setPendingNewIdentity(!!record)).catch(console.error) }, [])
  const [modalHandleStatus, setModalHandleStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
  const [modalRegistering, setModalRegistering] = useState(false)
  const [modalRegError, setModalRegError] = useState('')

  const advertisedInventory = JSON.stringify({
    registries,
    brokers: [...new Set([...brokerUrls, ...[...new Set(identities.map(item => item.fingerprint))].flatMap(fp => loadPreferences(fp).brokerUrls)])],
  })
  useEffect(() => {
    if (!registryUrl || !selectedAccount || !identity || !keyReady || keyBusy || pendingRotation) return
    queueAdvertisement(registryUrl, identity.fingerprint, JSON.parse(advertisedInventory))
  }, [registryUrl, selectedAccount?.handle, identity?.fingerprint, keyReady, keyBusy, pendingRotation, advertisedInventory])

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
    if (type === 'request_note' || (type === 'note_relay' && frame[0].note_jti !== undefined)) {
      if (type === 'request_note' && !brokerAccess(preferences, url).publish) return
      await noteRequests.current.get(url)?.handle(frame)
    } else if (type === 'request_notes' || type === 'note_relay') {
      if (type === 'request_notes' && !brokerAccess(preferences, url).publish) return
      await history.current.get(url)?.handle(frame)
    } else if (type === 'note') {
      const note = await verifyNote(frame)
      if (await saveNoteIfNew(note)) acceptNote(note)
    }
  }, [verifyNote, acceptNote, preferences.brokerAccess])

  useEffect(() => { handleFrameRef.current = handleFrame }, [handleFrame])
  useEffect(() => () => brokers.close(), [brokers])
  const brokerList = JSON.stringify(keyReady && !pendingRotation && !keyBusy ? brokerUrls.map(url => ({ url, ...brokerAccess(preferences, url) })) : [])
  useEffect(() => { brokers.updateBrokers(JSON.parse(brokerList)) }, [brokers, brokerList])

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
  const connectedBrokers = JSON.stringify(readUrls)
  useEffect(() => {
    setHistoryStatuses({})
    if (!identity || !registryKey || !selectedAccount) return
    const urls = JSON.parse(connectedBrokers) as string[]
    if (!urls.length) return
    let cancelled = false
    const sessions = new Map<string, PeerHistory>()
    const lookups = new Map<string, PeerNoteRequests>()
    for (const url of urls) {
      lookups.set(url, new PeerNoteRequests({
        fingerprint: 'sha256:' + identity.fingerprint, privateKey: identity.privateKey,
        keys: registryKeys, getStake, send: frame => brokers.sendTo(url, frame),
        readNote: getNoteByJti, save: saveNoteIfNew, onNote: acceptNote,
        onError: err => { if (!cancelled) setError(err.message) },
        timeoutMs: config.historyTimeoutMs, maxFrameBytes: config.maxFrameBytes,
      }))
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
    noteRequests.current = lookups
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
      for (const lookup of lookups.values()) lookup.dispose()
      if (noteRequests.current === lookups) noteRequests.current = new Map()
      if (history.current === sessions) history.current = new Map()
    }
  }, [brokers, joinedChannels, connectedBrokers, activeChannel, identity, getStake, registryKey, registryKeys, acceptNote])

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return
    function onDoc(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node) && !(e.target as Element).closest('[aria-label="Choose identity"]')) {
        setSettingsOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSettingsOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
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
    if (keyBusy || pendingRotation || !selectedAccount || !identity || !registryKey || !canPublish || !activeChannel) throw new Error('Connect a broker, choose a registry, and join a channel before sending.')
    const epoch = keyEpoch.current
    const channel = activeChannel
    const stake = await getStake()
    const frame = await buildUnt(content, channel, stake, identity.privateKey, replyTo?.jti)
    const note = await verifyNote(frame)
    if (epoch !== keyEpoch.current) throw new Error('The identity changed while preparing this note. Your draft has been kept.')
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

  function addBroker(value: string) {
    const url = normalizeUrl(value, 'broker')
    if (!url) throw new Error('Enter a valid ws:// or wss:// broker URL.')
    setPreferences(prev => ({ ...prev, brokerUrls: [...new Set([...prev.brokerUrls, url])] }))
    if (registryUrl && selectedAccount && identity) queueAdvertisement(registryUrl, identity.fingerprint, { brokers: [url] })
  }

  async function manageKeys(work: () => Promise<void>) {
    if (keyBusy || !keyReady) return
    keyEpoch.current++
    setKeyBusy(true)
    setKeyError('')
    setError('')
    try {
      await withIdentityLock(async () => {
        const primary = await loadKeypair()
        if (!primary || await fingerprintFromSpki(primary.publicKeySpki) !== identity!.fingerprint) throw new Error('This identity changed in another tab. Reload before continuing.')
        await work()
      })
    } catch (err) { setKeyError((err as Error).message) }
    finally { setKeyBusy(false); setKeyStatus('') }
  }

  async function reconcileLocalDeletion() {
    const remaining = await readIdentitySummaries()
    const current = remaining.find(item => item.fingerprint === identity!.fingerprint && (item.registryUrl ?? '') === registryUrl)
    if (current) {
      setPreferences(loadPreferences(current.fingerprint))
      await refreshIdentities()
      return
    }
    stakeCache.current.clear()
    brokers.close()
    const next = remaining.find(item => item.fingerprint === identity!.fingerprint) ?? remaining[0]
    if (next) {
      const record = await loadIdentityKey(next)
      if (!record) throw new Error('The remaining identity key is unavailable. Reload to restore local state.')
      await setIdentity({ ...next, privateKey: record.privateKey, publicKeySpki: record.publicKeySpki })
    } else { clearIdentity(); await refreshIdentities() }
  }

  async function removeLocally(target: IdentitySummary) {
    if (!window.confirm(`Delete ${target.handle} from this client? Its stored private-key copy will be deleted. Registry registrations and other saved identities will remain unchanged. You will need a PEM backup to restore this identity. Stored notes will be kept.`)) return
    await manageKeys(async () => {
      if (await loadKeypair('pending-rotation')) throw new Error('Finish the pending rotation before deleting one identity or key.')
      try { await deleteLocalIdentity(target) }
      finally { await reconcileLocalDeletion(); notifyKeyChange() }
    })
  }

  async function removeAllLocally() {
    if (!window.confirm(ALL_LOCAL_KEYS_CONFIRMATION)) return
    await manageKeys(async () => {
      try { await deleteEveryLocalIdentity() }
      finally { await reconcileLocalDeletion(); notifyKeyChange() }
    })
  }

  async function removeRegistry(url: string) {
    const account = accounts.find(item => item.url === url)
    if (!account || !window.confirm(`Revoke ${account.handle} at ${url}? The registration will be removed; its local key copy will be kept until you delete it locally.`)) return
    await manageKeys(async () => {
      if (await loadKeypair('pending-rotation')) throw new Error('Finish the pending rotation before revoking registrations.')
      setKeyStatus(`Revoking registration at ${url}…`)
      await revokeRegistry(url, identity!.fingerprint, identity!.privateKey)
      const registries = accounts.filter(item => item.url !== url)
      const updated = { ...preferences, registries }
      savePreferences(identity!.fingerprint, updated)
      stakeCache.current.clear()
      setPreferences(updated)
      await refreshIdentities()
      notifyKeyChange()
    })
  }

  async function rotateIdentity() {
    await manageKeys(async () => {
      let pending = await loadKeypair('pending-rotation')
      if (!pending) {
        if (!groupsToRotate.length) throw new Error('Choose a registered identity before rotating.')
        const jobs: RotationJob[] = []
        const replacements: KeyRecord[] = []
        const usedFingerprints = new Set<string>()
        for (const group of groupsToRotate) {
          setKeyStatus(`Preparing replacement for @${group.name}…`)
          const key = rotationImport
            ? { ...await importKeypair(rotationPems[group.name] ?? ''), id: `replacement:${group.name}` }
            : await generateKey(`replacement:${group.name}`, `Replacement for @${group.name} · ${group.registrations.map(item => new URL(item.registryUrl!).host).join(', ')}`)
          const fingerprint = await fingerprintFromSpki(key.publicKeySpki)
          if (usedFingerprints.has(fingerprint)) throw new Error('Different handles require different replacement keys. Import a separate key for each handle.')
          if (identities.some(item => item.fingerprint === fingerprint && handleName(item.handle) !== group.name && item.registryUrl)) throw new Error('This imported key belongs to a different saved handle. Use a separate key for this handle.')
          usedFingerprints.add(fingerprint)
          const first = group.registrations[0]
          replacements.push({ ...key, identityMetadata: { fingerprint, handle: first.handle, registryUrl: first.registryUrl } })
          for (const item of group.registrations) jobs.push({ oldFingerprint: item.fingerprint, url: item.registryUrl!, handle: item.handle, replacementFingerprint: fingerprint })
        }
        // Reject incompatible imported registrations before changing any server.
        await Promise.all(jobs.map(async job => {
          try {
            const existing = await lookupKey(job.replacementFingerprint, job.url)
            const key = replacements.find(item => item.identityMetadata!.fingerprint === job.replacementFingerprint)!
            if (existing.fingerprint !== job.replacementFingerprint || existing.user_tag !== handleName(job.handle) || existing.public_key.trim() !== publicKeyPem(key).trim()) throw new Error(`The replacement key is already registered as another identity at ${job.url}.`)
          } catch (err) { if (!(err instanceof RegistryError && err.status === 404)) throw err }
        }))
        const fingerprints = new Set([...jobs.map(job => job.oldFingerprint), ...replacements.map(key => key.identityMetadata!.fingerprint).filter(fp => identities.some(item => item.fingerprint === fp))])
        const sources = [...fingerprints].map(fingerprint => ({ fingerprint, preferences: loadPreferences(fingerprint) }))
        const journal: RotationJournal = { oldFingerprint: identity!.fingerprint, preferences, completed: [], jobs, replacements, sources }
        pending = { ...replacements[0], id: 'pending-rotation', rotation: journal }
        // Save every replacement before contacting any registry.
        await storeKeypair(pending)
        setPendingRotation(pending)
        setRotationOpen(false)
        setRotationPems({})
        notifyKeyChange()
      }
      const journal = pending.rotation
      if (!journal || journal.oldFingerprint !== identity!.fingerprint) throw new Error('Rotation journal does not match this identity. Keep all stored keys and reload.')
      if (!journal.jobs || !journal.replacements || !journal.sources) {
        // Preserve resumability for rotations started by the previous client version.
        const fp = await fingerprintFromSpki(pending.publicKeySpki)
        journal.jobs = journal.preferences.registries.map(account => ({ oldFingerprint: journal.oldFingerprint, url: account.url, handle: account.handle, replacementFingerprint: fp }))
        journal.replacements = [{ ...pending, rotation: undefined }]
        journal.sources = [{ fingerprint: journal.oldFingerprint, preferences: journal.preferences }]
        journal.completed = journal.jobs.filter(job => journal.completed.includes(job.url)).map(rotationJobId)
        await storeKeypair(pending)
      }
      const replacements = new Map<string, KeyRecord>()
      for (const key of journal.replacements) replacements.set(await fingerprintFromSpki(key.publicKeySpki), key)
      for (const job of journal.jobs) {
        const id = rotationJobId(job)
        if (journal.completed.includes(id)) continue
        const source = await loadIdentityKey({ fingerprint: job.oldFingerprint, registryUrl: job.url })
        const replacement = replacements.get(job.replacementFingerprint)
        if (!source || !replacement) throw new Error('A rotation key is missing. Keep the remaining keys and reload.')
        setKeyStatus(`Rotating ${job.handle}…`)
        await rotateRegistry(job.url, job.oldFingerprint, source.privateKey, replacement, handleName(job.handle))
        journal.completed.push(id)
        await storeKeypair(pending)
        setPendingRotation({ ...pending })
      }
      const updated = rotatedPreferences(journal)
      for (const [fingerprint, saved] of updated) savePreferences(fingerprint, saved)
      const active = journal.jobs.find(job => job.oldFingerprint === identity!.fingerprint && job.url === registryUrl) ?? journal.jobs[0]
      const activeKey = replacements.get(active.replacementFingerprint)!
      const metadata = { fingerprint: active.replacementFingerprint, handle: active.handle, registryUrl: active.url }
      const storedReplacements = [...replacements.entries()].map(([fingerprint, key]) => {
        const job = journal.jobs!.find(item => item.replacementFingerprint === fingerprint)!
        return { ...key, rotation: undefined, identityMetadata: { fingerprint, handle: job.handle, registryUrl: job.url } }
      })
      const retired = journal.sources.filter(source => !updated.get(source.fingerprint)?.registries.length && !replacements.has(source.fingerprint)).map(source => source.fingerprint)
      await finishRotation({ ...activeKey, rotation: journal, identityMetadata: metadata }, storedReplacements, retired)
      for (const job of journal.jobs) {
        if (job.oldFingerprint === job.replacementFingerprint) continue
        try {
          const oldDraft = `sigil:draft:${job.oldFingerprint}:${job.url}`
          const newDraft = `sigil:draft:${job.replacementFingerprint}:${job.url}`
          const value = sessionStorage.getItem(oldDraft)
          if (value && !sessionStorage.getItem(newDraft)) sessionStorage.setItem(newDraft, value)
          sessionStorage.removeItem(oldDraft)
        } catch { /* Rotation is committed even if this tab cannot migrate its draft. */ }
      }
      stakeCache.current.clear()
      await setIdentity({ ...metadata, privateKey: activeKey.privateKey, publicKeySpki: activeKey.publicKeySpki })
      setPendingRotation(null)
      setRotationOpen(false)
      setRotationPems({})
      notifyKeyChange()
    })
  }

  async function revokeAndDelete() {
    if (!window.confirm('Revoke this key at EVERY configured registry and delete its private key from this browser? This cannot be undone. Registrations at providers not listed here cannot be revoked by this action. Stored notes will remain.')) return
    await manageKeys(async () => {
      if (await loadKeypair('pending-rotation')) throw new Error('Finish the pending rotation before deleting this identity.')
      for (const account of accounts) {
        setKeyStatus(`Revoking registration at ${account.url}…`)
        await revokeRegistry(account.url, identity!.fingerprint, identity!.privateKey)
        // Persist each success; failures leave the key and remaining providers available.
        const saved = loadPreferences(identity!.fingerprint)
        saved.registries = saved.registries.filter(a => a.url !== account.url)
        if (saved.selectedRegistry === account.url) saved.selectedRegistry = saved.registries[0]?.url ?? ''
        savePreferences(identity!.fingerprint, saved)
        setPreferences(saved)
        stakeCache.current.clear()
        notifyKeyChange()
      }
      await deleteIdentityKeys(identity!.fingerprint)
      try { localStorage.removeItem(`sigil:preferences:${identity!.fingerprint}`) }
      finally {
        stakeCache.current.clear()
        brokers.close()
        const next = identities.find(item => item.fingerprint !== identity!.fingerprint)
        if (next) {
          const key = await loadIdentityKey(next)
          if (key) await setIdentity({ ...next, privateKey: key.privateKey, publicKeySpki: key.publicKeySpki })
          else clearIdentity()
        } else { clearIdentity(); await refreshIdentities() }
        notifyKeyChange()
      }
    })
  }

  async function connectRegistry() {
    if (!modalUrl || modalConnecting || modalRegistering) return
    setModalConnecting(true)
    setModalConnError('')
    setModalReachable(false)
    try {
      const url = normalizeUrl(modalUrl, 'registry')
      if (!url) throw new Error('Use HTTPS for registries, or HTTP on localhost for development.')
      await importPublicKeyPem(await fetchRegistryPublicKey(url))
      setModalUrl(url)
      setModalReachable(true)
    } catch (err) { setModalConnError((err as Error).message) }
    finally { setModalConnecting(false) }
  }

  async function registerOnRegistry() {
    if (!identity || (!modalImport && !modalHandle && !pendingNewIdentity) || (modalImport && !modalPem.trim()) || !modalUrl || !modalReachable || modalRegistering) return
    setModalRegistering(true)
    setModalRegError('')
    try {
      await withIdentityLock(async () => {
        if (await loadKeypair('pending-rotation')) throw new Error('Finish the pending rotation before adding an identity.')
        const record = modalImport ? { ...await importKeypair(modalPem), id: 'pending-import-identity' } : await loadKeypair('pending-identity') ?? await generateKey('pending-identity', `@${modalHandle}@${new URL(modalUrl).host}`)
        // Persist before registration, so a lost response can be retried with the same key.
        await storeKeypair(record)
        if (!modalImport) setPendingNewIdentity(true)
        const fp = await fingerprintFromSpki(record.publicKeySpki)
        const url = modalUrl
        const registryKey = await importPublicKeyPem(await fetchRegistryPublicKey(url))
        try { await lookupKey(fp, url) }
        catch (err) {
          if (!(err instanceof RegistryError && err.status === 404)) throw err
          if (modalImport) throw new Error('This key is not registered here. Choose its registry or create a new identity.')
          if (!modalHandle) throw new Error('Choose a handle to finish registering this pending key.')
          const { nonce } = await requestChallenge(fp, url)
          const result = await register({ public_key: publicKeyPem(record), user_tag: modalHandle, nonce, signature: await signNonce(record.privateKey, nonce) }, url)
          if (result.fingerprint !== fp) throw new Error('Registry returned a different identity fingerprint.')
        }
        const { nonce } = await requestChallenge(fp, url)
        const { stake } = await requestStake({ fingerprint: fp, nonce, signature: await signNonce(record.privateKey, nonce) }, url)
        const claims = await verifyStake(stake, createRegistryKeyring([[url, registryKey]]))
        if (await peerFingerprint(claims.public_key) !== 'sha256:' + fp) throw new Error('Registry returned a stake for a different key.')
        const handle = `@${claims.user_tag.replace(/^@/, '')}@${claims.iss}`
        const knownKey = await loadKeypair(`identity:${fp}`)
        const saved = loadPreferences(fp)
        const nextPreferences = { ...saved,
          ...(!knownKey ? { brokerUrls: preferences.brokerUrls, brokerAccess: preferences.brokerAccess, channels: preferences.channels, activeChannel: preferences.activeChannel } : {}),
          registries: [...saved.registries.filter(account => account.url !== url), { url, handle }], selectedRegistry: url,
        }
        savePreferences(fp, nextPreferences)
        // Keep advertising to the previous active registry even after this component switches identities.
        if (registryUrl && selectedAccount) queueAdvertisement(registryUrl, identity.fingerprint, { registries: [url] })
        await setIdentity({ fingerprint: fp, handle, registryUrl: url, privateKey: record.privateKey, publicKeySpki: record.publicKeySpki })
        await deleteKeypair(record.id)
        setModalPem('')
        setAddRegistryOpen(false)
        setPendingNewIdentity(false)
        notifyKeyChange()
      })
    } catch (err) { setModalRegError((err as Error).message) }
    finally { setModalRegistering(false) }
  }

  const relayCount = connectedUrls.length

  return (
    <div className="sigil-app">
      <Header
        channelTitle={activeChannel}
        identityHandle={selectedAccount?.handle ?? 'Unregistered key'}
        relayCount={relayCount}
        settingsOpen={settingsOpen}
        onToggleSettings={e => { e.stopPropagation(); setSettingsOpen(o => !o) }}
      />

      <div className="app-workspace">
        <Sidebar
          channels={channels}
          activeChannel={activeChannel}
          onSelect={handleSelectChannel}
          onAddChannel={handleAddChannel}
        />

        <main className="app-main">
          {pendingRotation && <div className="shrink-0 px-5 py-3 text-xs text-gold border-b border-white/10" role="status">
            Key rotation is unfinished. Sending is paused until all registries are updated.
            <button disabled={keyBusy} className="ml-3 underline disabled:opacity-40" onClick={() => void rotateIdentity()}>Resume key rotation</button>
          </div>}
          {activeChannel && <div className="app-history-rail">
            <span role="status">{!connected ? (connectedUrls.length ? 'Reading disabled · showing stored notes' : 'Offline · showing stored notes') : historyStatus?.phase === 'syncing' ? `Fetching peer history · ${historyStatus.received} notes received` : historyStatus?.phase === 'synced' ? `History checked on ${statusList.length} broker${statusList.length === 1 ? '' : 's'}${historyStatus.skipped ? ` · ${historyStatus.skipped} unverified entries skipped` : ''}` : historyStatus?.phase === 'no-peers' ? 'No peers replied · stored notes remain available' : historyStatus?.phase === 'incomplete' ? 'History transfer incomplete · retry to continue' : 'Preparing peer history'}</span>
            <button disabled={!connected || !registryKey || historyStatus?.phase === 'syncing'} onClick={() => { for (const session of history.current.values()) void session.start(activeChannel) }} className="text-gold disabled:opacity-40 shrink-0">Refresh history</button>
          </div>}
          <NoteFeed onRequestOriginal={async jti => (await Promise.all([...noteRequests.current.values()].map(session => session.request(activeChannel, jti)))).some(Boolean)} canRequestOriginal={connected && !!registryKey && !!activeChannel} channel={activeChannel} notes={notes} onReply={setReplyTo} followToken={followToken} emptyMessage={activeChannel ? "No notes in this channel yet." : "Add a channel to read and write notes."} />
          {(keyError || error) && <div role="alert" className="px-4 py-2 text-sm text-red-300 flex justify-between gap-3">
            {keyError || error}<button onClick={() => { setKeyError(''); setError('') }} aria-label="Dismiss error">×</button>
          </div>}
          <BottomBar
            handle={selectedAccount?.handle ?? 'Unregistered key'}
            identityKey={`${identity?.fingerprint}:${registryUrl}`}
            managementDisabled={keyBusy || !!pendingRotation}
            discoveryRegistry={registryUrl || undefined}
            brokers={brokerUrls.map(url => ({ url, connected: !!connections[url], ...brokerAccess(preferences, url) }))}
            onBrokerAccess={(url, access) => setPreferences(prev => ({ ...prev, brokerAccess: { ...prev.brokerAccess, [url]: access } }))}
            onAddBroker={addBroker}
            onRemoveBroker={url => setPreferences(prev => ({ ...prev, brokerUrls: prev.brokerUrls.filter(value => value !== url) }))}
            onSend={sendNote}
            disabled={keyBusy || !!pendingRotation || !selectedAccount || !canPublish || !registryKey || !activeChannel}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
          />

        </main>

        {settingsOpen && <section ref={settingsRef} className="app-identity-panel" aria-label="Identity settings">
          <div className="app-panel-heading"><div><h2>Your identities</h2><p>Choose who signs your next note.</p></div><button aria-label="Close identity panel" onClick={() => setSettingsOpen(false)}>×</button></div>
          <div className="app-identity-list">
            {identities.map(item => <div key={`${item.fingerprint}:${item.registryUrl}`} className="app-identity-card">
              <button disabled={keyBusy || !!pendingRotation || !keyReady} aria-pressed={item.fingerprint === identity?.fingerprint && (item.registryUrl ?? '') === registryUrl} className="app-identity-choice" onClick={() => { void selectIdentity(item).then(() => setSettingsOpen(false)).catch(err => setKeyError((err as Error).message)) }}>
                <span className="app-avatar" aria-hidden="true">{item.handle.replace(/^@/, '').charAt(0).toUpperCase()}</span>
                <span className="app-identity-description"><strong>{item.handle}</strong><span>{item.registryUrl ?? item.fingerprint}</span>
                {item.registryUrl && !loadPreferences(item.fingerprint).registries.some(account => account.url === item.registryUrl) && <span>Registration revoked · local key retained</span>}</span><span className="app-selected-mark" aria-hidden="true">✓</span>
              </button>
              <div className="app-identity-row-actions"><button disabled={!keyReady || keyBusy || !!pendingRotation} aria-label={`Delete identity locally ${item.handle}`} onClick={() => void removeLocally(item)}>Delete locally</button>
              {item.fingerprint === identity?.fingerprint && item.registryUrl && accounts.some(account => account.url === item.registryUrl) && <button disabled={keyBusy || !!pendingRotation} className="app-danger" aria-label={`Revoke identity ${item.handle}`} onClick={() => void removeRegistry(item.registryUrl!)}>Revoke</button>}</div>
            </div>)}
            <button disabled={keyBusy || !!pendingRotation} aria-label="Add identity" onClick={() => { setAddRegistryOpen(true); setSettingsOpen(false) }} className="app-outline-button">+ Add identity</button>
          </div>
          <details className="app-key-management"><summary>Key management</summary>
            <p className="app-fingerprint">{identity?.fingerprint}</p>
            <button onClick={() => { stakeCache.current.clear(); setRegistryRefresh(value => value + 1) }}>Refresh verification keys</button>
            <button disabled={!keyReady || keyBusy || (!pendingRotation && !accounts.length)} onClick={() => { if (pendingRotation) void rotateIdentity(); else setRotationOpen(true) }}>{pendingRotation ? 'Resume key rotation' : 'Rotate identity key'}</button>
            <div className="app-key-danger"><button disabled={!keyReady || keyBusy} onClick={() => void removeAllLocally()}>Delete all local keys</button><p>Local deletion keeps registry registrations active. Back up your private keys before deleting them.</p>
            <button disabled={!keyReady || keyBusy || !!pendingRotation} onClick={() => void revokeAndDelete()}>Revoke all and delete local key</button><p>Revokes this key’s registrations. Other saved keys are kept; issued stakes remain valid until they expire.</p></div>
          </details>
          {pendingRotation && <p role="status" className="app-panel-status">Rotation unfinished. Resume to update all registries. Both keys are retained.</p>}
          {keyStatus && <p role="status" className="app-panel-status">{keyStatus}</p>}
        </section>}

      </div>


      {rotationOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="rotation-title">
        <div className="bg-[#101010] border border-white/10 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
          <h2 id="rotation-title" className="text-lg font-semibold">Rotate identity keys</h2>
          <label className="block mt-4 text-xs text-white/60">Rotation scope
            <select aria-label="Rotation scope" disabled={keyBusy} value={rotationScope} onChange={event => setRotationScope(event.target.value as typeof rotationScope)} className="block w-full mt-2 bg-[#191919] border border-white/10 rounded-lg p-2">
              <option value="registration">Only {selectedAccount?.handle ?? 'this registration'}</option>
              <option value="key">Every registration using this key</option>
              <option value="all">All saved identities</option>
            </select>
          </label>
          <p className="mt-3 text-xs text-white/40">{groupsToRotate.length} replacement key{groupsToRotate.length === 1 ? '' : 's'}. The same handle across registries shares one key; different handles use separate keys.</p>
          <div className="flex gap-4 mt-4 text-xs">
            <label><input type="radio" name="rotation-source" checked={!rotationImport} disabled={keyBusy} onChange={() => setRotationImport(false)} /> Generate new keys</label>
            <label><input type="radio" name="rotation-source" checked={rotationImport} disabled={keyBusy} onChange={() => setRotationImport(true)} /> Import keys</label>
          </div>
          {groupsToRotate.map(group => <div key={group.name} className="mt-4 text-xs">
            <p className="text-gold">@{group.name} · {group.registrations.length} registration{group.registrations.length === 1 ? '' : 's'}</p>
            <p className="text-white/40 break-all">{group.registrations.map(item => item.registryUrl).join(', ')}</p>
            {rotationImport && <label className="block mt-2">Replacement private key for @{group.name}
              <textarea aria-label={`Replacement private key for ${group.name}`} disabled={keyBusy} value={rotationPems[group.name] ?? ''} onChange={event => setRotationPems(prev => ({ ...prev, [group.name]: event.target.value }))} rows={4} autoComplete="off" spellCheck={false} className="w-full mt-2 rounded-xl p-3 bg-white/5 border border-white/10 font-mono" />
            </label>}
          </div>)}
          {keyStatus && <p role="status" className="mt-4 text-xs text-gold">{keyStatus}</p>}
          {keyError && <p role="alert" className="mt-4 text-xs text-red-300">{keyError}</p>}
          <div className="flex justify-end gap-4 mt-6 text-sm">
            <button disabled={keyBusy} onClick={() => { setRotationOpen(false); setRotationPems({}) }}>Cancel</button>
            <button disabled={keyBusy || !groupsToRotate.length || (rotationImport && groupsToRotate.some(group => !rotationPems[group.name]?.trim()))} className="px-4 py-2 rounded-xl bg-gold text-black disabled:opacity-30" onClick={() => void rotateIdentity()}>Start rotation</button>
          </div>
        </div>
      </div>}
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
              aria-label="Close identity dialog"
              onClick={() => setAddRegistryOpen(false)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
              style={{ color: 'rgba(255,255,255,0.3)', fontSize: 18 }}
              onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.7)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
            >
              ✕
            </button>

            <h2 className="text-lg font-semibold mb-1">Add identity</h2>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginBottom: 24, lineHeight: 1.5 }}>
              Create a separate key and handle. You can add several identities on the same registry and switch between them without losing any keys.
            </p>

            <div className="flex gap-3 text-xs mb-4">
              <label><input type="radio" name="identity-key-source" checked={!modalImport} disabled={modalRegistering} onChange={() => setModalImport(false)} /> New key</label>
              <label><input type="radio" name="identity-key-source" checked={modalImport} disabled={modalRegistering} onChange={() => setModalImport(true)} /> Import existing key</label>
            </div>
            {modalImport && <label className="block text-xs text-white/50 mb-4">Private key (PKCS#8 PEM)
              <textarea aria-label="Identity private key" value={modalPem} onChange={event => setModalPem(event.target.value)} disabled={modalRegistering} rows={4} autoComplete="off" spellCheck={false} className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-xs font-mono mt-2" />
            </label>}
            {/* URL */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 8 }}>
                Registry URL
              </label>
              <div className="flex gap-2">
                <EndpointInput
                  kind="registry"
                  discoveryRegistry={registryUrl || undefined}
                  type="text"
                  disabled={modalConnecting || modalRegistering}
                  aria-label="Registry URL"
                  value={modalUrl}
                  onValueChange={value => { setModalUrl(value); setModalReachable(false); setModalConnError(''); setModalRegError('') }}
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
            {modalReachable && !modalImport && (
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
            {modalReachable && (modalImport ? !!modalPem.trim() : pendingNewIdentity || (modalHandle && modalHandleStatus === 'available')) && (
              <div style={{ animation: 'sgFadeUp 0.15s ease' }}>
                <button
                  onClick={registerOnRegistry}
                  disabled={modalRegistering}
                  className="w-full py-3 rounded-xl font-semibold text-sm text-black transition-all disabled:opacity-50"
                  style={{ background: '#d6b06a' }}
                >
                  {modalRegistering ? 'Saving identity…' : modalImport ? 'Import identity →' : pendingNewIdentity ? 'Resume pending identity →' : 'Create identity →'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
