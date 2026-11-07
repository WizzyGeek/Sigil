import { buildCommand, verifyUnt, verifyUntFrame } from '../crypto/unt'
import { signFrame } from '../crypto/jwt'
import { fingerprintFromSpki } from '../crypto/fingerprint'
import type { RegistryKeyring } from '../crypto/registryTrust'
import type { HistoryCursor, Note, StakeFrame, UNTFrame, UNTOuterClaims } from '../types/protocol'
import type { HistoryPage } from '../store/notes'

export interface HistoryStatus {
  phase: 'syncing' | 'synced' | 'no-peers' | 'incomplete'
  peers: number
  received: number
  skipped?: number
}
interface Session {
  channel: string; till: number; peers: Set<string>; received: number; skipped: number
  rootClosed: boolean; incomplete: boolean; processing: number
}
interface Query { to?: string; peerId?: string; before?: HistoryCursor }
interface Pending {
  id: string; session: Session; query: Query; attempt: number
  responders: Set<string>; processing: Set<string>; received: boolean
  timer: ReturnType<typeof setTimeout>
}
export interface HistoryOptions {
  fingerprint: string
  peerId?: string
  privateKey: CryptoKey
  keys: RegistryKeyring
  getStake: () => Promise<StakeFrame>
  send: (frame: UNTFrame) => void
  readPage: (channel: string, till: number, before?: HistoryCursor, limit?: number) => Promise<HistoryPage>
  save: (note: Note) => Promise<boolean>
  onNote: (note: Note) => void
  onStatus?: (channel: string, status: HistoryStatus) => void
  onError?: (error: Error) => void
  batchSize?: number
  maxFrameBytes?: number
  timeoutMs?: number
  now?: () => number
}

export function cursorFor(note: Pick<Note, 'issuedAt' | 'jti'>): HistoryCursor { return { iat: note.issuedAt, jti: note.jti } }
export function validCursor(cursor: unknown): cursor is HistoryCursor {
  const value = cursor as HistoryCursor | undefined
  return !!value && Number.isSafeInteger(value.iat) && value.iat > 0 && typeof value.jti === 'string' && value.jti.length > 0
}
export function beforeCursor(note: HistoryCursor, before: HistoryCursor): boolean {
  return note.iat < before.iat || (note.iat === before.iat && note.jti < before.jti)
}
export async function peerFingerprint(pem: string): Promise<string> {
  const bytes = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0))
  return 'sha256:' + await fingerprintFromSpki(bytes.buffer)
}

/** Correlated, per-peer pagination. There is no random chance of ignoring a sole peer. */
export class PeerHistory {
  private pending = new Map<string, Pending>()
  private sessions = new Map<string, Session>()
  private responded = new Map<string, number>()
  private closed = false
  private readonly peerId: string
  private readonly batchSize: number
  private readonly maxBytes: number
  private readonly now: () => number
  constructor(private options: HistoryOptions) {
    this.peerId = options.peerId ?? crypto.randomUUID()
    this.batchSize = Math.max(1, Math.min(25, options.batchSize ?? 25))
    this.maxBytes = options.maxFrameBytes ?? 262144
    this.now = options.now ?? Date.now
  }
  dispose() {
    this.closed = true
    for (const request of this.pending.values()) clearTimeout(request.timer)
    this.pending.clear(); this.sessions.clear(); this.responded.clear()
  }
  async start(channel: string) {
    for (const request of this.pending.values()) if (request.session.channel === channel) this.remove(request)
    const session: Session = { channel, till: Math.floor(this.now() / 1000) + 1, peers: new Set(), received: 0, skipped: 0, rootClosed: false, incomplete: false, processing: 0 }
    this.sessions.set(channel, session)
    this.report(session)
    await this.issue(session, {}, 1)
  }
  private active(session: Session) { return !this.closed && this.sessions.get(session.channel) === session }
  private report(session: Session) {
    if (!this.active(session)) return
    const waiting = session.processing > 0 || !session.rootClosed || [...this.pending.values()].some(p => p.session === session)
    this.options.onStatus?.(session.channel, { phase: waiting ? 'syncing' : session.incomplete ? 'incomplete' : session.peers.size ? 'synced' : 'no-peers', peers: session.peers.size, received: session.received, skipped: session.skipped })
  }
  private remove(request: Pending) { clearTimeout(request.timer); this.pending.delete(request.id) }
  private async issue(session: Session, query: Query, attempt: number) {
    try {
      const stake = await this.options.getStake()
      if (!this.active(session)) return
      const frame = await buildCommand('request_notes', session.channel, stake, this.options.privateKey, { till: session.till, before: query.before, to: query.to, peer_id: query.peerId })
      if (!this.active(session)) return
      const id = frame[0].jti as string
      const request: Pending = { id, session, query, attempt, responders: new Set(), processing: new Set(), received: false, timer: setTimeout(() => this.timeout(id), this.options.timeoutMs ?? 5000) }
      this.pending.set(id, request)
      try { this.options.send(frame) } catch (error) { this.remove(request); throw error }
    } catch (error) {
      if (!this.active(session)) return
      session.rootClosed = true; session.incomplete = true
      this.options.onError?.(error as Error)
      this.report(session)
    }
  }
  private timeout(id: string) {
    const request = this.pending.get(id)
    if (!request) return
    this.remove(request)
    if (!this.active(request.session)) return
    if (!request.received && request.attempt < 3) {
      void this.issue(request.session, request.query, request.attempt + 1)
      return
    }
    if (!request.query.to) request.session.rootClosed = true
    if (!request.received && (request.query.to || request.session.peers.size > 0)) request.session.incomplete = true
    this.report(request.session)
  }
  async handle(frame: UNTFrame) {
    if (this.closed) return
    const { outer, inner } = await verifyUntFrame(frame, this.options.keys)
    if (this.closed || !outer.jti || !outer.channel) return
    const peer = await peerFingerprint(inner.public_key)
    if (outer.type === 'request_notes') await this.respond(outer, peer)
    else if (outer.type === 'note_relay') await this.receive(outer, peer)
  }
  private async respond(request: UNTOuterClaims, peer: string) {
    if (request.to && request.to !== this.options.fingerprint) return
    if (request.peer_id && request.peer_id !== this.peerId) return
    if (request.iat < Math.floor(this.now() / 1000) - 300) return
    const till = request.till ?? Math.floor(this.now() / 1000) + 1
    if (!Number.isSafeInteger(till) || till <= 0 || (request.before !== undefined && (!validCursor(request.before) || request.before.iat >= till))) return
    const responseKey = peer + ':' + request.jti
    if (this.responded.has(responseKey)) return
    for (const [key, at] of this.responded) if (at < this.now() - 300000) this.responded.delete(key)
    if (this.responded.size >= 1000) this.responded.delete(this.responded.keys().next().value!)
    this.responded.set(responseKey, this.now())
    try {
      const stake = await this.options.getStake()
      const shell = await buildCommand('note_relay', request.channel, stake, this.options.privateKey, { to: peer, request_jti: request.jti, peer_id: this.peerId, relays: [], has_more: false, next_cursor: null })
      if (new TextEncoder().encode(JSON.stringify(shell)).length > this.maxBytes) throw new Error('Configured frame limit cannot fit a signed history envelope')
      const relays: UNTFrame[] = []
      let scan = request.before, next: HistoryCursor | null = null, more = false, finished = false
      while (!finished && !this.closed) {
        const page = await this.options.readPage(request.channel, till, scan, this.batchSize)
        if (!page.notes.length) break
        for (let index = 0; index < page.notes.length; index++) {
          const stored = page.notes[index]
          scan = cursorFor(stored)
          let note: Note, raw: UNTFrame
          try {
            raw = JSON.parse(stored.raw) as UNTFrame
            note = await verifyUnt(raw, this.options.keys)
            if (note.channel !== request.channel || note.jti !== stored.jti || note.issuedAt !== stored.issuedAt) continue
          } catch { continue }
          const cursor = cursorFor(note)
          const candidate = { ...shell[0], relays: [...relays, raw], has_more: true, next_cursor: cursor }
          if (new TextEncoder().encode(JSON.stringify([candidate, shell[1]])).length > this.maxBytes) {
            if (relays.length) { more = true; finished = true; break }
            continue // A single oversized original cannot fit inside an envelope.
          }
          relays.push(raw); next = cursor
          more = index < page.notes.length - 1 || page.more
          if (relays.length === this.batchSize) { finished = true; break }
        }
        if (!page.more) break
      }
      if (this.closed) return
      // Empty responses explicitly acknowledge a peer with no matching history.
      const payload = { ...shell[0], relays, has_more: relays.length > 0 && more, next_cursor: relays.length > 0 && more ? next : null }
      const reply = await signFrame(payload, this.options.privateKey)
      if (!this.closed) this.options.send(reply)
    } catch (error) {
      this.responded.delete(responseKey)
      if (!this.closed) this.options.onError?.(error as Error)
    }
  }
  private async receive(relay: UNTOuterClaims, peer: string) {
    if (relay.to !== this.options.fingerprint || !relay.request_jti) return
    if (typeof relay.peer_id !== 'string' || !relay.peer_id) return
    const peerSession = peer + ":" + relay.peer_id
    const request = this.pending.get(relay.request_jti)
    if (!request || !this.active(request.session) || relay.channel !== request.session.channel || (request.query.to && request.query.to !== peer) || (request.query.peerId && request.query.peerId !== relay.peer_id) || request.responders.has(peerSession) || request.processing.has(peerSession)) return
    if (!Array.isArray(relay.relays) || relay.relays.length > 25 || typeof relay.has_more !== 'boolean') return
    request.processing.add(peerSession); request.session.processing++
    try {
      const notes: Note[] = []
      let previous = request.query.before
      let skipped = 0
      for (const raw of relay.relays) {
        const payload = raw?.[0]
        const cursor = { iat: payload?.iat as number, jti: payload?.jti as string }
        // The verified relay envelope authenticates pagination metadata. An
        // original note still needs its own issuer/author verification to store.
        if (!validCursor(cursor) || payload.type !== 'note' || payload.channel !== relay.channel || cursor.iat >= request.session.till || (previous && !beforeCursor(cursor, previous))) throw new Error('History page is outside its requested channel or cursor')
        previous = cursor
        try { notes.push(await verifyUnt(raw, this.options.keys)) }
        catch { skipped++ }
      }
      if (relay.has_more && (!relay.relays.length || !validCursor(relay.next_cursor) || relay.next_cursor.iat !== previous!.iat || relay.next_cursor.jti !== previous!.jti)) throw new Error('History page has an invalid continuation cursor')
      if (!this.active(request.session)) return
      request.session.peers.add(peerSession)
      request.session.skipped += skipped
      try {
        for (const note of notes) {
          if (!this.active(request.session)) return
          if (await this.options.save(note)) { request.session.received++; this.options.onNote(note) }
        }
      } catch (error) {
        this.options.onError?.(error as Error)
        throw error // Leave this request unacknowledged so its retry can recover.
      }
      request.received = true; request.responders.add(peerSession)
      if (request.query.to) this.remove(request)
      if (relay.has_more) await this.issue(request.session, { to: peer, peerId: relay.peer_id, before: relay.next_cursor! }, 1)
    } finally {
      request.processing.delete(peerSession); request.session.processing--
      this.report(request.session)
    }
  }
}
