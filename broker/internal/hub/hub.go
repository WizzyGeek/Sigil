package hub

import (
	"crypto/rsa"
	"fmt"
	"log"
	"net/http"
	"sync"

	"nhooyr.io/websocket"

	"sigil/broker/internal/protocol"
	"sigil/broker/internal/registry"
)

type inboundEnvelope struct {
	client *Client
	data   []byte
}

// Hub manages all connected clients and their channel subscriptions.
type Hub struct {
	mu           sync.RWMutex
	clients      map[string]*Client
	subscriptions map[string]map[string]bool // channel → set of client IDs

	registryKey *rsa.PublicKey

	register   chan *Client
	unregister chan *Client
	inbound    chan inboundEnvelope
}

func New(registryKey *rsa.PublicKey) *Hub {
	return &Hub{
		clients:       make(map[string]*Client),
		subscriptions: make(map[string]map[string]bool),
		registryKey:   registryKey,
		register:      make(chan *Client, 16),
		unregister:    make(chan *Client, 16),
		inbound:       make(chan inboundEnvelope, 256),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c.id] = c
			h.mu.Unlock()

		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c.id]; ok {
				delete(h.clients, c.id)
				close(c.send)
				for _, subs := range h.subscriptions {
					delete(subs, c.id)
				}
			}
			h.mu.Unlock()

		case env := <-h.inbound:
			h.handleMessage(env)
		}
	}
}

func (h *Hub) handleMessage(env inboundEnvelope) {
	msg, err := protocol.ParseInbound(env.data)
	if err != nil {
		h.sendError(env.client, "invalid message format")
		return
	}

	switch msg.Type {
	case protocol.CmdSubscribe:
		h.subscribe(env.client, msg.Channel)

	case protocol.CmdUnsubscribe:
		h.unsubscribeChannel(env.client, msg.Channel)

	case protocol.CmdNoteResponse:
		h.relayNote(env.client, msg.Channel, msg.UNT)

	default:
		h.sendError(env.client, fmt.Sprintf("unknown command: %s", msg.Type))
	}
}

func (h *Hub) subscribe(c *Client, channel string) {
	h.mu.Lock()
	if h.subscriptions[channel] == nil {
		h.subscriptions[channel] = make(map[string]bool)
	}
	h.subscriptions[channel][c.id] = true
	h.mu.Unlock()
}

func (h *Hub) unsubscribeChannel(c *Client, channel string) {
	h.mu.Lock()
	if subs, ok := h.subscriptions[channel]; ok {
		delete(subs, c.id)
	}
	h.mu.Unlock()
}

func (h *Hub) relayNote(sender *Client, channel string, unt string) {
	// Verify UNT before relaying
	fetchAuthorKey := func(fp string) (*rsa.PublicKey, error) {
		// In full implementation: fetch from registry HTTP API and cache
		return nil, fmt.Errorf("author key fetch not yet implemented: %s", fp)
	}

	if _, err := protocol.VerifyUNT(unt, h.registryKey, fetchAuthorKey); err != nil {
		log.Printf("UNT verification failed from %s: %v", sender.id, err)
		h.sendError(sender, "UNT verification failed")
		return
	}

	out, err := protocol.MarshalOutbound(protocol.OutboundMessage{
		Type:    protocol.CmdNoteResponse,
		Channel: channel,
		UNT:     unt,
	})
	if err != nil {
		return
	}

	h.mu.RLock()
	subs := h.subscriptions[channel]
	targets := make([]*Client, 0, len(subs))
	for id := range subs {
		if c, ok := h.clients[id]; ok && c.id != sender.id {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		select {
		case c.send <- out:
		default:
			// drop if send buffer full (slow consumer)
		}
	}
}

func (h *Hub) sendError(c *Client, msg string) {
	out, _ := protocol.MarshalOutbound(protocol.OutboundMessage{
		Type:    protocol.CmdError,
		Message: msg,
	})
	select {
	case c.send <- out:
	default:
	}
}

// ServeHTTP upgrades an HTTP connection to WebSocket and registers it with the hub.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // allow any Origin in dev; tighten in prod
	})
	if err != nil {
		log.Printf("websocket accept error: %v", err)
		return
	}

	id := registry.NewID()
	c := newClient(id, conn, h)
	h.register <- c

	ctx := r.Context()
	go c.writePump(ctx)
	c.readPump(ctx) // blocks until disconnect
}
