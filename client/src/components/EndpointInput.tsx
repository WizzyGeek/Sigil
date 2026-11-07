import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useId, useRef, useState, type CSSProperties, type InputHTMLAttributes } from 'react'
import { discoverEndpoints } from '../api/registry'
import { normalizeUrl } from '../config'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onValueChange: (value: string) => void
  discoveryRegistry?: string
  kind: 'registry' | 'broker'
}
/** An advertised suggestion never creates a connection or adds a trusted registry. */
export default function EndpointInput({ value, onValueChange, discoveryRegistry, kind, ...input }: Props) {
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState<CSSProperties>({})
  const source = discoveryRegistry ? normalizeUrl(discoveryRegistry, 'registry') : null
  const [focused, setFocused] = useState(false)
  useLayoutEffect(() => {
    if (!focused) return
    const locate = () => {
      const rect = field.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - 8, above = rect.top - 8
      const width = Math.min(rect.width, window.innerWidth - 16)
      setPosition({ position: 'fixed', left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width,
        ...(below < 140 && above > below ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.min(260, above) } : { top: rect.bottom + 4, maxHeight: Math.max(80, Math.min(260, below)) }) })
    }
    locate()
    window.addEventListener('resize', locate)
    window.addEventListener('scroll', locate, true)
    return () => { window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true) }
  }, [focused])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selected, setSelected] = useState(-1)
  const [status, setStatus] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setSuggestions([]); setSelected(-1); setStatus('')
    if (!source || !focused) return
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      setStatus('Finding advertised endpoints…')
      // Do not send connection query tokens or URL userinfo in autocomplete searches.
      const query = value.split(/[?#]/)[0].replace(/^([a-z]+:\/\/)[^/]*@/i, '$1').slice(0, 200)
      void discoverEndpoints(source, kind, query, controller.signal).then(result => {
        if (current !== generation.current || controller.signal.aborted) return
        const urls = [...new Set(result.entries.filter(entry => entry.kind === kind).map(entry => normalizeUrl(entry.url, kind)).filter((url): url is string => !!url))]
        setSuggestions(urls); setStatus(urls.length ? '' : 'No advertised matches')
      }).catch(() => { if (!controller.signal.aborted && current === generation.current) setStatus('Suggestions unavailable. You can enter a URL manually.') })
    }, 200)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [source, focused, kind, value])
  function choose(url: string) { onValueChange(url); setFocused(false); setSuggestions([]); setSelected(-1) }
  return <div className="relative flex-1 min-w-0">
    <input {...input} ref={field} value={value} onChange={event => { onValueChange(event.target.value); setFocused(true) }} role="combobox" aria-autocomplete="list" aria-expanded={focused && suggestions.length > 0} aria-controls={`${id}-suggestions`} aria-activedescendant={selected >= 0 ? `${id}-${selected}` : undefined}
      onFocus={event => { setFocused(true); input.onFocus?.(event) }}
      onBlur={event => { setFocused(false); input.onBlur?.(event) }}
      onKeyDown={event => {
        if (focused && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault(); setSelected(prev => prev < 0 ? (event.key === 'ArrowDown' ? 0 : suggestions.length - 1) : (prev + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
        } else if (focused && selected >= 0 && event.key === 'Enter') { event.preventDefault(); choose(suggestions[selected]) }
        else if (event.key === 'Escape') { event.preventDefault(); setFocused(false) }
        else input.onKeyDown?.(event)
      }} />
    {focused && source && createPortal(<div style={position} className="z-[80] overflow-y-auto rounded-lg border border-white/15 bg-[#151515] shadow-xl p-1 text-xs">
      <p className="px-2 py-1 text-white/40 truncate" title={source}>Advertised by {new URL(source).host}</p>
      <ul id={`${id}-suggestions`} role="listbox" aria-label={`Advertised ${kind} endpoints`}>
        {suggestions.map((url, index) => <li key={url} id={`${id}-${index}`} role="option" aria-selected={index === selected} className={`px-2 py-2 break-all cursor-pointer ${index === selected ? 'bg-white/10 text-gold' : 'text-white/70 hover:bg-white/5'}`} onMouseDown={event => { event.preventDefault(); choose(url) }}>{url}</li>)}
      </ul>
      {status && <p role="status" className="px-2 py-2 text-white/45">{status}</p>}
    </div>, document.body)}
  </div>
}
