import { BrokerClient } from './broker'
import type { UNTFrame } from '../types/protocol'

export interface BrokerTarget { url: string; read: boolean; publish: boolean }
interface Connection { client?: BrokerClient; connected: boolean; read: boolean; publish: boolean }
interface Options {
  onFrame: (url: string, frame: UNTFrame) => void
  onChange: (connections: Record<string, boolean>) => void
  onError: (error: Error) => void
}

/** Independent client↔broker connections. Receiving a frame never rebroadcasts it. */
export class BrokerPool {
  private connections = new Map<string, Connection>()
  constructor(private options: Options) {}
  private emit() { this.options.onChange(Object.fromEntries([...this.connections].map(([url, entry]) => [url, entry.connected]))) }
  updateUrls(urls: readonly string[]) {
    this.updateBrokers(urls.map(url => ({ url, read: true, publish: true })))
  }
  updateBrokers(targets: readonly BrokerTarget[]) {
    const wanted = new Map(targets.filter(target => target.read || target.publish).map(target => [target.url, target]))
    for (const [url, entry] of this.connections) if (!wanted.has(url) || wanted.get(url)!.read !== entry.read) {
      this.connections.delete(url)
      entry.client?.close()
    }
    for (const [url, target] of wanted) {
      const current = this.connections.get(url)
      if (current) { current.publish = target.publish; continue }
      const entry: Connection = { connected: false, read: target.read, publish: target.publish }
      this.connections.set(url, entry)
      try {
        entry.client = new BrokerClient(url,
          frame => { if (this.connections.get(url) === entry && entry.read) this.options.onFrame(url, frame) },
          connected => {
            if (this.connections.get(url) !== entry || entry.connected === connected) return
            entry.connected = connected
            this.emit()
          })
      } catch (error) { this.options.onError(error as Error) }
    }
    this.emit()
  }
  sendTo(url: string, frame: UNTFrame) {
    const entry = this.connections.get(url)
    if (!entry?.connected || !entry.client) throw new Error(`Broker ${url} is disconnected.`)
    const type = frame[0].type
    if ((type === 'note' || type === 'note_relay') && !entry.publish) throw new Error(`Publishing is disabled for ${url}.`)
    if (type !== 'note' && type !== 'note_relay' && !entry.read) throw new Error(`Reading is disabled for ${url}.`)
    entry.client.send(frame)
  }
  /** Used only for newly authored frames, never for traffic received from brokers. */
  publish(frame: UNTFrame): { sent: number; failed: string[] } {
    let sent = 0
    const failed: string[] = []
    for (const [url, entry] of this.connections) if (entry.connected && entry.publish) {
      try { this.sendTo(url, frame); sent++ } catch { failed.push(url) }
    }
    if (!sent) throw new Error('No publish-enabled broker connection could send the note. Your draft has been kept; reconnect and retry.')
    return { sent, failed }
  }
  close() {
    const entries = [...this.connections.values()]
    this.connections.clear()
    for (const entry of entries) entry.client?.close()
  }
}
