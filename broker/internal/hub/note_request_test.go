package hub

import (
	"sigil/broker/internal/protocol"
	"strings"
	"testing"
	"time"
)

func TestDirectNoteRequestRoutingAndAdmission(t *testing.T) {
	now := time.Unix(1800000000, 0)
	h := New(nil, Config{MaxFrameBytes: 262144, MaxContentBytes: 4096, MaxRelayBatch: 25})
	h.now = func() time.Time { return now }
	requester := &Client{id: "requester", fp: "same-key", send: make(chan []byte, 16)}
	sibling := &Client{id: "sibling", fp: "same-key", send: make(chan []byte, 16)}
	peer := &Client{id: "peer", fp: "peer-key", send: make(chan []byte, 16)}
	h.clients[requester.id], h.clients[sibling.id], h.clients[peer.id] = requester, sibling, peer
	h.fingerprints["same-key"] = sibling.id
	h.subscribe(peer, "general")
	send := func(claims protocol.UNTClaims) {
		h.handleMessage(inboundEnvelope{client: requester, data: []byte("request"), claims: &claims})
	}
	base := protocol.UNTClaims{Type: protocol.TypeRequestNote, Jti: "lookup", Iat: now.Unix(), Channel: "general", NoteJti: "original", FreshnessScore: 5, AuthorFp: "same-key"}
	for _, target := range []string{"", strings.Repeat("x", 257)} {
		invalid := base
		invalid.NoteJti = target
		send(invalid)
	}
	stale := base
	stale.Iat = now.Add(-301 * time.Second).Unix()
	send(stale)
	if len(peer.send) != 0 {
		t.Fatal("invalid or stale request forwarded")
	}
	send(base)
	if len(peer.send) != 1 {
		t.Fatal("valid request was lost or invalid request reserved its JTI")
	}
	send(base)
	duplicate := base
	duplicate.Type = protocol.TypeRequestNotes
	send(duplicate)
	if len(peer.send) != 1 {
		t.Fatal("request escaped global JTI deduplication")
	}
	relay := protocol.UNTClaims{Type: protocol.TypeNoteRelay, RequestJti: "lookup", NoteJti: "original", RelayCount: 1, To: "same-key", FreshnessScore: 5}
	deliver := func() { h.handleMessage(inboundEnvelope{client: peer, data: []byte("original"), claims: &relay}) }
	deliver()
	if len(requester.send) != 1 || len(sibling.send) != 0 {
		t.Fatal("reply was not bound to the exact requesting session")
	}
	relay.RelayCount = 2
	deliver()
	relay.RelayCount = 1
	relay.To = "wrong-key"
	deliver()
	if len(requester.send) != 1 {
		t.Fatal("invalid targeted reply forwarded")
	}
	h.now = func() time.Time { return now.Add(301 * time.Second) }
	relay.To = "same-key"
	deliver()
	if len(requester.send) != 1 {
		t.Fatal("expired correlation still routed a reply")
	}
}
