/** Broker WebSocket client. Every wire message is a UNTFrame: [payload_object, sig_b64]. */

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

  constructor(url: string, onFrame: FrameHandler, onStatus: StatusHandler) {
    this.url = url
    this.onFrame = onFrame
    this.onStatus = onStatus
    this.connect()
  }

  private connect() {
    if (this.dead) return
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.retryDelay = 1000
      this.onStatus(true)
    }

    this.ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as UNTFrame
        this.onFrame(frame)
      } catch {
        // ignore malformed frames
      }
    }

    this.ws.onclose = () => {
      this.onStatus(false)
      if (!this.dead) {
        setTimeout(() => this.connect(), this.retryDelay)
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
      }
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  send(frame: UNTFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('[broker] →', (frame[0] as Record<string, unknown>).type)
      this.ws.send(JSON.stringify(frame))
    } else {
      console.error('[broker] send failed — socket not open', { readyState: this.ws?.readyState })
    }
  }

  close() {
    this.dead = true
    this.ws?.close()
  }
}
