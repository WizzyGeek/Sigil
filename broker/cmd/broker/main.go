package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"sigil/broker/internal/hub"
	"sigil/broker/internal/registry"
)

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		log.Fatalf("%s must be a non-negative integer, got %q", key, v)
	}
	return n
}

func main() {
	port := os.Getenv("BROKER_PORT")
	if port == "" {
		port = "8080"
	}

	overrides := make(map[string]string)
	// Retain the old setting as an optional explicit mapping, not a startup dependency.
	if endpoint := os.Getenv("REGISTRY_PUBLIC_KEY_URL"); endpoint != "" {
		u, err := url.Parse(endpoint)
		if err != nil {
			log.Fatalf("Invalid REGISTRY_PUBLIC_KEY_URL: %v", err)
		}
		overrides[u.Host] = endpoint
	}
	if raw := os.Getenv("REGISTRY_KEY_URLS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &overrides); err != nil {
			log.Fatalf("Invalid REGISTRY_KEY_URLS: %v", err)
		}
	}
	fetcher, err := registry.NewKeyFetcher(overrides)
	if err != nil {
		log.Fatal(err)
	}
	keyTTL := envInt("REGISTRY_KEY_TTL_SECONDS", 300)
	if keyTTL == 0 || uint64(keyTTL) > uint64((1<<63-1)/int64(time.Second)) {
		log.Fatal("REGISTRY_KEY_TTL_SECONDS must be a positive representable duration")
	}
	registryKeys := registry.NewKeyCache(fetcher.Fetch, time.Duration(keyTTL)*time.Second, registry.DefaultCapacity)

	minFreshness := envInt("MIN_FRESHNESS_SCORE", 1)
	if minFreshness > 5 {
		log.Fatalf("MIN_FRESHNESS_SCORE must be 0–5, got %d", minFreshness)
	}

	cfg := hub.Config{
		MinFreshnessScore: minFreshness,
		MaxFrameBytes:     envInt("MAX_FRAME_BYTES", 262144),
		MaxContentBytes:   envInt("MAX_CONTENT_BYTES", 4096),
		MaxRelayBatch:     envInt("MAX_RELAY_BATCH", 25),
	}

	h := hub.New(registryKeys, cfg)
	go h.Run()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeHTTP)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("Sigil Broker listening on :%s (min_freshness=%d max_frame=%d max_content=%d max_relay_batch=%d)",
		port, cfg.MinFreshnessScore, cfg.MaxFrameBytes, cfg.MaxContentBytes, cfg.MaxRelayBatch)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
