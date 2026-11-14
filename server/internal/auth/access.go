package auth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AccessVerifier validates Cloudflare Access JWTs (RS256) against the team's
// published keys.
type AccessVerifier struct {
	Issuer   string // https://<team domain>
	CertsURL string // https://<team domain>/cdn-cgi/access/certs
	AUD      []string
	Client   *http.Client
	Now      func() time.Time

	// RefreshEvery is how long fetched keys are trusted (1h).
	RefreshEvery time.Duration
	// MinForcedRefresh throttles refreshes triggered by unknown kids.
	MinForcedRefresh time.Duration
	Leeway           time.Duration

	mu         sync.Mutex
	keys       map[string]*rsa.PublicKey
	fetchedAt  time.Time
	lastForced time.Time
}

// NewAccessVerifier builds a verifier for a team domain like example.cloudflareaccess.com.
func NewAccessVerifier(teamDomain string, aud []string) *AccessVerifier {
	return &AccessVerifier{
		Issuer:           "https://" + teamDomain,
		CertsURL:         "https://" + teamDomain + "/cdn-cgi/access/certs",
		AUD:              aud,
		Client:           &http.Client{Timeout: 10 * time.Second},
		Now:              time.Now,
		RefreshEvery:     time.Hour,
		MinForcedRefresh: 10 * time.Second,
		Leeway:           60 * time.Second,
	}
}

// AccessClaims are the claims shelfmark uses.
type AccessClaims struct {
	Email      string
	Subject    string
	CommonName string
	Audience   []string
	Issuer     string
	Expires    time.Time
}

var (
	ErrAccessMissing = errors.New("缺少 Cloudflare Access 凭据")
	ErrAccessInvalid = errors.New("Cloudflare Access 凭据无效")
)

// TokenFromRequest returns the Access JWT from the header or the CF_Authorization cookie.
func TokenFromRequest(r *http.Request) string {
	if h := strings.TrimSpace(r.Header.Get("Cf-Access-Jwt-Assertion")); h != "" {
		return h
	}
	if c, err := r.Cookie("CF_Authorization"); err == nil {
		return c.Value
	}
	return ""
}

type jwtHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*a = []string{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

type jwtClaims struct {
	Aud        audience `json:"aud"`
	Iss        string   `json:"iss"`
	Exp        *float64 `json:"exp"`
	Nbf        *float64 `json:"nbf"`
	Email      string   `json:"email"`
	Sub        string   `json:"sub"`
	CommonName string   `json:"common_name"`
}

// Verify checks signature, issuer, audience and validity window.
func (v *AccessVerifier) Verify(ctx context.Context, token string) (*AccessClaims, error) {
	if token == "" {
		return nil, ErrAccessMissing
	}
	if len(v.AUD) == 0 {
		return nil, fmt.Errorf("%w: 未配置 SHELFMARK_CF_ACCESS_AUD", ErrAccessInvalid)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrAccessInvalid
	}
	hb, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	pb, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	sig, err3 := base64.RawURLEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return nil, ErrAccessInvalid
	}
	var h jwtHeader
	if err := json.Unmarshal(hb, &h); err != nil || h.Alg != "RS256" {
		return nil, fmt.Errorf("%w: 只接受 RS256", ErrAccessInvalid)
	}
	key, err := v.key(ctx, h.Kid)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
		return nil, fmt.Errorf("%w: 签名不符", ErrAccessInvalid)
	}
	var c jwtClaims
	if err := json.Unmarshal(pb, &c); err != nil {
		return nil, ErrAccessInvalid
	}
	if c.Iss != v.Issuer {
		return nil, fmt.Errorf("%w: iss 不符", ErrAccessInvalid)
	}
	ok := false
	for _, a := range c.Aud {
		for _, want := range v.AUD {
			if a == want {
				ok = true
			}
		}
	}
	if !ok {
		return nil, fmt.Errorf("%w: aud 不符", ErrAccessInvalid)
	}
	now := v.Now()
	if c.Exp == nil {
		return nil, fmt.Errorf("%w: 缺少 exp", ErrAccessInvalid)
	}
	exp := time.Unix(int64(*c.Exp), 0)
	if now.After(exp.Add(v.Leeway)) {
		return nil, fmt.Errorf("%w: 已过期", ErrAccessInvalid)
	}
	if c.Nbf != nil && now.Add(v.Leeway).Before(time.Unix(int64(*c.Nbf), 0)) {
		return nil, fmt.Errorf("%w: 尚未生效", ErrAccessInvalid)
	}
	return &AccessClaims{Email: strings.ToLower(c.Email), Subject: c.Sub, CommonName: c.CommonName, Audience: c.Aud, Issuer: c.Iss, Expires: exp}, nil
}

func (v *AccessVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.Now()
	if v.keys == nil || now.Sub(v.fetchedAt) > v.RefreshEvery {
		if err := v.fetch(ctx); err != nil && v.keys == nil {
			return nil, fmt.Errorf("%w: 无法获取公钥: %v", ErrAccessInvalid, err)
		}
	}
	if k := v.keys[kid]; k != nil {
		return k, nil
	}
	if now.Sub(v.lastForced) >= v.MinForcedRefresh {
		v.lastForced = now
		if err := v.fetch(ctx); err != nil {
			return nil, fmt.Errorf("%w: 无法获取公钥: %v", ErrAccessInvalid, err)
		}
		if k := v.keys[kid]; k != nil {
			return k, nil
		}
	}
	return nil, fmt.Errorf("%w: 未知 kid", ErrAccessInvalid)
}

type jwks struct {
	Keys []struct {
		Kid string `json:"kid"`
		Kty string `json:"kty"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

// fetch loads keys; caller holds v.mu. On failure, existing keys are kept.
func (v *AccessVerifier) fetch(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.CertsURL, nil)
	if err != nil {
		return err
	}
	resp, err := v.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("certs: HTTP %d", resp.StatusCode)
	}
	var set jwks
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		nb, err1 := base64.RawURLEncoding.DecodeString(k.N)
		eb, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		e := new(big.Int).SetBytes(eb)
		if !e.IsInt64() || e.Int64() < 3 {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: int(e.Int64())}
	}
	if len(keys) == 0 {
		return errors.New("certs: 没有可用的 RSA 公钥")
	}
	v.keys = keys
	v.fetchedAt = v.Now()
	return nil
}
