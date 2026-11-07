import { useLayoutEffect, useRef, useState } from 'react'
import type { Note } from '../types/protocol'
import NoteList from './MasonryGrid'

interface Props {
  channel: string
  notes: Note[]
  onReply: (note: Note) => void
  emptyMessage: string
  followToken: number
}

export default function NoteFeed({ channel, notes, onReply, emptyMessage, followToken }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const previousChannel = useRef(channel)
  const previousToken = useRef(followToken)
  const [atLatest, setAtLatest] = useState(true)

  const latest = () => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
    follow.current = true
    setAtLatest(true)
  }
  useLayoutEffect(() => {
    const changed = previousChannel.current !== channel || previousToken.current !== followToken
    previousChannel.current = channel
    previousToken.current = followToken
    if (changed) follow.current = true
    if (follow.current) latest()
  }, [channel, notes, followToken])

  return <div className="relative flex-1 min-h-0">
    <div ref={scroller} aria-label="Notes timeline" className="h-full overflow-y-auto" onScroll={() => {
      const element = scroller.current
      if (!element) return
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      follow.current = nearBottom
      setAtLatest(nearBottom)
    }}>
      <NoteList notes={notes} onReply={onReply} emptyMessage={emptyMessage} />
    </div>
    {!atLatest && notes.length > 0 && <button className="absolute bottom-3 right-4 rounded-full px-4 py-2 text-xs bg-gold text-black shadow-lg" onClick={latest}>↓ Latest note</button>}
  </div>
}
