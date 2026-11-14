package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"shelfmark/internal/config"
)

func init() {
	Argon2Params.Memory = 1024
}

// fakeAccess serves a JWKS and signs tokens like Cloudflare Access.
type fakeAccess struct {
	srv     *httptest.Server
	keys    map[string]*rsa.PrivateKey
	served  atomic.Value // []string kids currently published
	fetches atomic.Int32
}

func newFakeAccess(t *testing.T, kids ...string) *fakeAccess {
	t.Helper()
	f := &fakeAccess{keys: map[string]*rsa.PrivateKey{}}
	for _, kid := range kids {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		f.keys[kid] = k
	}
	f.served.Store(kids)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.fetches.Add(1)
		var set struct {
			Keys []map[string]string `json:"keys"`
		}
		for _, kid := range f.served.Load().([]string) {
			pub := f.keys[kid].PublicKey
			set.Keys = append(set.Keys, map[string]string{"kid": kid, "kty": "RSA", "alg": "RS256", "use": "sig",
				"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())})
		}
		json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAccess) sign(t *testing.T, kid string, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	p, _ := json.Marshal(claims)
	head := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p)
	sum := sha256.Sum256([]byte(head))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.keys[kid], crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return head + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (f *fakeAccess) verifier(now time.Time) *AccessVerifier {
	v := NewAccessVerifier("team.example.com", []string{"aud-a", "aud-b"})
	v.CertsURL = f.srv.URL + "/cdn-cgi/access/certs"
	v.Client = f.srv.Client()
	v.Now = func() time.Time { return now }
	return v
}

func TestAccessVerify(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	f := newFakeAccess(t, "k1", "k2")
	v := f.verifier(now)
	ctx := context.Background()
	base := func() map[string]any {
		return map[string]any{"aud": []string{"aud-b"}, "iss": "https://team.example.com", "exp": now.Add(time.Hour).Unix(),
			"nbf": now.Add(-time.Minute).Unix(), "email": "Alice@Example.com", "sub": "u1"}
	}
	c, err := v.Verify(ctx, f.sign(t, "k1", base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Email != "alice@example.com" {
		t.Fatalf("email %q", c.Email)
	}
	// string aud and the 60s leeway on exp/nbf
	cl := base()
	cl["aud"] = "aud-a"
	cl["exp"] = now.Add(-50 * time.Second).Unix()
	cl["nbf"] = now.Add(50 * time.Second).Unix()
	if _, err := v.Verify(ctx, f.sign(t, "k2", cl)); err != nil {
		t.Fatalf("leeway: %v", err)
	}
	bad := map[string]func(map[string]any){
		"expired":   func(m map[string]any) { m["exp"] = now.Add(-2 * time.Minute).Unix() },
		"not yet":   func(m map[string]any) { m["nbf"] = now.Add(2 * time.Minute).Unix() },
		"no exp":    func(m map[string]any) { delete(m, "exp") },
		"wrong aud": func(m map[string]any) { m["aud"] = []string{"other"} },
		"wrong iss": func(m map[string]any) { m["iss"] = "https://evil.example.com" },
	}
	for name, mutate := range bad {
		m := base()
		mutate(m)
		if _, err := v.Verify(ctx, f.sign(t, "k1", m)); !errors.Is(err, ErrAccessInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// tampered payload
	tok := f.sign(t, "k1", base())
	other, _ := json.Marshal(map[string]any{"aud": "aud-a", "iss": "https://team.example.com", "exp": now.Add(time.Hour).Unix(), "email": "mallory@example.com"})
	parts := splitJWT(tok)
	forged := parts[0] + "." + base64.RawURLEncoding.EncodeToString(other) + "." + parts[2]
	if _, err := v.Verify(ctx, forged); !errors.Is(err, ErrAccessInvalid) {
		t.Fatalf("forged: %v", err)
	}
	// alg none / HS256 rejected
	h, _ := json.Marshal(map[string]string{"alg": "none", "kid": "k1"})
	none := base64.RawURLEncoding.EncodeToString(h) + "." + parts[1] + "."
	if _, err := v.Verify(ctx, none); !errors.Is(err, ErrAccessInvalid) {
		t.Fatalf("alg none: %v", err)
	}
	if _, err := v.Verify(ctx, ""); !errors.Is(err, ErrAccessMissing) {
		t.Fatalf("missing: %v", err)
	}
}

func splitJWT(s string) [3]string {
	var out [3]string
	i := 0
	start := 0
	for j := 0; j < len(s); j++ {
		if s[j] == '.' {
			out[i] = s[start:j]
			i++
			start = j + 1
		}
	}
	out[2] = s[start:]
	return out
}

func TestAccessKeyCacheAndRotation(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	f := newFakeAccess(t, "old", "new")
	f.served.Store([]string{"old"})
	clock := now
	v := f.verifier(now)
	v.Now = func() time.Time { return clock }
	ctx := context.Background()
	claims := map[string]any{"aud": "aud-a", "iss": "https://team.example.com", "exp": now.Add(2 * time.Hour).Unix(), "email": "a@example.com"}
	for i := 0; i < 3; i++ {
		if _, err := v.Verify(ctx, f.sign(t, "old", claims)); err != nil {
			t.Fatal(err)
		}
	}
	if n := f.fetches.Load(); n != 1 {
		t.Fatalf("keys should be cached, fetched %d times", n)
	}
	// rotation: unknown kid triggers an immediate refresh
	f.served.Store([]string{"old", "new"})
	if _, err := v.Verify(ctx, f.sign(t, "new", claims)); err != nil {
		t.Fatalf("rotated key: %v", err)
	}
	if n := f.fetches.Load(); n != 2 {
		t.Fatalf("unknown kid should refetch, fetched %d", n)
	}
	// a burst of unknown kids does not hammer the endpoint
	h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "bogus"})
	bogus := base64.RawURLEncoding.EncodeToString(h) + ".e30.AA"
	for i := 0; i < 5; i++ {
		v.Verify(ctx, bogus)
	}
	if n := f.fetches.Load(); n != 2 {
		t.Fatalf("forced refresh not throttled: %d", n)
	}
	// after an hour the cache refreshes on its own
	clock = now.Add(61 * time.Minute)
	if _, err := v.Verify(ctx, f.sign(t, "old", claims)); err != nil {
		t.Fatal(err)
	}
	if n := f.fetches.Load(); n != 3 {
		t.Fatalf("hourly refresh: %d", n)
	}
}

func req(remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest("GET", "http://bm.example.com/", nil)
	r.RemoteAddr = remote
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("127.0.0.1/32")}
	cases := []struct {
		remote  string
		headers map[string]string
		want    string
	}{
		{"203.0.113.9:1234", map[string]string{"X-Forwarded-For": "1.2.3.4", "CF-Connecting-IP": "5.6.7.8"}, "203.0.113.9"},
		{"10.0.0.2:1234", map[string]string{"CF-Connecting-IP": "198.51.100.7", "X-Forwarded-For": "1.2.3.4"}, "198.51.100.7"},
		{"10.0.0.2:1234", map[string]string{"X-Forwarded-For": "198.51.100.7, 10.0.0.5"}, "198.51.100.7"},
		{"10.0.0.2:1234", map[string]string{"X-Forwarded-For": "6.6.6.6, 198.51.100.7, 10.0.0.5"}, "198.51.100.7"},
		{"127.0.0.1:1", map[string]string{}, "127.0.0.1"},
		{"[::ffff:10.0.0.2]:1", map[string]string{"X-Forwarded-For": "2001:db8::1"}, "2001:db8::1"},
	}
	for _, c := range cases {
		if got := ClientIP(req(c.remote, c.headers), trusted); got != c.want {
			t.Errorf("%s %v: %s, want %s", c.remote, c.headers, got, c.want)
		}
	}
	if !IsHTTPS(req("10.0.0.2:1", map[string]string{"X-Forwarded-Proto": "https"}), trusted) ||
		IsHTTPS(req("203.0.113.1:1", map[string]string{"X-Forwarded-Proto": "https"}), trusted) {
		t.Fatal("IsHTTPS")
	}
}

func TestOriginAllowed(t *testing.T) {
	a := &Authenticator{Cfg: &config.Config{BaseURL: "https://bm.example.com"}}
	check := func(origin, host string) bool {
		r := httptest.NewRequest("POST", "http://"+host+"/api/v1/items", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return a.OriginAllowed(r)
	}
	if !check("", "x") || !check("https://bm.example.com", "internal:8080") || !check("http://localhost:8080", "localhost:8080") || check("https://evil.example.com", "bm.example.com") {
		t.Fatal("fallback origins")
	}
	a.Cfg.AllowedOrigins = []string{"https://bm.example.com", "https://bm.lan.example.com"}
	if !check("https://bm.lan.example.com", "shelfmark:8080") || !check("https://BM.example.com", "x") || check("http://localhost:8080", "localhost:8080") {
		t.Fatal("allowed origins")
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter()
	l.Now = func() time.Time { return now }
	for i := 0; i < 9; i++ {
		l.Fail("1.1.1.1")
	}
	if b, _ := l.Blocked("1.1.1.1"); b {
		t.Fatal("blocked too early")
	}
	l.Fail("1.1.1.1")
	if b, d := l.Blocked("1.1.1.1"); !b || d != 15*time.Minute {
		t.Fatalf("not blocked %v %v", b, d)
	}
	now = now.Add(16 * time.Minute)
	if b, _ := l.Blocked("1.1.1.1"); b {
		t.Fatal("still blocked")
	}
}

func TestPasswordAndToken(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(h, "correct horse") || VerifyPassword(h, "wrong") {
		t.Fatal("verify")
	}
	tok, _ := NewToken()
	if len(tok) < 40 || tok[:4] != "smk_" || TokenPrefix(tok) != tok[:8] {
		t.Fatalf("token %q", tok)
	}
}
