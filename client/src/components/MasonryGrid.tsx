import React, { useMemo } from 'react'
import type { Note } from '../types/protocol'
import NoteCard from './NoteCard'

interface Props {
  notes: Note[]
  onReply: (note: Note) => void
  emptyMessage: string
  emptyTitle?: string
  onJumpToNote?: (jti: string) => void
  onRequestOriginal?: (jti: string) => void
  originalLookups?: Record<string, 'loading' | 'missing' | 'error'>
  canRequestOriginal?: boolean
}

export default React.memo(function NoteList({ notes, onReply, emptyMessage, emptyTitle = 'No notes yet', onJumpToNote, onRequestOriginal, originalLookups = {}, canRequestOriginal = false }: Props) {
  const notesByJti = useMemo(() => new Map(notes.map(note => [note.jti, note])), [notes])
  if (notes.length === 0) {
    return (
      <div className="app-empty"><span className="app-empty-mark" aria-hidden="true">#</span><h2>{emptyTitle}</h2><p>{emptyMessage}</p></div>
    )
  }

  return (
    <div className="app-note-list">
      {notes.map(note => (
        <NoteCard key={note.jti} note={note} onReply={onReply} parentNote={note.replyTo && note.replyTo !== note.jti ? notesByJti.get(note.replyTo) : undefined} onJumpToNote={onJumpToNote} onRequestOriginal={onRequestOriginal} originalLookup={note.replyTo ? originalLookups[note.replyTo] : undefined} canRequestOriginal={canRequestOriginal} />
      ))}
    </div>
  )
})
