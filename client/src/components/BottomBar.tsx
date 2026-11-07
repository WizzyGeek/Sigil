import EndpointInput from './EndpointInput'
import { config } from '../config'
import type { BrokerAccess } from '../store/preferences'
import type { Note } from '../types/protocol'
import React, { useState, useRef, useEffect, type KeyboardEvent } from 'react'

interface Props {
  discoveryRegistry?: string
  managementDisabled: boolean
  identityKey: string
  handle: string
  brokers: { url: string; connected: boolean; read: boolean; publish: boolean }[]
  onBrokerAccess: (url: string, access: BrokerAccess) => void
  onAddBroker: (url: string) => void
  onRemoveBroker: (url: string) => void
  onSend: (body: string) => Promise<void>
  disabled: boolean
  replyTo: Note | null
  onCancelReply: () => void
}

export default React.memo(function BottomBar({ discoveryRegistry, managementDisabled, identityKey, handle, brokers, onBrokerAccess, onAddBroker, onRemoveBroker, onSend, disabled, replyTo, onCancelReply }: Props) {
  const draftKey = `sigil:draft:${identityKey}`
  const [value, setValue] = useState(() => {
    try { return sessionStorage.getItem(draftKey) ?? '' } catch { return '' }
  })
  useEffect(() => {
    try { if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey) } catch { /* Keep the in-memory draft when browser storage is unavailable. */ }
  }, [draftKey, value])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [regOpen, setRegOpen] = useState(false)
  const [brokerDraft, setBrokerDraft] = useState('')
  const [brokerError, setBrokerError] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!regOpen) return
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setRegOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [regOpen])

  const noteBytes = new TextEncoder().encode(value.trim()).length
  const tooLong = noteBytes > config.maxNoteBytes
  const published = brokers.filter(broker => broker.publish).length

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  async function submit() {
    const body = value.trim()
    if (!body || disabled || sending || tooLong) return
    setSending(true)
    setError('')
    try {
      await onSend(body)
      setValue('')
      ref.current?.focus()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="app-composer"><div className="app-composer-inner">
      <div className="app-composer-top"><p aria-label="Sending identity"><span>Posting as </span>{handle}</p></div>
      {replyTo && <div className="px-4 py-2 text-xs text-white/60 flex gap-3">
        <span className="truncate">Replying to {replyTo.author}: {replyTo.body}</span>
        <button onClick={onCancelReply} disabled={sending} aria-label="Cancel reply">×</button>
      </div>}
      {tooLong && <p role="alert" className="px-4 py-2 text-sm text-red-300">Note is {noteBytes} bytes; the configured limit is {config.maxNoteBytes} bytes.</p>}
      {error && <p role="alert" className="px-4 py-2 text-sm text-red-300">{error}</p>}
      {disabled && <p className="px-4 pt-2 text-xs text-white/50">Enable P on a connected broker, choose an identity, and join a channel to send notes.</p>}
    <div className="app-compose-controls">
      <div className="relative shrink-0">
        <button aria-label="Broker read and publish settings" aria-expanded={regOpen} onClick={() => setRegOpen(open => !open)} className="app-broker-trigger">
          <span>{published} publish broker{published === 1 ? '' : 's'}</span><span>▲</span>
        </button>
        {regOpen && <div className="app-broker-panel" aria-label="Broker permissions">
          <div className="app-broker-heading"><h2>Broker connections</h2><button aria-label="Close broker settings" onClick={() => setRegOpen(false)}>×</button></div>
          <p className="app-broker-help">Choose where you read (R) and publish (P).</p>
          <div className="grid grid-cols-[minmax(0,1fr)_32px_32px_20px] gap-2 text-xs text-white/50 mb-2"><span>Brokers</span><abbr title="Read notes and request history">R</abbr><abbr title="Publish notes and history replies">P</abbr><span /></div>
          {brokers.map(broker => <div key={broker.url} className="grid grid-cols-[minmax(0,1fr)_32px_32px_20px] items-center gap-2 py-2 text-xs">
            <div className="min-w-0"><p className="truncate text-white/70" title={broker.url}>{broker.url}</p><p className="text-white/40">{!broker.read && !broker.publish ? 'Disconnected' : broker.connected ? 'Connected' : 'Connecting / retrying'}</p></div>
            <input type="checkbox" disabled={managementDisabled} aria-label={`Read from ${broker.url}`} checked={broker.read} onChange={event => onBrokerAccess(broker.url, { read: event.target.checked, publish: broker.publish })} className="accent-[#d6b06a]" />
            <input type="checkbox" disabled={managementDisabled} aria-label={`Publish to ${broker.url}`} checked={broker.publish} onChange={event => onBrokerAccess(broker.url, { read: broker.read, publish: event.target.checked })} className="accent-[#d6b06a]" />
            <button disabled={managementDisabled} aria-label={`Remove broker ${broker.url}`} className="text-white/40" onClick={() => onRemoveBroker(broker.url)}>×</button>
          </div>)}
          {!brokers.length && <p className="text-xs text-white/40 py-2">No brokers configured</p>}
          <form className="mt-3 flex flex-col gap-2" onSubmit={event => {
            event.preventDefault()
            try { onAddBroker(brokerDraft); setBrokerDraft(''); setBrokerError('') } catch (error) { setBrokerError((error as Error).message) }
          }}>
            <label htmlFor="broker-url" className="text-xs text-white/50">Broker WebSocket URL</label>
            <EndpointInput kind="broker" discoveryRegistry={discoveryRegistry} disabled={managementDisabled} id="broker-url" value={brokerDraft} onValueChange={setBrokerDraft} placeholder="wss://" className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-xs" />
            <button disabled={managementDisabled} type="submit" className="text-xs text-gold border border-white/10 rounded-lg p-2">Add broker</button>
            {brokerError && <p role="alert" className="text-xs text-red-300">{brokerError}</p>}
          </form>
        </div>}
      </div>

    </div>
      <div className="app-compose-box">
        <textarea ref={ref} rows={2} disabled={sending} aria-label="Write a note" value={value} onChange={e => setValue(e.target.value)} onKeyDown={handleKeyDown} placeholder="Write a note…" />
        <div className="app-compose-footer"><span className={tooLong ? 'app-danger' : ''}>{noteBytes} / {config.maxNoteBytes} bytes <span className="app-compose-hint">· Shift + Enter for a new line</span></span>
          <button aria-label="Send note" onClick={() => void submit()} disabled={!value.trim() || disabled || sending || tooLong}>{sending ? 'Sending…' : 'Send note →'}</button>
        </div>
      </div>
    </div></div>
  )
})
