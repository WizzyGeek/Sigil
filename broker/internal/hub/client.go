package hub

import (
	"context"
	"log"

	"nhooyr.io/websocket"
)

const sendBufSize = 64

// Client represents one connected WebSocket peer.
type Client struct {
	id   string
	fp   string // author fingerprint, set on first verified frame (sha256:hex)
	conn *websocket.Conn
	send chan []byte
	hub  *Hub
}

func newClient(id string, conn *websocket.Conn, h *Hub) *Client {
	return &Client{
		id:   id,
		conn: conn,
		send: make(chan []byte, sendBufSize),
		hub:  h,
	}
}

// readPump reads messages from the WebSocket and dispatches them to the hub.
func (c *Client) readPump(ctx context.Context) {
	defer func() {
		c.hub.unregister <- c
	}()

	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		c.hub.inbound <- inboundEnvelope{client: c, data: data}
	}
}

// writePump drains the send channel and writes to the WebSocket.
func (c *Client) writePump(ctx context.Context) {
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			if err := c.conn.Write(ctx, websocket.MessageText, msg); err != nil {
				log.Printf("write error for %s: %v", c.id, err)
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
