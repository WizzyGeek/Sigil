package main

import (
	"log"
	"net/http"
	"os"
	"strconv"

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

	registryKeyURL := os.Getenv("REGISTRY_PUBLIC_KEY_URL")
	if registryKeyURL == "" {
		log.Fatal("REGISTRY_PUBLIC_KEY_URL is required")
	}

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

	registryKey, err := registry.FetchPublicKey(registryKeyURL)
	if err != nil {
		log.Fatalf("Failed to fetch registry public key: %v", err)
	}
	log.Println("Registry public key loaded")

	h := hub.New(registryKey, cfg)
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
