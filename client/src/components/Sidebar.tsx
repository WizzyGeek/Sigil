import React, { useState, type FormEvent } from 'react'
import { config } from '../config'

export interface ChannelItem { name: string; unread: number }
interface Props { channels: ChannelItem[]; activeChannel: string; onSelect: (ch: string) => void; onAddChannel: (ch: string) => void }
export default React.memo(function Sidebar({ channels, activeChannel, onSelect, onAddChannel }: Props) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const channel = draft.trim().toLowerCase().replace(/\s+/g, '-')
    if (channel) { onAddChannel(channel); setDraft(''); setAdding(false) }
  }
  const repository = config.repositoryUrl.replace(/\/$/, '')
  return <aside className="app-sidebar" aria-label="Channels">
    <div className="app-sidebar-heading"><h2>Channels</h2><button className="app-add-channel" aria-label="Add channel" title="Join a channel" onClick={() => setAdding(open => !open)}>+</button></div>
    {adding && <form onSubmit={handleSubmit} className="app-channel-form">
      <label htmlFor="channel-name">Join a channel</label>
      <input id="channel-name" autoFocus value={draft} onChange={event => setDraft(event.target.value)} placeholder="channel-name" className="app-input" />
      <div><button type="submit" className="app-text-action">Join channel</button><button type="button" className="app-muted-action" onClick={() => { setAdding(false); setDraft('') }}>Cancel</button></div>
    </form>}
    <nav className="app-channel-nav" aria-label="Channel navigation"><ul>
      {channels.map(({ name, unread }) => <li key={name}><button className={`app-channel-link ${name === activeChannel ? 'is-active' : ''}`} aria-current={name === activeChannel ? 'page' : undefined} onClick={() => onSelect(name)} title={name}>
        <span className="app-channel-hash" aria-hidden="true">#</span><span>{name}</span>{unread > 0 && <span className="app-unread">{unread}</span>}
      </button></li>)}
    </ul>{!channels.length && <p className="app-sidebar-empty">Join a channel to start reading and writing notes.</p>}</nav>
    <div className="app-sidebar-footer"><p>Your words.<br /><span>Your signature.</span></p><div><a href={repository} target="_blank" rel="noreferrer">GitHub ↗</a><a href={`${repository}#readme`} target="_blank" rel="noreferrer">README ↗</a></div></div>
  </aside>
})
