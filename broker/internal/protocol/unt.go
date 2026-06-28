package protocol

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// UNTClaims are the outer JWT claims of a Unified Note Token.
type UNTClaims struct {
	Iss   string `json:"iss"`
	Sub   string `json:"sub"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
	Jti   string `json:"jti"`
	Body  string `json:"body"`
	Inner string `json:"inner"`
}

// StakeClaims are the inner JWT claims (registry-signed stake).
type StakeClaims struct {
	Iss    string `json:"iss"`
	Sub    string `json:"sub"`
	Handle string `json:"handle"`
	Iat    int64  `json:"iat"`
	Exp    int64  `json:"exp"`
}

func decodeSegment(s string) ([]byte, error) {
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	for len(s)%4 != 0 {
		s += "="
	}
	return base64.StdEncoding.DecodeString(s)
}

func parseJWTClaims(token string, out any) error {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return errors.New("malformed JWT")
	}
	payload, err := decodeSegment(parts[1])
	if err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	return json.Unmarshal(payload, out)
}

func verifyRS256(token string, key *rsa.PublicKey) error {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return errors.New("malformed JWT")
	}
	sigInput := []byte(parts[0] + "." + parts[1])
	digest := sha256.Sum256(sigInput)
	sig, err := decodeSegment(parts[2])
	if err != nil {
		return fmt.Errorf("decode sig: %w", err)
	}
	return rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig)
}

// VerifyUNT performs the 4-step broker UNT verification:
//  1. Decode outer claims (get inner stake)
//  2. Verify inner stake with registry key, check expiry
//  3. Confirm inner.sub == outer.iss
//  4. Verify outer signature with the author's public key (fetched by caller)
func VerifyUNT(unt string, registryKey *rsa.PublicKey, fetchAuthorKey func(fp string) (*rsa.PublicKey, error)) (*UNTClaims, error) {
	// Step 1: decode outer
	var outer UNTClaims
	if err := parseJWTClaims(unt, &outer); err != nil {
		return nil, fmt.Errorf("outer decode: %w", err)
	}

	// Step 2: verify + decode inner stake
	if err := verifyRS256(outer.Inner, registryKey); err != nil {
		return nil, fmt.Errorf("inner stake sig: %w", err)
	}
	var stake StakeClaims
	if err := parseJWTClaims(outer.Inner, &stake); err != nil {
		return nil, fmt.Errorf("inner decode: %w", err)
	}
	if time.Now().Unix() > stake.Exp {
		return nil, errors.New("stake expired")
	}

	// Step 3: fingerprint binding
	if stake.Sub != outer.Iss {
		return nil, errors.New("stake fingerprint mismatch")
	}

	// Step 4: verify outer with author key
	authorKey, err := fetchAuthorKey(outer.Iss)
	if err != nil {
		return nil, fmt.Errorf("fetch author key: %w", err)
	}
	if err := verifyRS256(unt, authorKey); err != nil {
		return nil, fmt.Errorf("outer sig: %w", err)
	}

	if time.Now().Unix() > outer.Exp {
		return nil, errors.New("UNT expired")
	}

	return &outer, nil
}
