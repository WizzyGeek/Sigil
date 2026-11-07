package hub

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"

	"sigil/broker/internal/protocol"
	"sigil/broker/internal/registry"
)

type inboundEnvelope struct {
	client *Client
	data   []byte
	claims *protocol.UNTClaims
}

// Hub manages all connected clients and their channel subscriptions.
type Hub struct {
	mu            sync.RWMutex
	clients       map[string]*Client
	subscriptions map[string]map[string]bool // channel → set of client IDs
	fingerprints  map[string]string          // author fingerprint → client ID (unicast index)

	registryKeys      *registry.KeyCache
	minFreshnessScore int
	maxFrameBytes     int
	maxContentBytes   int
	maxRelayBatch     int
	seenJTIs          *jtiCache
	now               func() time.Time

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

func New(registryKeys *registry.KeyCache, cfg Config) *Hub {
	return &Hub{
		clients:           make(map[string]*Client),
		subscriptions:     make(map[string]map[string]bool),
		fingerprints:      make(map[string]string),
		registryKeys:      registryKeys,
		minFreshnessScore: cfg.MinFreshnessScore,
		maxFrameBytes:     cfg.MaxFrameBytes,
		maxContentBytes:   cfg.MaxContentBytes,
		maxRelayBatch:     cfg.MaxRelayBatch,
		seenJTIs:          newJTICache(jtiCacheCapacity),
		now:               time.Now,
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

// Key discovery happens in each connection's read pump, not in the central
// routing loop, so an unreachable registry cannot block every connected user.
func (h *Hub) verifyMessage(ctx context.Context, data []byte) (*protocol.UNTClaims, error) {
	if len(data) > h.maxFrameBytes {
		return nil, fmt.Errorf("frame too large: %d", len(data))
	}
	issuer, err := protocol.ExtractIssuer(data)
	if err != nil {
		return nil, err
	}
	key, err := h.registryKeys.Get(ctx, issuer)
	if err != nil {
		return nil, err
	}
	return protocol.VerifyUNT(data, key, issuer)
}

func (h *Hub) handleMessage(env inboundEnvelope) {
	claims := env.claims
	if claims == nil {
		return
	}

	if claims.FreshnessScore < h.minFreshnessScore {
		log.Printf("UNT freshness too low from %s: score=%d min=%d", env.client.id, claims.FreshnessScore, h.minFreshnessScore)
		return
	}

	// Stale broadcasts are dropped before identity bookkeeping or LRU access.
	// A five-minute-old frame is allowed; anything older is not tracked at all.
	if claims.Type == protocol.TypeNote || claims.Type == protocol.TypeRequestNotes || claims.Type == protocol.TypeRequestNote {
		if claims.Jti == "" || claims.Iat < h.now().Add(-5*time.Minute).Unix() {
			return
		}
	}

	// Update fingerprint → connection index from every verified frame.
	// Broadcast JTI deduplication happens below, after type-specific validation.
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
		if !h.seenJTIs.seen(claims.Jti) {
			h.fanout(env.client, claims.Channel, env.data)
		}

	case protocol.TypeRequestNotes, protocol.TypeRequestNote:
		if claims.Type == protocol.TypeRequestNote && (claims.NoteJti == "" || len(claims.NoteJti) > 256 || claims.Channel == "") {
			return
		}
		if !h.seenJTIs.seen(claims.Jti) {
			h.seenJTIs.rememberRequest(claims.Jti, env.client.id, h.now().Unix()+300)
			h.fanout(env.client, claims.Channel, env.data)
		}

	case protocol.TypeNoteRelay:
		if claims.NoteJti != "" && (len(claims.NoteJti) > 256 || claims.RequestJti == "" || claims.RelayCount != 1) {
			return
		}
		if claims.RelayCount > h.maxRelayBatch {
			log.Printf("note_relay batch too large from %s: %d (max %d)", env.client.id, claims.RelayCount, h.maxRelayBatch)
			return
		}
		if claims.RequestJti != "" {
			h.unicastRequest(h.seenJTIs.requester(claims.RequestJti, h.now().Unix()), claims.To, env.data)
		} else {
			h.unicast(claims.To, env.data)
		}

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

// A request JTI binds a history reply to its originating connection, including
// when several browser sessions share the same author fingerprint.
func (h *Hub) unicastRequest(clientID, fingerprint string, data []byte) {
	h.mu.RLock()
	target := h.clients[clientID]
	h.mu.RUnlock()
	if target == nil || target.fp != fingerprint {
		return
	}
	msg := append([]byte(nil), data...)
	select {
	case target.send <- msg:
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

	conn.SetReadLimit(int64(h.maxFrameBytes))
	id := registry.NewID()
	c := newClient(id, conn, h)
	h.register <- c

	ctx := r.Context()
	go c.writePump(ctx)
	c.readPump(ctx) // blocks until disconnect
}
