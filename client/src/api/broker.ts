/** Broker WebSocket client with auto-reconnect. */

import type { ClientCommand, ServerCommand } from '../types/protocol'

type MessageHandler = (msg: ServerCommand) => void
type StatusHandler = (connected: boolean) => void

export class BrokerClient {
  private ws: WebSocket | null = null
  private url: string
  private onMessage: MessageHandler
  private onStatus: StatusHandler
  private retryDelay = 1000
  private dead = false

  constructor(url: string, onMessage: MessageHandler, onStatus: StatusHandler) {
    this.url = url
    this.onMessage = onMessage
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
        const msg = JSON.parse(ev.data as string) as ServerCommand
        this.onMessage(msg)
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

  send(cmd: ClientCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

  close() {
    this.dead = true
    this.ws?.close()
  }
}
