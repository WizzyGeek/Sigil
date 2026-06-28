import React from 'react'
import type { Note } from '../types/protocol'
import NoteCard from './NoteCard'

interface Props {
  notes: Note[]
}

export default React.memo(function NoteList({ notes }: Props) {
  if (notes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-white/20 text-sm">
        No notes yet — subscribe to a channel and start writing.
      </div>
    )
  }

  return (
    <div>
      {notes.map(note => (
        <NoteCard key={note.jti} note={note} />
      ))}
    </div>
  )
})
