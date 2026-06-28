import React, { useState, type FormEvent } from 'react'

export interface ChannelItem {
  name: string
  unread: number
}

interface Props {
  channels: ChannelItem[]
  activeChannel: string
  onSelect: (ch: string) => void
  onAddChannel: (ch: string) => void
}

export default React.memo(function Sidebar({ channels, activeChannel, onSelect, onAddChannel }: Props) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const ch = draft.trim().toLowerCase().replace(/\s+/g, '-')
    if (ch) { onAddChannel(ch); setDraft(''); setAdding(false) }
  }

  return (
    <aside
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        width: 216,
        background: 'rgba(255,255,255,0.02)',
        borderRight: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      <div
        className="px-4 pt-5 pb-2"
        style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.15em', textTransform: 'uppercase' }}
      >
        Channels
      </div>

      <ul className="flex-1 overflow-y-auto">
        {channels.map(({ name, unread }) => {
          const isGeneral = name === 'general'
          const isActive = name === activeChannel
          return (
            <li key={name}>
              <button
                onClick={() => onSelect(name)}
                className="w-full text-left flex items-center gap-2 py-[7px] text-[13px] transition-colors"
                style={{
                  paddingLeft: 16,
                  paddingRight: 12,
                  color: isActive ? '#d6b06a' : 'rgba(255,255,255,0.5)',
                  background: isActive ? 'rgba(214,176,106,0.05)' : 'transparent',
                  borderLeft: isActive ? '2px solid #d6b06a' : '2px solid transparent',
                }}
              >
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', width: 12, flexShrink: 0 }}>
                  {isGeneral ? '★' : '#'}
                </span>
                <span className="flex-1 truncate">{name}</span>
                {unread > 0 && (
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
                    style={{ background: 'rgba(214,176,106,0.2)', color: '#d6b06a' }}
                  >
                    {unread}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: 12 }}>
        {adding ? (
          <form onSubmit={handleSubmit}>
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => { if (!draft) setAdding(false) }}
              placeholder="channel-name"
              className="w-full outline-none text-xs rounded-lg px-3 py-1.5"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#f4f1ea',
              }}
            />
          </form>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="w-full text-left px-2 py-1.5 text-xs transition-colors"
            style={{ color: 'rgba(255,255,255,0.25)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.25)')}
          >
            + Add Channel
          </button>
        )}
      </div>
    </aside>
  )
})
