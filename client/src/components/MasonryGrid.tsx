import React from 'react'
import type { Note } from '../types/protocol'
import NoteCard from './NoteCard'

interface Props {
  notes: Note[]
  onReply: (note: Note) => void
  emptyMessage: string
}

export default React.memo(function NoteList({ notes, onReply, emptyMessage }: Props) {
  if (notes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-white/20 text-sm">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div>
      {notes.map(note => (
        <NoteCard key={note.jti} note={note} onReply={onReply} />
      ))}
    </div>
  )
})
