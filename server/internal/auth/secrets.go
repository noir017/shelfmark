// Package auth handles tokens, rate limiting, client IPs and Cloudflare
// Access JWTs.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
)

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// NewToken returns a new plaintext token smk_<base62 of 32 random bytes>.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	n := new(big.Int).SetBytes(b)
	var sb []byte
	base := big.NewInt(62)
	mod := new(big.Int)
	for n.Sign() > 0 {
		n.DivMod(n, base, mod)
		sb = append(sb, base62[mod.Int64()])
	}
	for len(sb) < 43 {
		sb = append(sb, '0')
	}
	return "smk_" + string(sb), nil
}

// HashSecret is the sha256 hex used for tokens.
func HashSecret(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// TokenPrefix is the first 8 characters of a plaintext token.
func TokenPrefix(tok string) string {
	if len(tok) < 8 {
		return tok
	}
	return tok[:8]
}
