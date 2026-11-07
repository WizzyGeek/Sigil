package registry

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func snapshot(c *KeyCache, issuer string) *cacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.entries[issuer]; e != nil {
		copy := *e
		return &copy
	}
	return nil
}

func TestRetryExpiryBackoffAndRecovery(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	calls := 0
	reachable := false
	key := &rsa.PublicKey{}
	c := NewKeyCache(func(context.Context, string) (*rsa.PublicKey, error) {
		calls++
		if !reachable {
			return nil, errors.New("offline")
		}
		return key, nil
	}, DefaultKeyTTL, DefaultCapacity)
	c.now = func() time.Time { return now }
	get := func(wantError bool) {
		t.Helper()
		got, err := c.Get(context.Background(), "REGISTRY.TEST")
		if (err != nil) != wantError {
			t.Fatalf("key=%v error=%v", got, err)
		}
		if wantError && got != nil {
			t.Fatal("served an unavailable/expired key")
		}
	}
	get(true)
	if e := snapshot(c, "registry.test"); e.ttr != 55*time.Second || !e.expires.Equal(now.Add(55*time.Second)) {
		t.Fatalf("initial retry: %+v", e)
	}
	now = now.Add(55*time.Second - time.Nanosecond)
	get(true)
	if calls != 1 {
		t.Fatal("retried before expiry")
	}
	now = now.Add(time.Nanosecond)
	get(true)
	if e := snapshot(c, "registry.test"); e.ttr != 82500*time.Millisecond {
		t.Fatalf("second retry %s", e.ttr)
	}
	now = snapshot(c, "registry.test").expires
	get(true)
	if e := snapshot(c, "registry.test"); e.ttr != 123750*time.Millisecond {
		t.Fatalf("third retry %s", e.ttr)
	}
	reachable = true
	now = snapshot(c, "registry.test").expires
	get(false)
	if e := snapshot(c, "registry.test"); e.ttr != DefaultKeyTTL || e.key != key || e.err != nil {
		t.Fatalf("recovery: %+v", e)
	}
	get(false)
	if calls != 4 {
		t.Fatalf("positive cache missed: %d fetches", calls)
	}
	reachable = false
	now = snapshot(c, "registry.test").expires
	get(true)
	if e := snapshot(c, "registry.test"); e.ttr != DefaultKeyTTL*3/2 || e.key != nil {
		t.Fatalf("expired successful lookup: %+v", e)
	}
}

func TestCapacityEvictsOnlyEarlierExpiringRecord(t *testing.T) {
	now := time.Now()
	c := NewKeyCache(func(context.Context, string) (*rsa.PublicKey, error) { return nil, errors.New("unused") }, DefaultKeyTTL, DefaultCapacity)
	for i := 0; i < DefaultCapacity; i++ {
		c.insert(&cacheEntry{issuer: fmt.Sprintf("registry-%d.test", i), expires: now.Add(time.Duration(i+1) * time.Second)})
	}
	c.insert(&cacheEntry{issuer: "new.test", expires: now.Add(55 * time.Second)})
	if c.entries["registry-0.test"] != nil || c.entries["new.test"] == nil {
		t.Fatal("did not evict earliest expiry")
	}
	c.insert(&cacheEntry{issuer: "too-soon.test", expires: now.Add(time.Second)})
	c.insert(&cacheEntry{issuer: "same-expiry.test", expires: now.Add(2 * time.Second)})
	if c.entries["too-soon.test"] != nil || c.entries["same-expiry.test"] != nil {
		t.Fatal("admitted record without an earlier-expiring victim")
	}
	c.insert(&cacheEntry{issuer: "new.test", expires: now.Add(time.Hour)})
	if len(c.entries) != DefaultCapacity || len(c.expiry) != DefaultCapacity {
		t.Fatal("cache exceeded 10k entries or retained duplicate heap records")
	}
	for i, e := range c.expiry {
		if e.index != i {
			t.Fatal("invalid heap index")
		}
	}
}

func TestConcurrentLookupsShareOneFetch(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	key := &rsa.PublicKey{}
	c := NewKeyCache(func(context.Context, string) (*rsa.PublicKey, error) { calls.Add(1); <-release; return key, nil }, DefaultKeyTTL, 10)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := c.Get(context.Background(), "registry.test")
			if err != nil || got != key {
				t.Errorf("lookup: %v", err)
			}
		}()
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("fetched %d times", calls.Load())
	}
}

func TestUnreachableIssuerDoesNotBlockOthersAndCancellationDoesNotPoisonCache(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	key := &rsa.PublicKey{}
	c := NewKeyCache(func(_ context.Context, issuer string) (*rsa.PublicKey, error) {
		if issuer == "slow.test" {
			close(started)
			<-release
		}
		return key, nil
	}, DefaultKeyTTL, 10)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.Get(ctx, "slow.test"); done <- err }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	fastCtx, fastCancel := context.WithTimeout(context.Background(), time.Second)
	defer fastCancel()
	if _, err := c.Get(fastCtx, "fast.test"); err != nil {
		t.Fatalf("slow registry blocked fast one: %v", err)
	}
	close(release)
	if got, err := c.Get(context.Background(), "slow.test"); err != nil || got != key {
		t.Fatalf("cancelled sender poisoned shared lookup: %v", err)
	}
}

func TestBackoffSaturatesInsteadOfOverflowing(t *testing.T) {
	now := time.Now()
	c := NewKeyCache(func(context.Context, string) (*rsa.PublicKey, error) { return nil, errors.New("offline") }, DefaultKeyTTL, 10)
	c.now = func() time.Time { return now }
	c.insert(&cacheEntry{issuer: "registry.test", ttr: time.Duration(1<<63 - 2), expires: now})
	_, _ = c.Get(context.Background(), "registry.test")
	if got := snapshot(c, "registry.test").ttr; got != time.Duration(1<<63-1) {
		t.Fatalf("overflowed backoff: %s", got)
	}
}
