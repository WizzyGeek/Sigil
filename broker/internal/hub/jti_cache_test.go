package hub

import (
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"sigil/broker/internal/protocol"
)

func TestJTICacheEvictsLeastRecentlySeenAndDuplicatesRefreshRecency(t *testing.T) {
	c := newJTICache(2)
	if c.seen("first") || c.seen("second") {
		t.Fatal("first observation was a duplicate")
	}
	if !c.seen("first") {
		t.Fatal("duplicate was not detected")
	}
	c.seen("third")
	if c.entries[sha256.Sum256([]byte("second"))] != nil {
		t.Fatal("least recently observed JTI was not evicted")
	}
	if !c.seen("first") || !c.seen("third") {
		t.Fatal("recent JTI was evicted")
	}
	if len(c.entries) != 2 || c.order.Len() != 2 {
		t.Fatal("duplicate observations leaked list entries")
	}
}

func TestJTICacheGlobalAndSingleEntryAdmission(t *testing.T) {
	c := newJTICache(1)
	if c.seen("same-jti") || !c.seen("same-jti") {
		t.Fatal("global duplicate detection failed")
	}
	if c.seen("replacement") || len(c.entries) != 1 || c.order.Len() != 1 {
		t.Fatal("full single-entry cache failed to admit a new JTI")
	}
	if c.seen("same-jti") {
		t.Fatal("evicted JTI was still present")
	}
}

func TestJTICacheSaturationCannotEnableTwoJTIAlternation(t *testing.T) {
	c := newJTICache(jtiCacheCapacity)
	for i := 0; i < jtiCacheCapacity; i++ {
		c.seen(fmt.Sprint(i))
	}
	// Previously hot entries have no frequency advantage under LRU.
	for i := 0; i < 10; i++ {
		c.seen("0")
	}
	if c.seen("recent-a") || c.seen("recent-b") {
		t.Fatal("new JTIs were duplicates")
	}
	for i := 0; i < 1000; i++ {
		if !c.seen("recent-a") || !c.seen("recent-b") {
			t.Fatal("two alternating JTIs escaped deduplication after saturation")
		}
	}
	if len(c.entries) != 100000 || c.order.Len() != 100000 {
		t.Fatal("cache exceeded 100,000 entries")
	}
}

func TestJTICacheRecentEntryNeeds100000OtherJTIsBeforeEviction(t *testing.T) {
	c := newJTICache(jtiCacheCapacity)
	for i := 0; i < jtiCacheCapacity; i++ {
		c.seen(fmt.Sprintf("old-%d", i))
	}
	c.seen("target")
	for i := 0; i < jtiCacheCapacity-1; i++ {
		c.seen(fmt.Sprintf("new-%d", i))
	}
	key := sha256.Sum256([]byte("target"))
	if c.entries[key] == nil {
		t.Fatal("recent JTI was evicted before 100,000 distinct other observations")
	}
	c.seen("last-new")
	if c.entries[key] != nil {
		t.Fatal("oldest JTI not evicted after 100,000 other observations")
	}
	if len(c.entries) != 100000 || c.order.Len() != 100000 {
		t.Fatal("cache or list size exceeded capacity")
	}
}

func TestOnlyRecentNoteAndRequestNotesAreDeduplicated(t *testing.T) {
	now := time.Unix(1800000000, 0)
	h := New(nil, Config{MinFreshnessScore: 1, MaxFrameBytes: 262144, MaxContentBytes: 4096, MaxRelayBatch: 25})
	h.now = func() time.Time { return now }
	sender := &Client{id: "sender", send: make(chan []byte, 10)}
	other := &Client{id: "other", send: make(chan []byte, 10)}
	recipient := &Client{id: "recipient", send: make(chan []byte, 10)}
	h.clients[sender.id], h.clients[other.id], h.clients[recipient.id] = sender, other, recipient
	h.subscribe(recipient, "general")
	deliver := func(sender *Client, kind, jti string, iat int64, body string) {
		t.Helper()
		h.handleMessage(inboundEnvelope{client: sender, data: []byte(body), claims: &protocol.UNTClaims{Type: kind, Jti: jti, Iat: iat, Channel: "general", FreshnessScore: 5, AuthorFp: sender.id, Content: body}})
	}
	expect := func(want string) {
		t.Helper()
		select {
		case data := <-recipient.send:
			if string(data) != want {
				t.Fatalf("got %q want %q", data, want)
			}
		default:
			t.Fatalf("missing message %q", want)
		}
	}
	empty := func() {
		t.Helper()
		select {
		case data := <-recipient.send:
			t.Fatalf("unexpected fanout %q", data)
		default:
		}
	}

	deliver(sender, "note", "note-jti", now.Unix(), "first note")
	expect("first note")
	deliver(sender, "note", "note-jti", now.Unix(), "duplicate")
	deliver(other, "request_notes", "note-jti", now.Unix(), "same JTI, different author and type")
	empty()
	deliver(sender, "request_notes", "request-jti", now.Unix(), "first request")
	expect("first request")
	deliver(other, "request_notes", "request-jti", now.Unix(), "duplicate request")
	empty()

	// Repeated stale broadcasts neither insert nor refresh recency.
	before := len(h.seenJTIs.entries)
	oldest, newest := h.seenJTIs.order.Front(), h.seenJTIs.order.Back()
	for _, kind := range []string{"note", "request_notes"} {
		deliver(sender, kind, "old-jti", now.Unix()-301, "old")
		deliver(sender, kind, "note-jti", now.Unix()-301, "old duplicate")
	}
	empty()
	if len(h.seenJTIs.entries) != before || h.seenJTIs.order.Front() != oldest || h.seenJTIs.order.Back() != newest {
		t.Fatal("old frames touched the JTI cache")
	}
	deliver(sender, "note", "boundary", now.Unix()-300, "exactly five minutes")
	expect("exactly five minutes")
	deliver(sender, "note", "", now.Unix(), "missing JTI")
	empty()

	// Content rejected before fanout cannot reserve a JTI.
	h.maxContentBytes = 3
	deliver(sender, "note", "too-large", now.Unix(), "oversized")
	if h.seenJTIs.entries[sha256.Sum256([]byte("too-large"))] != nil {
		t.Fatal("invalid content poisoned the cache")
	}
	empty()
	h.maxContentBytes = 4096

	// Subscription commands may legitimately repeat and never enter this cache.
	before = len(h.seenJTIs.entries)
	deliver(sender, "subscribe", "subscription", now.Unix()-1000, "")
	deliver(sender, "unsubscribe", "subscription", now.Unix()-1000, "")
	deliver(sender, "subscribe", "subscription", now.Unix()-1000, "")
	if !h.subscriptions["general"][sender.id] || len(h.seenJTIs.entries) != before {
		t.Fatal("control commands were deduplicated")
	}
}

func TestHistoryRepliesUseRequestConnectionWhenIdentityIsShared(t *testing.T) {
	now := time.Unix(1800000000, 0)
	h := New(nil, Config{MinFreshnessScore: 1, MaxFrameBytes: 262144, MaxContentBytes: 4096, MaxRelayBatch: 25})
	h.now = func() time.Time { return now }
	first := &Client{id: "first", fp: "sha256:shared", send: make(chan []byte, 10)}
	second := &Client{id: "second", fp: "sha256:shared", send: make(chan []byte, 10)}
	peer := &Client{id: "peer", fp: "sha256:peer", send: make(chan []byte, 10)}
	h.clients[first.id], h.clients[second.id], h.clients[peer.id] = first, second, peer
	h.fingerprints["sha256:shared"] = second.id
	request := &protocol.UNTClaims{Type: "request_notes", Jti: "history-request", Iat: now.Unix(), Channel: "general", FreshnessScore: 5, AuthorFp: first.fp}
	h.handleMessage(inboundEnvelope{client: first, data: []byte("request"), claims: request})
	reply := &protocol.UNTClaims{Type: "note_relay", RequestJti: "history-request", To: first.fp, FreshnessScore: 5, AuthorFp: peer.fp}
	h.handleMessage(inboundEnvelope{client: peer, data: []byte("response"), claims: reply})
	select {
	case data := <-first.send:
		if string(data) != "response" {
			t.Fatal("wrong response")
		}
	default:
		t.Fatal("reply did not reach original request connection")
	}
	select {
	case <-second.send:
		t.Fatal("reply was routed to another session sharing the key")
	default:
	}
	now = now.Add(301 * time.Second)
	h.handleMessage(inboundEnvelope{client: peer, data: []byte("expired"), claims: reply})
	select {
	case <-first.send:
		t.Fatal("expired request route was used")
	default:
	}
}
