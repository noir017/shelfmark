// Package auth handles passwords, sessions, tokens, rate limiting, client IPs
// and Cloudflare Access JWTs.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2Params are the argon2id parameters for new hashes (tests lower them).
var Argon2Params = struct {
	Memory  uint32
	Time    uint32
	Threads uint8
}{Memory: 64 * 1024, Time: 1, Threads: 2}

const MinPasswordLength = 8

// HashPassword returns an encoded argon2id hash.
func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	p := Argon2Params
	key := argon2.IDKey([]byte(pw), salt, p.Time, p.Memory, p.Threads, 32)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.Memory, p.Time, p.Threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks pw against an encoded hash.
func VerifyPassword(encoded, pw string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash is verified against when the user does not exist, to keep timing similar.
var dummyHash, _ = HashPassword("dummy password for timing")

// VerifyOrDummy runs a verification even when there is no hash.
func VerifyOrDummy(encoded, pw string) bool {
	if encoded == "" {
		VerifyPassword(dummyHash, pw)
		return false
	}
	return VerifyPassword(encoded, pw)
}

var ErrWeakPassword = errors.New("密码至少 8 位")

func CheckPassword(pw string) error {
	if len([]rune(pw)) < MinPasswordLength {
		return ErrWeakPassword
	}
	return nil
}

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

// HashSecret is the sha256 hex used for tokens and session ids.
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

// NewSessionID returns a random 32-byte base64url session secret.
func NewSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
