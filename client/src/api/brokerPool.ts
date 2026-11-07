import { BrokerClient } from './broker'
import type { UNTFrame } from '../types/protocol'

interface Connection { client?: BrokerClient; connected: boolean }
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
    const wanted = new Set(urls)
    for (const [url, entry] of this.connections) if (!wanted.has(url)) {
      this.connections.delete(url)
      entry.client?.close()
    }
    for (const url of wanted) if (!this.connections.has(url)) {
      const entry: Connection = { connected: false }
      this.connections.set(url, entry)
      try {
        entry.client = new BrokerClient(url,
          frame => { if (this.connections.get(url) === entry) this.options.onFrame(url, frame) },
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
    entry.client.send(frame)
  }
  /** Used only for newly authored frames, never for traffic received from brokers. */
  publish(frame: UNTFrame): { sent: number; failed: string[] } {
    let sent = 0
    const failed: string[] = []
    for (const [url, entry] of this.connections) if (entry.connected) {
      try { this.sendTo(url, frame); sent++ } catch { failed.push(url) }
    }
    if (!sent) throw new Error('No broker connection could send the note. Your draft has been kept; reconnect and retry.')
    return { sent, failed }
  }
  close() {
    const entries = [...this.connections.values()]
    this.connections.clear()
    for (const entry of entries) entry.client?.close()
  }
}
