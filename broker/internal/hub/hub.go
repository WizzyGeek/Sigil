package hub

import (
	"crypto/rsa"
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
	mu            sync.RWMutex
	clients       map[string]*Client
	subscriptions map[string]map[string]bool // channel → set of client IDs
	fingerprints  map[string]string          // author fingerprint → client ID (unicast index)

	registryKey       *rsa.PublicKey
	minFreshnessScore int
	maxFrameBytes     int
	maxContentBytes   int
	maxRelayBatch     int

	register   chan *Client
	unregister chan *Client
	inbound    chan inboundEnvelope
}

type Config struct {
	MinFreshnessScore int
	MaxFrameBytes     int
	MaxContentBytes   int
	MaxRelayBatch     int
}

func New(registryKey *rsa.PublicKey, cfg Config) *Hub {
	return &Hub{
		clients:           make(map[string]*Client),
		subscriptions:     make(map[string]map[string]bool),
		fingerprints:      make(map[string]string),
		registryKey:       registryKey,
		minFreshnessScore: cfg.MinFreshnessScore,
		maxFrameBytes:     cfg.MaxFrameBytes,
		maxContentBytes:   cfg.MaxContentBytes,
		maxRelayBatch:     cfg.MaxRelayBatch,
		register:          make(chan *Client, 16),
		unregister:        make(chan *Client, 16),
		inbound:           make(chan inboundEnvelope, 256),
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
				// Remove from fingerprint index if this client had been identified.
				if c.fp != "" {
					delete(h.fingerprints, c.fp)
				}
			}
			h.mu.Unlock()

		case env := <-h.inbound:
			h.handleMessage(env)
		}
	}
}

func (h *Hub) handleMessage(env inboundEnvelope) {
	// Pre-check: reject oversized frames before any parsing or crypto work.
	if len(env.data) > h.maxFrameBytes {
		log.Printf("frame too large from %s: %d bytes (max %d)", env.client.id, len(env.data), h.maxFrameBytes)
		return
	}

	claims, err := protocol.VerifyUNT(env.data, h.registryKey)
	if err != nil {
		log.Printf("UNT verify failed from %s: %v", env.client.id, err)
		return
	}

	if claims.FreshnessScore < h.minFreshnessScore {
		log.Printf("UNT freshness too low from %s: score=%d min=%d", env.client.id, claims.FreshnessScore, h.minFreshnessScore)
		return
	}

	// Update fingerprint → connection index from every verified frame.
	// jti deduplication is the client's responsibility (via IndexedDB).
	if claims.AuthorFp != "" && env.client.fp == "" {
		env.client.fp = claims.AuthorFp
		h.mu.Lock()
		h.fingerprints[claims.AuthorFp] = env.client.id
		h.mu.Unlock()
	}

	// Route on verified type and channel — never trust unverified wire fields.
	switch claims.Type {
	case protocol.TypeSubscribe:
		h.subscribe(env.client, claims.Channel)

	case protocol.TypeUnsubscribe:
		h.unsubscribeChannel(env.client, claims.Channel)

	case protocol.TypeNote:
		if len(claims.Content) > h.maxContentBytes {
			log.Printf("note content too large from %s: %d bytes (max %d)", env.client.id, len(claims.Content), h.maxContentBytes)
			return
		}
		h.fanout(env.client, claims.Channel, env.data)

	case protocol.TypeRequestNotes:
		h.fanout(env.client, claims.Channel, env.data)

	case protocol.TypeNoteRelay:
		if claims.RelayCount > h.maxRelayBatch {
			log.Printf("note_relay batch too large from %s: %d (max %d)", env.client.id, claims.RelayCount, h.maxRelayBatch)
			return
		}
		h.unicast(claims.To, env.data)

	default:
		log.Printf("unknown UNT type %q from %s — dropped", claims.Type, env.client.id)
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

// fanout relays raw frame bytes to all channel subscribers except the sender.
func (h *Hub) fanout(sender *Client, channel string, data []byte) {
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
		msg := make([]byte, len(data))
		copy(msg, data)
		select {
		case c.send <- msg:
		default:
			// Drop if send buffer full (slow consumer).
		}
	}
}

// unicast delivers a frame to the single connection identified by fingerprint.
func (h *Hub) unicast(fp string, data []byte) {
	if fp == "" {
		return
	}
	h.mu.RLock()
	id, ok := h.fingerprints[fp]
	var target *Client
	if ok {
		target = h.clients[id]
	}
	h.mu.RUnlock()

	if target == nil {
		log.Printf("unicast: no connection for fingerprint %s — dropped", fp)
		return
	}
	msg := make([]byte, len(data))
	copy(msg, data)
	select {
	case target.send <- msg:
	default:
		// Drop if send buffer full.
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
