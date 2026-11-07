package protocol

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// UNTClaims holds the verified outer payload fields from a UNT frame.
// Fields tagged `json:"-"` are computed during verification, never transmitted.
type UNTClaims struct {
	Jti        string  `json:"jti"`
	Iat        int64   `json:"iat"`
	Type       string  `json:"type"`
	Channel    string  `json:"channel"`
	Content    string  `json:"content,omitempty"`
	ReplyTo    *string `json:"reply_to,omitempty"`
	StakeIat   int64   `json:"stake_iat"`
	RequestJti string  `json:"request_jti,omitempty"`
	To         string  `json:"to,omitempty"` // note_relay: unicast target fingerprint

	FreshnessScore int    `json:"-"` // computed from outer.iat - stake.iat
	AuthorFp       string `json:"-"` // sha256:hex(SHA256(SPKI DER of stake.public_key))
	RelayCount     int    `json:"-"` // len(relays) for note_relay frames
}

// StakeClaims holds the verified inner stake payload fields (registry-signed).
//
// Omitted intentionally:
//   - jti: unused in any verification step
//   - sub (fingerprint): computable from SHA256(SPKI(public_key))
//   - exp: stake is a historical notarization, not an access token
type StakeClaims struct {
	Iss         string  `json:"iss"`
	Iat         int64   `json:"iat"`
	PublicKey   string  `json:"public_key"` // author's RSA-4096 public key PEM
	UserTag     string  `json:"user_tag"`   // @handle (local part only)
	DisplayName *string `json:"display_name"`
}

// canonicalJSONBytes returns the canonical JSON encoding of a raw JSON value.
// Object keys are sorted alphabetically at every nesting level.
// This is the deterministic signing input — identical across all implementations.
// In Go, json.Marshal sorts map keys, so round-tripping through interface{} achieves this.
func canonicalJSONBytes(raw json.RawMessage) ([]byte, error) {
	var v interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&v); err != nil {
		return nil, err
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(encoded.Bytes(), []byte("\n")), nil
}

// FingerprintFromPEM computes sha256:hex(SHA256(SPKI DER bytes)) from a public key PEM.
// The DER bytes are the raw contents of the PEM block — no export needed.
func FingerprintFromPEM(pemStr string) (string, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return "", errors.New("invalid PEM block")
	}
	digest := sha256.Sum256(block.Bytes)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
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

func verifyRSASig(key *rsa.PublicKey, payload json.RawMessage, sigB64 string) error {
	canon, err := canonicalJSONBytes(payload)
	if err != nil {
		return fmt.Errorf("canonicalize: %w", err)
	}
	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return fmt.Errorf("decode sig: %w", err)
	}
	digest := sha256.Sum256(canon)
	return rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sigBytes)
}

// parseFrame rejects malformed or extra frame elements before key discovery.
func parseFrame(raw []byte) (json.RawMessage, string, error) {
	var frame []json.RawMessage
	if err := json.Unmarshal(raw, &frame); err != nil || len(frame) != 2 {
		return nil, "", errors.New("expected a two-part signed frame")
	}
	var signature string
	if err := json.Unmarshal(frame[1], &signature); err != nil || signature == "" {
		return nil, "", errors.New("invalid frame signature")
	}
	return frame[0], signature, nil
}

// ExtractIssuer reads only a routing hint. No claim is trusted until VerifyUNT.
func ExtractIssuer(raw []byte) (string, error) {
	payload, _, err := parseFrame(raw)
	if err != nil {
		return "", err
	}
	var outer struct {
		Stake json.RawMessage `json:"stake"`
	}
	if err := json.Unmarshal(payload, &outer); err != nil {
		return "", err
	}
	stake, _, err := parseFrame(outer.Stake)
	if err != nil {
		return "", err
	}
	var claims struct {
		Iss string `json:"iss"`
	}
	if err := json.Unmarshal(stake, &claims); err != nil || claims.Iss == "" {
		return "", errors.New("missing registry issuer")
	}
	return claims.Iss, nil
}

// VerifyUNT performs 4-step UNT verification using only the registry public key.
// The author's public key is embedded in the stake — no network calls required.
//
//  1. Parse frame as [outer_payload, outer_sig_b64]
//  2. Verify stake signature with registry key → trusted stake claims + author public key
//  3. Verify outer signature with author key (from verified stake)
//  4. Verify stake_iat binding (prevents stake-swap attacks)
//
// Returns verified claims with a computed FreshnessScore.
// The caller is responsible for jti deduplication and freshness gating.
func VerifyUNT(frameBytes []byte, registryKey *rsa.PublicKey, expectedIssuer string) (*UNTClaims, error) {
	// Step 1: parse frame as [outer_payload, outer_sig_b64]
	outerRaw, outerSig, err := parseFrame(frameBytes)
	if err != nil {
		return nil, err
	}

	// Extract stake field (unverified) from outer payload
	var outerMap map[string]json.RawMessage
	if err := json.Unmarshal(outerRaw, &outerMap); err != nil {
		return nil, fmt.Errorf("parse outer payload: %w", err)
	}
	stakeRaw, ok := outerMap["stake"]
	if !ok {
		return nil, errors.New("missing stake field")
	}

	// Parse stake as [stake_payload, stake_sig_b64]
	stakePayloadRaw, stakeSig, err := parseFrame(stakeRaw)
	if err != nil {
		return nil, err
	}

	// Step 2: verify stake signature with registry key
	if err := verifyRSASig(registryKey, stakePayloadRaw, stakeSig); err != nil {
		return nil, fmt.Errorf("stake sig: %w", err)
	}
	var stake StakeClaims
	if err := json.Unmarshal(stakePayloadRaw, &stake); err != nil {
		return nil, fmt.Errorf("decode stake: %w", err)
	}

	if expectedIssuer == "" || !strings.EqualFold(stake.Iss, expectedIssuer) {
		return nil, errors.New("registry issuer does not match selected verification key")
	}

	// Step 3: verify outer signature with author's public key (embedded in verified stake)
	authorKey, err := parsePEMPublicKey(stake.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("parse author key: %w", err)
	}
	if err := verifyRSASig(authorKey, outerRaw, outerSig); err != nil {
		return nil, fmt.Errorf("outer sig: %w", err)
	}

	// Step 4: decode outer claims and verify stake_iat binding
	var outer UNTClaims
	if err := json.Unmarshal(outerRaw, &outer); err != nil {
		return nil, fmt.Errorf("decode outer claims: %w", err)
	}
	if outer.StakeIat != stake.Iat {
		return nil, errors.New("stake_iat mismatch")
	}

	outer.FreshnessScore = computeFreshnessScore(outer.Iat - stake.Iat)

	// Compute author fingerprint from verified stake public key.
	fp, err := FingerprintFromPEM(stake.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("fingerprint: %w", err)
	}
	outer.AuthorFp = fp

	// For note_relay: count relays entries for the hub's batch size check.
	if outer.Type == "note_relay" {
		if relaysRaw, ok := outerMap["relays"]; ok {
			var relays []json.RawMessage
			if err := json.Unmarshal(relaysRaw, &relays); err == nil {
				outer.RelayCount = len(relays)
			}
		}
	}

	return &outer, nil
}

func computeFreshnessScore(deltaT int64) int {
	switch {
	case deltaT < 5:
		return 5
	case deltaT < 30:
		return 4
	case deltaT < 180:
		return 3
	case deltaT < 1800:
		return 2
	case deltaT < 86400:
		return 1
	default:
		return 0
	}
}
