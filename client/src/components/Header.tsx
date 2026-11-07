import React from 'react'
import { Link } from 'react-router-dom'

interface Props {
  channelTitle: string
  identityHandle: string
  relayCount: number
  settingsOpen: boolean
  onToggleSettings: (e: React.MouseEvent) => void
}
export default React.memo(function Header({ channelTitle, identityHandle, relayCount, settingsOpen, onToggleSettings }: Props) {
  return <header className="app-header">
    <Link to="/" className="app-brand" aria-label="Sigil home"><span className="app-brand-mark" aria-hidden="true" />SIGIL</Link>
    <div className="app-heading"><span className="app-heading-label">Your notebook</span><h1>{channelTitle ? <><span className="app-channel-hash">#</span>{channelTitle}</> : 'Choose a channel'}</h1></div>
    <div className="app-header-actions">
      <span className="app-connection-status"><span className={`app-status-dot ${relayCount ? 'is-connected' : ''}`} aria-hidden="true" />{relayCount} {relayCount === 1 ? 'broker connected' : 'brokers connected'}</span>
      <button className="app-identity-trigger" onClick={onToggleSettings} aria-label="Choose identity" aria-expanded={settingsOpen} title={identityHandle}>
        <span className="app-avatar app-avatar-small" aria-hidden="true">{identityHandle.replace(/^@/, '').charAt(0).toUpperCase()}</span>
        <span className="app-identity-trigger-text"><span className="app-heading-label">Identity</span><span>{identityHandle}</span></span>
        <span className="app-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
  </header>
})
