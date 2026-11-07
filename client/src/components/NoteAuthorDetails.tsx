import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Note } from '../types/protocol'
import { freshnessLabel, issuedAtLabel } from './noteMetadata'

export default function NoteAuthorDetails({ note }: { note: Note }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const seconds = Number.isFinite(note.stakeIssuedAt) ? note.issuedAt - note.stakeIssuedAt : undefined
  const iso = Number.isNaN(new Date(note.issuedAt * 1000).getTime()) ? undefined : new Date(note.issuedAt * 1000).toISOString()
  function show() { clearTimeout(timer.current); setOpen(true) }
  function hideSoon() {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (document.activeElement === trigger.current || card.current?.contains(document.activeElement)) return
      setOpen(false)
    }, 150)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(380, window.innerWidth - 24)
    const below = window.innerHeight - rect.bottom - 16
    setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      ...(below >= 200 ? { top: rect.bottom + 8, maxHeight: below } : { bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(100, rect.top - 20) }) })
    const close = () => setOpen(false)
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !card.current?.contains(event.target)) close() }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !trigger.current?.contains(event.target) && !card.current?.contains(event.target)) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', scroll, true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <>
    <button ref={trigger} type="button" aria-label={`Note details for ${note.author}`} aria-describedby={open ? id : undefined}
      className="text-[11px] text-white/50 hover:text-gold focus-visible:text-gold focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold rounded-sm truncate text-left"
      style={{ fontFamily: 'JetBrains Mono, monospace' }} onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show}
      onBlur={event => { if (!card.current?.contains(event.relatedTarget as Node) && !card.current?.matches(':hover')) hideSoon() }} onClick={show}>
      {note.author}
    </button>
    {open && createPortal(<div ref={card} id={id} role="tooltip" style={position}
      className="z-[90] rounded-xl border border-white/15 bg-[#151515] shadow-2xl p-4 text-xs text-white/75 overflow-y-auto select-text"
      onMouseEnter={show} onMouseLeave={hideSoon}>
      <p className="text-white/90 font-semibold break-all mb-3">{note.author}</p>
      <dl className="space-y-3">
        <div><dt className="text-white/40 mb-1">Fingerprint</dt><dd className="font-mono text-gold break-all" data-testid="note-fingerprint">{note.authorFp}</dd></div>
        <div><dt className="text-white/40 mb-1">Issued at</dt><dd><time dateTime={iso}>{issuedAtLabel(note.issuedAt)}</time>{iso && <span className="block text-[10px] text-white/40 mt-1">{iso}</span>}</dd></div>
        <div><dt className="text-white/40 mb-1">Freshness · stake age at signing</dt><dd>{freshnessLabel(note)}{seconds !== undefined && seconds >= 60 && <span className="text-white/40"> ({seconds} seconds)</span>}</dd></div>
      </dl>
    </div>, document.body)}
  </>
}
