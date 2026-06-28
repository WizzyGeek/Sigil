import React, { useState, useRef, type KeyboardEvent } from 'react'

interface Props {
  handle: string
  registries: string[]
  selectedRegistry: string
  onSelectRegistry: (r: string) => void
  onSend: (body: string) => void
}

export default React.memo(function BottomBar({ handle, registries, selectedRegistry, onSelectRegistry, onSend }: Props) {
  const [value, setValue] = useState('')
  const [regOpen, setRegOpen] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const tag = handle.replace(/^@/, '').split('@')[0]
  const regLabel = `@${tag} · ${selectedRegistry}`

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  function submit() {
    const body = value.trim()
    if (!body) return
    onSend(body)
    setValue('')
    ref.current?.focus()
  }

  return (
    <div
      className="shrink-0 flex items-center gap-3 px-4 relative"
      style={{
        height: 70,
        background: 'rgba(255,255,255,0.025)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {/* Registry selector */}
      <div className="relative shrink-0">
        <button
          onClick={() => setRegOpen(o => !o)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors"
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.6)',
            border: '1px solid rgba(255,255,255,0.1)',
            fontFamily: 'JetBrains Mono, monospace',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(214,176,106,0.3)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
        >
          <span className="max-w-[180px] truncate">{regLabel}</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>▲</span>
        </button>

        {regOpen && registries.length > 0 && (
          <div
            className="absolute bottom-full mb-2 left-0 rounded-xl overflow-hidden"
            style={{
              minWidth: 200,
              background: 'rgba(16,16,16,0.95)',
              border: '1px solid rgba(255,255,255,0.07)',
              backdropFilter: 'blur(12px)',
              animation: 'sgSlideDown 0.15s ease',
            }}
          >
            {registries.map(r => (
              <button
                key={r}
                onClick={() => { onSelectRegistry(r); setRegOpen(false) }}
                className="w-full text-left px-4 py-2.5 transition-colors"
                style={{
                  fontSize: 12,
                  color: r === selectedRegistry ? '#d6b06a' : 'rgba(255,255,255,0.6)',
                  fontFamily: 'JetBrains Mono, monospace',
                  background: 'transparent',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Note input */}
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a note…"
        className="flex-1 bg-transparent text-sm outline-none"
        style={{ color: '#f4f1ea' }}
      />

      {/* Send button */}
      <button
        onClick={submit}
        disabled={!value.trim()}
        className="shrink-0 px-5 py-2 font-semibold text-[13px] text-black rounded-xl transition-all disabled:opacity-30"
        style={{
          background: '#d6b06a',
          letterSpacing: '0.5px',
        }}
      >
        SEND →
      </button>
    </div>
  )
})
