import { useLayoutEffect, useRef, useState, useEffect, useCallback } from 'react'
import type { Note } from '../types/protocol'
import NoteList from './MasonryGrid'

interface Props {
  channel: string
  notes: Note[]
  onReply: (note: Note) => void
  emptyMessage: string
  followToken: number
  onRequestOriginal?: (jti: string) => Promise<boolean>
  canRequestOriginal?: boolean
}

export default function NoteFeed({ channel, notes, onReply, emptyMessage, followToken, onRequestOriginal, canRequestOriginal }: Props) {
  const [originalLookups, setOriginalLookups] = useState<Record<string, 'loading' | 'missing' | 'error'>>({})
  const lookupEpoch = useRef(0)
  useEffect(() => { lookupEpoch.current++; setOriginalLookups({}); return () => { lookupEpoch.current++ } }, [channel])
  async function requestOriginal(jti: string) {
    if (!onRequestOriginal) return
    const epoch = lookupEpoch.current
    setOriginalLookups(prev => ({ ...prev, [jti]: 'loading' }))
    try {
      const found = await onRequestOriginal(jti)
      if (lookupEpoch.current === epoch) setOriginalLookups(prev => { const next = { ...prev }; if (found) delete next[jti]; else next[jti] = 'missing'; return next })
    } catch { if (lookupEpoch.current === epoch) setOriginalLookups(prev => ({ ...prev, [jti]: 'error' })) }
  }
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

  const jumpToNote = useCallback((jti: string) => {
    const element = document.getElementById(`note-${jti}`)
    if (!element || !scroller.current?.contains(element)) return
    follow.current = false
    element.scrollIntoView({ block: 'center', behavior: 'instant' })
    element.focus({ preventScroll: true })
    const timeline = scroller.current
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48
    follow.current = nearBottom
    setAtLatest(nearBottom)
  }, [])

  return <div className="relative flex-1 min-h-0">
    <div ref={scroller} aria-label="Notes timeline" className="h-full overflow-y-auto" onScroll={() => {
      const element = scroller.current
      if (!element) return
      const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      follow.current = nearBottom
      setAtLatest(nearBottom)
    }}>
      <NoteList notes={notes} onReply={onReply} emptyMessage={emptyMessage} emptyTitle={channel ? 'No notes yet' : 'Choose your first channel'} onJumpToNote={jumpToNote} onRequestOriginal={onRequestOriginal ? requestOriginal : undefined} originalLookups={originalLookups} canRequestOriginal={canRequestOriginal} />
    </div>
    {!atLatest && notes.length > 0 && <button className="app-latest-note" onClick={latest}>↓ Latest note</button>}
  </div>
}
