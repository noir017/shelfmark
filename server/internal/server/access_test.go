package server

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"shelfmark/internal/config"
)

// fake Cloudflare Access: our own RSA key and certs endpoint, no network.
func fakeAccess(t *testing.T) (*rsa.PrivateKey, *httptest.Server) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"kid": "k1", "kty": "RSA", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	}))
	t.Cleanup(srv.Close)
	return key, srv
}

func signJWT(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "k1"})
	p, _ := json.Marshal(claims)
	head := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p)
	sum := sha256.Sum256([]byte(head))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return head + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestCloudflareAccess(t *testing.T) {
	key, certs := fakeAccess(t)
	e := newEnv(t, func(c *config.Config) {
		c.CFAccessTeamDomain = "team.example.com"
		c.CFAccessAUD = []string{"aud-1"}
		c.CFAccessUsers = map[string]string{"alice": "alice@example.com"}
	})
	e.setup()
	v := e.srv.Auth.Access
	v.CertsURL = certs.URL
	v.Client = certs.Client()
	claims := func(extra map[string]any) map[string]any {
		m := map[string]any{"aud": []string{"aud-1"}, "iss": "https://team.example.com", "exp": time.Now().Add(time.Hour).Unix()}
		for k, x := range extra {
			m[k] = x
		}
		return m
	}
	ray := map[string]string{"Cf-Ray": "8abc-SJC"}
	// 经 Cloudflare 没有 Access 身份 → 403
	e.expect(e.do("GET", "/api/v1/auth/me", nil, ray), 403)
	bad := signJWT(t, key, claims(map[string]any{"email": "alice@example.com", "aud": "other"}))
	e.expect(e.do("GET", "/api/v1/auth/me", nil, map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": bad}), 403)
	// 合法身份 → 直接就是映射的用户
	user := signJWT(t, key, claims(map[string]any{"email": "Alice@example.com"}))
	var me struct{ AuthMethod, Email string }
	e.expect(e.do("GET", "/api/v1/auth/me", nil, map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": user}), 200).json(t, &me)
	if me.AuthMethod != "access" || me.Email != "alice@example.com" {
		t.Fatalf("me %+v", me)
	}
	// CF_Authorization Cookie 同样有效
	e.expect(e.do("GET", "/api/v1/auth/me", nil, map[string]string{"Cf-Ray": "1", "Cookie": "CF_Authorization=" + user}), 200).json(t, &me)
	// 服务令牌（没有邮箱）落到默认用户
	service := signJWT(t, key, claims(map[string]any{"common_name": "abc.access", "sub": ""}))
	e.expect(e.do("GET", "/api/v1/auth/me", nil, map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": service}), 200)
	// 经 Cloudflare 的写请求仍要 CSRF 头
	e.expect(e.do("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "folder", "title": "x"},
		map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": user}), 403)
	e.expect(e.do("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "folder", "title": "x"},
		map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": user, "X-Requested-With": "shelfmark"}), 201)
	var info struct{ Features struct{ CfAccess bool } }
	e.expect(e.api("GET", "/api/v1/system/info", nil), 200).json(t, &info)
	if !info.Features.CfAccess {
		t.Fatal("cfAccess")
	}
	// Floccus 经 Cloudflare 仍然走 dav 令牌
	e.expect(e.dav("GET", "bookmarks.xbel", nil, ray), 200)
	e.expect(e.do("GET", "/dav/bookmarks.xbel", nil, ray), 401)
}
