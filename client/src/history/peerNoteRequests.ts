import { buildCommand, verifyUnt, verifyUntFrame } from '../crypto/unt'
import { peerFingerprint } from './peerHistory'
import type { RegistryKeyring } from '../crypto/registryTrust'
import type { Note, StakeFrame, UNTFrame, UNTOuterClaims } from '../types/protocol'

interface Options {
  fingerprint: string
  privateKey: CryptoKey
  keys: RegistryKeyring
  getStake: () => Promise<StakeFrame>
  send: (frame: UNTFrame) => void
  readNote: (jti: string) => Promise<Note | undefined>
  save: (note: Note) => Promise<boolean>
  onNote: (note: Note) => void
  onError?: (error: Error) => void
  timeoutMs?: number
  maxFrameBytes?: number
}
interface Pending {
  channel: string
  noteJti: string
  id?: string
  done: boolean
  promise: Promise<boolean>
  finish: (found: boolean) => void
}
export function validNoteJti(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 256
}

/** A direct, bounded lookup. No history scans, pagination or automatic retries. */
export class PeerNoteRequests {
  private pending = new Map<string, Pending>()
  private inflight = new Map<string, Pending>()
  private responded = new Map<string, number>()
  private closed = false
  constructor(private options: Options) {}

  dispose() {
    this.closed = true
    for (const request of [...this.inflight.values()]) request.finish(false)
    this.responded.clear()
  }

  request(channel: string, noteJti: string): Promise<boolean> {
    if (this.closed || !channel || !validNoteJti(noteJti)) return Promise.resolve(false)
    const key = JSON.stringify([channel, noteJti])
    const existing = this.inflight.get(key)
    if (existing) return existing.promise
    if (this.inflight.size >= 64) return Promise.resolve(false)
    let resolve!: (found: boolean) => void
    const promise = new Promise<boolean>(done => { resolve = done })
    const request: Pending = { channel, noteJti, done: false, promise, finish: found => {
      if (request.done) return
      request.done = true
      clearTimeout(timer)
      if (request.id) this.pending.delete(request.id)
      this.inflight.delete(key)
      resolve(found)
    } }
    const timer = setTimeout(() => request.finish(false), this.options.timeoutMs ?? 5000)
    this.inflight.set(key, request)
    void (async () => {
      try {
        const stake = await this.options.getStake()
        if (request.done || this.closed) return
        const frame = await buildCommand('request_note', channel, stake, this.options.privateKey, { note_jti: noteJti })
        if (request.done || this.closed) return
        request.id = frame[0].jti as string
        this.pending.set(request.id, request)
        this.options.send(frame)
      } catch (error) {
        if (!request.done && !this.closed) this.options.onError?.(error as Error)
        request.finish(false)
      }
    })()
    return promise
  }

  async handle(frame: UNTFrame) {
    if (this.closed) return
    const { outer, inner } = await verifyUntFrame(frame, this.options.keys)
    if (this.closed) return
    if (outer.type === 'request_note') await this.respond(outer, await peerFingerprint(inner.public_key))
    else if (outer.type === 'note_relay') await this.receive(outer)
  }

  private async respond(request: UNTOuterClaims, peer: string) {
    if (!validNoteJti(request.note_jti) || !request.jti || !request.channel || !Number.isSafeInteger(request.iat) || request.iat < Math.floor(Date.now() / 1000) - 300) return
    const key = JSON.stringify([peer, request.jti])
    if (this.responded.has(key)) return
    for (const [id, at] of this.responded) if (at < Date.now() - 300000) this.responded.delete(id)
    if (this.responded.size >= 1000) this.responded.delete(this.responded.keys().next().value!)
    this.responded.set(key, Date.now())
    try {
      const stored = await this.options.readNote(request.note_jti)
      if (!stored) return // A missing peer stays silent; another peer may have it.
      const raw = JSON.parse(stored.raw) as UNTFrame
      const note = await verifyUnt(raw, this.options.keys)
      if (note.jti !== request.note_jti || note.channel !== request.channel) return
      const stake = await this.options.getStake()
      if (this.closed) return
      const reply = await buildCommand('note_relay', request.channel, stake, this.options.privateKey, {
        to: peer, request_jti: request.jti, note_jti: request.note_jti, relays: [raw],
      })
      if (!this.closed && new TextEncoder().encode(JSON.stringify(reply)).length <= (this.options.maxFrameBytes ?? 262144)) this.options.send(reply)
    } catch (error) {
      this.responded.delete(key)
      if (!this.closed) this.options.onError?.(error as Error)
    }
  }

  private async receive(relay: UNTOuterClaims) {
    const request = relay.request_jti ? this.pending.get(relay.request_jti) : undefined
    if (!request || request.done || relay.to !== this.options.fingerprint || relay.channel !== request.channel || relay.note_jti !== request.noteJti || !Array.isArray(relay.relays) || relay.relays.length !== 1) return
    // The envelope cannot vouch for the original author's content or registry.
    const note = await verifyUnt(relay.relays[0], this.options.keys)
    if (note.jti !== request.noteJti || note.channel !== request.channel || request.done || this.closed) return
    await this.options.save(note)
    if (request.done || this.closed) return
    this.options.onNote(note) // Also refresh the view if another connection saved it first.
    request.finish(true)
  }
}
