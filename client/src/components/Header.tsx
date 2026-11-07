import React from 'react'

interface Props {
  channelTitle: string
  relayCount: number
  settingsOpen: boolean
  onToggleSettings: (e: React.MouseEvent) => void
}

export default React.memo(function Header({ channelTitle, relayCount, settingsOpen, onToggleSettings }: Props) {
  return (
    <header
      className="shrink-0 flex items-center justify-between px-4 glass border-b border-white/[0.07]"
      style={{ height: 58 }}
    >
      <div className="flex items-center gap-3">
        <div
          style={{
            width: 14,
            height: 14,
            background: 'linear-gradient(135deg, #e3c485, #c79a4f)',
            transform: 'rotate(45deg)',
            borderRadius: 2,
            flexShrink: 0,
          }}
        />
        <span
          className="font-bold text-[14px] text-[#f4f1ea]"
          style={{ letterSpacing: '3.5px' }}
        >
          SIGIL
        </span>
        <span
          className="text-white/35 text-[13px] pl-3 border-l border-white/[0.08]"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {channelTitle ? `#${channelTitle}` : 'No channel selected'}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-[12px] text-white/40">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-gold"
            style={{ animation: 'sgPulse 2s ease-in-out infinite' }}
          />
          <span>{relayCount} {relayCount === 1 ? 'broker connected' : 'brokers connected'}</span>
        </div>
        <button
          onClick={onToggleSettings}
          className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
          style={{
            background: settingsOpen ? 'rgba(214,176,106,0.12)' : 'transparent',
            color: settingsOpen ? '#d6b06a' : 'rgba(255,255,255,0.35)',
          }}
          title="Settings"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  )
})
