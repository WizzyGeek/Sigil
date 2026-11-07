package hub

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"testing"
	"time"

	"sigil/broker/internal/registry"
)

func signTestFrame(t *testing.T, payload map[string]interface{}, key *rsa.PrivateKey) []interface{} {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return []interface{}{payload, base64.StdEncoding.EncodeToString(sig)}
}

func TestIssuerSpecificVerificationDropsInvalidFrames(t *testing.T) {
	a, _ := rsa.GenerateKey(rand.Reader, 2048)
	b, _ := rsa.GenerateKey(rand.Reader, 2048)
	author, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKIXPublicKey(&author.PublicKey)
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	fetches := map[string]int{}
	keys := registry.NewKeyCache(func(_ context.Context, issuer string) (*rsa.PublicKey, error) {
		fetches[issuer]++
		switch issuer {
		case "a.test":
			return &a.PublicKey, nil
		case "b.test":
			return &b.PublicKey, nil
		default:
			return nil, errors.New("offline")
		}
	}, time.Minute, 10000)
	h := New(keys, Config{MinFreshnessScore: 1, MaxFrameBytes: 262144, MaxContentBytes: 4096, MaxRelayBatch: 25})
	sender := &Client{id: "sender", send: make(chan []byte, 10)}
	recipient := &Client{id: "recipient", send: make(chan []byte, 10)}
	h.clients[sender.id] = sender
	h.clients[recipient.id] = recipient
	h.subscribe(recipient, "general")
	now := time.Now().Unix()
	makeFrame := func(issuer string, signer *rsa.PrivateKey, badOuter bool) []byte {
		stake := signTestFrame(t, map[string]interface{}{"iss": issuer, "iat": now, "public_key": pemKey, "user_tag": "@alice"}, signer)
		outer := map[string]interface{}{"jti": issuer, "type": "note", "iat": now, "stake_iat": now, "stake": stake, "channel": "general", "content": "hello"}
		signingKey := author
		if badOuter {
			signingKey = b
		}
		raw, _ := json.Marshal(signTestFrame(t, outer, signingKey))
		return raw
	}
	process := func(raw []byte, valid bool) {
		t.Helper()
		claims, err := h.verifyMessage(context.Background(), raw)
		if (err == nil) != valid {
			t.Fatalf("verification valid=%t: %v", valid, err)
		}
		if err == nil {
			h.handleMessage(inboundEnvelope{client: sender, data: raw, claims: claims})
		}
		if valid {
			select {
			case <-recipient.send:
			default:
				t.Fatal("valid note was not routed")
			}
		} else {
			select {
			case <-recipient.send:
				t.Fatal("invalid UNT was routed")
			default:
			}
		}
	}
	// Invalid signatures must not reserve the JTI before a valid frame arrives.
	process(makeFrame("a.test", b, false), false)
	process(makeFrame("a.test", a, false), true)
	process(makeFrame("b.test", b, false), true)
	process(makeFrame("a.test", b, false), false)
	process(makeFrame("b.test", a, false), false)
	process(makeFrame("a.test", a, true), false)
	process(makeFrame("unknown.test", a, false), false)
	process(makeFrame("unknown.test", a, false), false)
	process([]byte(`[{"stake":[]},"sig"]`), false)
	if fetches["a.test"] != 1 || fetches["b.test"] != 1 || fetches["unknown.test"] != 1 {
		t.Fatalf("unexpected fetches: %v", fetches)
	}
}
