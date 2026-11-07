package hub

import (
	"container/list"
	"crypto/sha256"
)

const jtiCacheCapacity = 100000

// jtiCache is owned by the hub's routing goroutine. The map and recency list
// provide O(1) observation and LRU eviction. Fixed-size hashes avoid retaining
// attacker-controlled, arbitrarily long JTIs.
type jtiRecord struct {
	key       [sha256.Size]byte
	requester string
	expires   int64
}

type jtiCache struct {
	capacity int
	entries  map[[sha256.Size]byte]*list.Element
	order    list.List // Least recently observed at the front, most recent at the back.
}

func newJTICache(capacity int) *jtiCache {
	if capacity <= 0 {
		panic("JTI cache capacity must be positive")
	}
	return &jtiCache{capacity: capacity, entries: make(map[[sha256.Size]byte]*list.Element)}
}

// seen records a verified JTI globally and reports whether it was already seen.
// Duplicates refresh recency but are never forwarded while cached.
func (c *jtiCache) seen(jti string) bool {
	key := sha256.Sum256([]byte(jti))
	if entry := c.entries[key]; entry != nil {
		c.order.MoveToBack(entry)
		return true
	}
	if len(c.entries) >= c.capacity {
		oldest := c.order.Front()
		delete(c.entries, oldest.Value.(*jtiRecord).key)
		c.order.Remove(oldest)
	}
	c.entries[key] = c.order.PushBack(&jtiRecord{key: key})
	return false
}

// Correlation metadata shares the broadcast cache's 100,000-entry bound.
func (c *jtiCache) rememberRequest(jti, clientID string, expires int64) {
	if entry := c.entries[sha256.Sum256([]byte(jti))]; entry != nil {
		record := entry.Value.(*jtiRecord)
		record.requester, record.expires = clientID, expires
	}
}

func (c *jtiCache) requester(jti string, now int64) string {
	if entry := c.entries[sha256.Sum256([]byte(jti))]; entry != nil {
		record := entry.Value.(*jtiRecord)
		if record.expires > now {
			return record.requester
		}
	}
	return ""
}
