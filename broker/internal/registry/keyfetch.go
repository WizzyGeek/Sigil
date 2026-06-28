package registry

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// NewID generates a random hex connection ID.
func NewID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// FetchPublicKey fetches and parses the registry's RSA public key from its /registry/public-key endpoint.
func FetchPublicKey(url string) (*rsa.PublicKey, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("fetch registry key: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("registry key endpoint returned %d", resp.StatusCode)
	}

	var body struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode registry key response: %w", err)
	}

	return parsePEMPublicKey(body.PublicKey)
}

func parsePEMPublicKey(pemStr string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("failed to decode PEM block")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse public key: %w", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("not an RSA public key")
	}
	return rsaPub, nil
}

// ParseAuthorKeyFromPEM parses a PEM public key string from the registry key lookup response.
func ParseAuthorKeyFromPEM(pemStr string) (*rsa.PublicKey, error) {
	return parsePEMPublicKey(pemStr)
}
