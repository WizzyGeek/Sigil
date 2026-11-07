import React from 'react'
import type { Note } from '../types/protocol'
import FreshnessLock from './FreshnessLock'

interface Props {
  note: Note
  onReply: (note: Note) => void
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function displayName(handle: string): string {
  const tag = handle.replace(/^@/, '').split('@')[0]
  return tag.charAt(0).toUpperCase() + tag.slice(1)
}

export default React.memo(function NoteCard({ note, onReply }: Props) {
  return (
    <article
      className="group px-5 py-4 border-b border-white/[0.06] hover:bg-white/[0.015] transition-colors"
      style={{ animation: 'sgFadeUp 0.35s ease both' }}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-[14.5px] text-[#f4f1ea] shrink-0">
            {note.displayName || displayName(note.author)}
          </span>
          <span
            className="text-[11px] text-white/35 truncate"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {note.author}
          </span>
        </div>
        <FreshnessLock score={note.freshnessScore} />
      </div>

      {note.replyTo && <p className="text-xs text-white/40 mb-2">Reply to note {note.replyTo}</p>}
      <p className="text-[14px] text-[#f4f1ea]/80 leading-relaxed break-words whitespace-pre-wrap">
        {note.body}
      </p>

      <div className="mt-2.5 flex items-center gap-3 text-[11px] text-white/25">
        <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {formatTime(note.issuedAt)}
        </span>
        <span>#{note.channel}</span>
        <button onClick={() => onReply(note)} aria-label={`Reply to ${note.author}`} title="Reply" className="ml-auto opacity-0 group-hover:opacity-60 transition-opacity text-white/40 hover:text-white/70">
          ↩
        </button>
      </div>
    </article>
  )
})
