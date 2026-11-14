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
	creds := map[string]string{"username": "alice", "password": "correct horse"}
	// setup through Cloudflare without a JWT is refused; the LAN path (no Cf-Ray) works
	e.expect(e.do("POST", "/api/v1/setup", creds, ray), 403)
	e.setup()
	e.expect(e.api("POST", "/api/v1/auth/logout", nil), 204)
	e.expect(e.do("POST", "/api/v1/auth/login", creds, ray), 403)
	bad := signJWT(t, key, claims(map[string]any{"aud": "other"}))
	e.expect(e.do("POST", "/api/v1/auth/login", creds, map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": bad}), 403)
	// a service token JWT (common_name, no email) is enough for password endpoints
	service := signJWT(t, key, claims(map[string]any{"common_name": "abc.access", "sub": ""}))
	e.expect(e.do("POST", "/api/v1/auth/token", map[string]any{"username": "alice", "password": "correct horse", "name": "插件", "scopes": []string{"api"}},
		map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": service, "Origin": "chrome-extension://x"}), 201)
	// ...but not for single sign-on, which needs a mapped email
	e.expect(e.do("POST", "/api/v1/auth/access", nil, map[string]string{"Cf-Access-Jwt-Assertion": service}), 401)
	user := signJWT(t, key, claims(map[string]any{"email": "Alice@example.com"}))
	e.expect(e.do("POST", "/api/v1/auth/login", creds, map[string]string{"Cf-Ray": "1", "Cookie": "CF_Authorization=" + user}), 200)
	e.expect(e.api("POST", "/api/v1/auth/logout", nil), 204)
	var me struct{ AuthMethod string }
	e.expect(e.do("POST", "/api/v1/auth/access", nil, map[string]string{"Cf-Ray": "1", "Cf-Access-Jwt-Assertion": user}), 200).json(t, &me)
	if me.AuthMethod != "access" {
		t.Fatalf("method %s", me.AuthMethod)
	}
	e.expect(e.api("GET", "/api/v1/auth/me", nil), 200).json(t, &me)
	if me.AuthMethod != "access" {
		t.Fatalf("session method %s", me.AuthMethod)
	}
	// password change through Cloudflare with a session needs the JWT too; Bearer does not
	e.expect(e.do("POST", "/api/v1/auth/password", map[string]string{"currentPassword": "correct horse", "newPassword": "new password1"},
		map[string]string{"Cf-Ray": "1", "X-Requested-With": "shelfmark"}), 403)
	e.expect(e.do("POST", "/api/v1/auth/password", map[string]string{"currentPassword": "correct horse", "newPassword": "new password1"},
		map[string]string{"Cf-Ray": "1", "Authorization": "Bearer " + e.apiToken}), 204)
	var info struct{ Features struct{ CfAccessSso bool } }
	e.expect(e.api("GET", "/api/v1/system/info", nil), 200).json(t, &info)
	if !info.Features.CfAccessSso {
		t.Fatal("cfAccessSso")
	}
	// Floccus via Cloudflare is unaffected (token auth)
	e.expect(e.dav("GET", "bookmarks.xbel", nil, ray), 200)
}

func TestAccessSSODisabled(t *testing.T) {
	e := newEnv(t, nil)
	e.expect(e.do("POST", "/api/v1/auth/access", nil, nil), 503)
}
