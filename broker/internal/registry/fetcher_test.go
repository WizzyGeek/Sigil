package registry

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIssuerAndNetworkValidation(t *testing.T) {
	for _, issuer := range []string{"", "https://registry.test", "registry.test/path", "user@registry.test", "registry.test#fragment", "registry.test:99999", "registry.test:0", "registry.test:", "registry.test?x=y"} {
		if _, err := CanonicalIssuer(issuer); err == nil {
			t.Errorf("accepted issuer %q", issuer)
		}
	}
	if got, err := CanonicalIssuer("REGISTRY.TEST:8443"); err != nil || got != "registry.test:8443" {
		t.Fatalf("canonical: %s %v", got, err)
	}
	for _, ip := range []string{"127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "fd00::1", "0.0.0.1", "198.18.0.1", "203.0.113.1"} {
		if publicIP(net.ParseIP(ip)) {
			t.Errorf("accepted private address %s", ip)
		}
	}
	f, _ := NewKeyFetcher(nil)
	if _, err := f.Fetch(context.Background(), "127.0.0.1"); err == nil {
		t.Fatal("dynamically discovered loopback issuer was fetched")
	}
}

func TestConfiguredEndpointsStillRequireValidTLSAndRejectRedirects(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"public_key": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))})
	})
	tlsServer := httptest.NewTLSServer(handler)
	defer tlsServer.Close()
	f, err := NewKeyFetcher(map[string]string{"registry.test": tlsServer.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Fetch(context.Background(), "registry.test"); err == nil {
		t.Fatal("accepted an untrusted TLS certificate")
	}
	f.configuredClient = tlsServer.Client()
	if fetched, err := f.Fetch(context.Background(), "registry.test"); err != nil || fetched.N.Cmp(key.N) != 0 {
		t.Fatalf("valid TLS lookup: %v", err)
	}
	redirects := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1/private", http.StatusFound)
	}))
	defer redirects.Close()
	f, _ = NewKeyFetcher(map[string]string{"registry.test": redirects.URL})
	if _, err := f.Fetch(context.Background(), "registry.test"); err == nil {
		t.Fatal("followed a registry key redirect")
	}
}

func TestOversizedKeyResponseRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(strings.Repeat("x", 65537))) }))
	defer server.Close()
	f, _ := NewKeyFetcher(map[string]string{"registry.test": server.URL})
	if _, err := f.Fetch(context.Background(), "registry.test"); err == nil || !strings.Contains(err.Error(), "64 KiB") {
		t.Fatalf("oversized response: %v", err)
	}
}
