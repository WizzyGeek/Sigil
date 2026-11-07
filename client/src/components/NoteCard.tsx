import React from 'react'
import type { Note } from '../types/protocol'
import NoteAuthorDetails from './NoteAuthorDetails'
import { freshnessLabel, issuedAtLabel } from './noteMetadata'

interface Props {
  note: Note
  onReply: (note: Note) => void
  parentNote?: Note
  onJumpToNote?: (jti: string) => void
  onRequestOriginal?: (jti: string) => void
  originalLookup?: 'loading' | 'missing' | 'error'
  canRequestOriginal: boolean
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return 'Unknown time'
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function displayName(handle: string): string {
  const tag = handle.replace(/^@/, '').split('@')[0]
  return tag.charAt(0).toUpperCase() + tag.slice(1)
}

export default React.memo(function NoteCard({ note, onReply, parentNote, onJumpToNote, onRequestOriginal, originalLookup, canRequestOriginal }: Props) {
  return (
    <article className="app-note" id={`note-${note.jti}`} tabIndex={-1} aria-label={`Note by ${note.author}`}>
      <div className="app-avatar app-note-avatar" aria-hidden="true">{(note.displayName || displayName(note.author)).charAt(0).toUpperCase()}</div>
      <div className="app-note-content">
      <div className="app-note-heading">
        <div className="app-note-author">
          <span className="app-note-name" title={note.displayName || displayName(note.author)}>
            {note.displayName || displayName(note.author)}
          </span>
          <NoteAuthorDetails note={note} />
        </div>
        <span className="app-note-freshness" aria-label={`Freshness: ${freshnessLabel(note)}`} title={`Stake age when this note was signed: ${freshnessLabel(note)}`}>{freshnessLabel(note, true)}</span>
      </div>

      {note.replyTo && (parentNote ? <button className="app-reply-preview" onClick={() => onJumpToNote?.(parentNote.jti)} disabled={!onJumpToNote} aria-label={`View original note by ${parentNote.author}`}>
        <span className="app-reply-preview-heading"><span aria-hidden="true">↩</span><span>Replying to <strong>{parentNote.displayName || displayName(parentNote.author)}</strong></span><span className="app-reply-preview-handle">{parentNote.author}</span></span>
        <span className="app-reply-preview-body">{parentNote.body}</span>
        <span className="app-reply-preview-time">{issuedAtLabel(parentNote.issuedAt)} <span aria-hidden="true">· View original ↑</span></span>
      </button> : <div className="app-reply-missing">
        <div><span aria-hidden="true">↩ </span>Reply to an unavailable note <span className="app-reply-id" title={note.replyTo}>{note.replyTo.length > 18 ? `${note.replyTo.slice(0, 8)}…${note.replyTo.slice(-6)}` : note.replyTo}</span></div>
        <p>{originalLookup === 'missing' ? 'No peer returned the original. You can try again.' : originalLookup === 'error' ? 'Could not fetch the original. Try again.' : 'The original isn’t available on this client.'}</p>
        {onRequestOriginal && <button disabled={!canRequestOriginal || originalLookup === 'loading'} title={!canRequestOriginal ? 'Connect a readable broker with a registry verification key to fetch the original.' : 'Ask connected peers for this exact note.'} onClick={() => onRequestOriginal(note.replyTo!)}>{originalLookup === 'loading' ? 'Fetching original…' : 'Fetch original'}</button>}
      </div>)}
      <p className="app-note-body">
        {note.body}
      </p>

      <div className="app-note-footer">
        <time dateTime={Number.isNaN(new Date(note.issuedAt * 1000).getTime()) ? undefined : new Date(note.issuedAt * 1000).toISOString()} title={issuedAtLabel(note.issuedAt)} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {formatTime(note.issuedAt)}
        </time>
        <span>#{note.channel}</span>
        <button onClick={() => onReply(note)} aria-label={`Reply to ${note.author}`} title="Reply" className="app-note-reply">
          Reply <span aria-hidden="true">↩</span>
        </button>
      </div>
      </div>
    </article>
  )
})
