package registry

import (
	"container/heap"
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"sync"
	"time"
)

const InitialRetry = 55 * time.Second
const DefaultKeyTTL = 5 * time.Minute
const DefaultCapacity = 10000

type FetchKey func(context.Context, string) (*rsa.PublicKey, error)

type cacheEntry struct {
	issuer  string
	key     *rsa.PublicKey
	err     error
	expires time.Time
	ttr     time.Duration
	index   int
}

type expiryHeap []*cacheEntry

func (h expiryHeap) Len() int           { return len(h) }
func (h expiryHeap) Less(i, j int) bool { return h[i].expires.Before(h[j].expires) }
func (h expiryHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i]; h[i].index = i; h[j].index = j }
func (h *expiryHeap) Push(value interface{}) {
	e := value.(*cacheEntry)
	e.index = len(*h)
	*h = append(*h, e)
}
func (h *expiryHeap) Pop() interface{} {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	e.index = -1
	return e
}

type pendingFetch struct {
	done chan struct{}
	key  *rsa.PublicKey
	err  error
}

// KeyCache retains expired entries as retry history, but never serves expired keys.
// A min-heap makes the bounded cache's earliest-expiry eviction O(log n).
type KeyCache struct {
	mu       sync.Mutex
	entries  map[string]*cacheEntry
	expiry   expiryHeap
	pending  map[string]*pendingFetch
	fetch    FetchKey
	keyTTL   time.Duration
	capacity int
	now      func() time.Time
}

func NewKeyCache(fetch FetchKey, keyTTL time.Duration, capacity int) *KeyCache {
	if fetch == nil || keyTTL <= 0 || capacity <= 0 {
		panic("invalid registry cache configuration")
	}
	return &KeyCache{entries: make(map[string]*cacheEntry), pending: make(map[string]*pendingFetch), fetch: fetch, keyTTL: keyTTL, capacity: capacity, now: time.Now}
}

func (c *KeyCache) Get(ctx context.Context, issuer string) (*rsa.PublicKey, error) {
	issuer, err := CanonicalIssuer(issuer)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	previous := c.entries[issuer]
	if previous != nil && c.now().Before(previous.expires) {
		key, err := previous.key, previous.err
		c.mu.Unlock()
		return key, err
	}
	pending := c.pending[issuer]
	if pending == nil {
		if len(c.pending) >= c.capacity {
			c.mu.Unlock()
			return nil, errors.New("too many registry key fetches in progress")
		}
		pending = &pendingFetch{done: make(chan struct{})}
		c.pending[issuer] = pending
		// Share one bounded fetch per issuer. A disconnected sender must not cancel
		// another sender's lookup or put a reachable registry into negative cache.
		go c.refresh(issuer, previous, pending)
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-pending.done:
		return pending.key, pending.err
	}
}

func (c *KeyCache) refresh(issuer string, previous *cacheEntry, pending *pendingFetch) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	key, err := c.fetch(ctx, issuer)
	if key == nil && err == nil {
		err = errors.New("registry returned no public key")
	}
	ttr := c.keyTTL
	if err != nil {
		key = nil
		ttr = InitialRetry
		if previous != nil {
			// Multiply by 1.5 without overflowing into an immediate/negative retry.
			const maxDuration = time.Duration(1<<63 - 1)
			ttr = maxDuration
			if previous.ttr <= maxDuration-previous.ttr/2 {
				ttr = previous.ttr + previous.ttr/2
			}
		}
		err = fmt.Errorf("registry %s unavailable (retry in %s): %w", issuer, ttr, err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := &cacheEntry{issuer: issuer, key: key, err: err, ttr: ttr, expires: c.now().Add(ttr)}
	c.insert(entry)
	pending.key, pending.err = key, err
	delete(c.pending, issuer)
	close(pending.done)
}

func (c *KeyCache) insert(entry *cacheEntry) {
	if old := c.entries[entry.issuer]; old != nil {
		heap.Remove(&c.expiry, old.index)
		delete(c.entries, old.issuer)
	} else if len(c.entries) >= c.capacity {
		earliest := c.expiry[0]
		// Admit only when an existing record expires strictly before the new one.
		if !earliest.expires.Before(entry.expires) {
			return
		}
		heap.Pop(&c.expiry)
		delete(c.entries, earliest.issuer)
	}
	c.entries[entry.issuer] = entry
	heap.Push(&c.expiry, entry)
}
