package main

import (
	"log"
	"net/http"
	"os"

	"sigil/broker/internal/hub"
	"sigil/broker/internal/registry"
)

func main() {
	port := os.Getenv("BROKER_PORT")
	if port == "" {
		port = "8080"
	}

	registryKeyURL := os.Getenv("REGISTRY_PUBLIC_KEY_URL")
	if registryKeyURL == "" {
		log.Fatal("REGISTRY_PUBLIC_KEY_URL is required")
	}

	registryKey, err := registry.FetchPublicKey(registryKeyURL)
	if err != nil {
		log.Fatalf("Failed to fetch registry public key: %v", err)
	}
	log.Println("Registry public key loaded")

	h := hub.New(registryKey)
	go h.Run()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeHTTP)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("Sigil Broker listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
