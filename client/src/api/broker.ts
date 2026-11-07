/** Broker WebSocket client. Every wire message is a UNTFrame: [payload_object, sig_b64]. */

import { config } from '../config'
import type { UNTFrame } from '../types/protocol'

type FrameHandler = (frame: UNTFrame) => void
type StatusHandler = (connected: boolean) => void

export class BrokerClient {
  private ws: WebSocket | null = null
  private url: string
  private onFrame: FrameHandler
  private onStatus: StatusHandler
  private retryDelay = 1000
  private dead = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, onFrame: FrameHandler, onStatus: StatusHandler) {
    this.url = url
    this.onFrame = onFrame
    this.onStatus = onStatus
    this.connect()
  }

  private connect() {
    if (this.dead) return
    const socket = new WebSocket(this.url)
    this.ws = socket

    socket.onopen = () => {
      if (this.dead || this.ws !== socket) return
      this.retryDelay = 1000
      this.onStatus(true)
    }

    socket.onmessage = (ev) => {
      if (this.dead || this.ws !== socket) return
      if (typeof ev.data !== 'string' || new TextEncoder().encode(ev.data).length > config.maxFrameBytes) return
      try {
        const frame = JSON.parse(ev.data as string) as UNTFrame
        this.onFrame(frame)
      } catch {
        // ignore malformed frames
      }
    }

    socket.onclose = () => {
      if (this.dead || this.ws !== socket) return
      this.onStatus(false)
      if (!this.dead) {
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
      }
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  send(frame: UNTFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(frame)
      if (new TextEncoder().encode(data).length > config.maxFrameBytes) throw new Error(`Frame exceeds the configured ${config.maxFrameBytes}-byte limit.`)
      this.ws.send(data)
    } else {
      throw new Error('Broker is disconnected. Your draft has been kept; reconnect and try again.')
    }
  }

  close() {
    this.dead = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
  }
}
