package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"shelfmark/internal/config"
	"shelfmark/internal/store"
)

const touchEvery = time.Minute

var (
	ErrUnauthorized = errors.New("未登录或令牌无效")
	ErrScope        = errors.New("令牌没有所需权限")
)

// Principal is an authenticated caller.
type Principal struct {
	User  *store.User
	Token *store.Token

	// method is "token", "access" or "lan".
	method string
	// Email is the Cloudflare Access identity, when method is "access".
	Email string
}

// Method is the Me.authMethod value.
func (p *Principal) Method() string { return p.method }

func (p *Principal) IsToken() bool { return p.Token != nil }

// ActorName is what revisions record: the token name or the username.
func (p *Principal) ActorName() string {
	if p.Token != nil {
		return p.Token.Name
	}
	return p.User.Username
}

func (p *Principal) TokenID() int64 {
	if p.Token != nil {
		return p.Token.ID
	}
	return 0
}

type Authenticator struct {
	DB      *store.DB
	Cfg     *config.Config
	Limiter *Limiter
	Access  *AccessVerifier
	Now     func() time.Time
}

func NewAuthenticator(db *store.DB, cfg *config.Config) *Authenticator {
	a := &Authenticator{DB: db, Cfg: cfg, Limiter: NewLimiter(), Now: func() time.Time { return time.Now().UTC() }}
	if cfg.AccessEnabled() {
		a.Access = NewAccessVerifier(cfg.CFAccessTeamDomain, cfg.CFAccessAUD)
	}
	return a
}

// Request resolves the caller: a Bearer token, the Cloudflare Access identity
// when the request came through Cloudflare, or the default user otherwise.
func (a *Authenticator) Request(r *http.Request) (*Principal, error) {
	if h := r.Header.Get("Authorization"); h != "" {
		scheme, tok, _ := strings.Cut(h, " ")
		if !strings.EqualFold(scheme, "Bearer") {
			return nil, ErrUnauthorized
		}
		return a.token(r, strings.TrimSpace(tok), "api")
	}
	if a.ViaCloudflare(r) {
		return a.access(r)
	}
	return a.LocalPrincipal(r.Context())
}

func (a *Authenticator) token(r *http.Request, tok, scope string) (*Principal, error) {
	if !strings.HasPrefix(tok, "smk_") {
		return nil, ErrUnauthorized
	}
	ctx := r.Context()
	t, err := store.GetActiveTokenByHash(ctx, a.DB, HashSecret(tok))
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if !t.HasScope(scope) {
		return nil, ErrScope
	}
	u, err := store.GetUser(ctx, a.DB, t.UserID)
	if err != nil {
		return nil, ErrUnauthorized
	}
	now := a.Now()
	if t.LastUsedAt == nil || now.Sub(*t.LastUsedAt) > touchEvery {
		store.TouchToken(ctx, a.DB, t.ID, ClientIP(r, a.Cfg.TrustedProxies), now)
	}
	return &Principal{User: u, Token: t, method: "token"}, nil
}

// Basic authenticates WebDAV: username plus a token with scope dav.
func (a *Authenticator) Basic(r *http.Request) (*Principal, error) {
	user, pass, ok := r.BasicAuth()
	if !ok {
		return nil, ErrUnauthorized
	}
	p, err := a.token(r, pass, "dav")
	if err != nil {
		if errors.Is(err, ErrScope) {
			return nil, ErrUnauthorized
		}
		return nil, err
	}
	if !strings.EqualFold(p.User.Username, user) {
		return nil, ErrUnauthorized
	}
	return p, nil
}

// LocalPrincipal is the identity for requests that carry no credentials and
// did not come through Cloudflare: the default user.
func (a *Authenticator) LocalPrincipal(ctx context.Context) (*Principal, error) {
	u, err := a.DefaultUser(ctx)
	if err != nil {
		return nil, err
	}
	return &Principal{User: u, method: "lan"}, nil
}

// DefaultUser is SHELFMARK_DEFAULT_USER, or the first user created.
func (a *Authenticator) DefaultUser(ctx context.Context) (*store.User, error) {
	if name := a.Cfg.DefaultUser; name != "" {
		u, err := store.GetUserByName(ctx, a.DB, name)
		if err != nil {
			return nil, fmt.Errorf("SHELFMARK_DEFAULT_USER=%s: %w", name, err)
		}
		return u, nil
	}
	u, err := store.FirstUser(ctx, a.DB)
	if err != nil {
		return nil, fmt.Errorf("没有可用用户: %w", err)
	}
	return u, nil
}

// OriginAllowed implements the CSRF Origin check (design 7 / 7.1).
func (a *Authenticator) OriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	o := strings.ToLower(u.Scheme + "://" + u.Host)
	if len(a.Cfg.AllowedOrigins) > 0 {
		for _, allowed := range a.Cfg.AllowedOrigins {
			if o == allowed {
				return true
			}
		}
		return false
	}
	if base := a.Cfg.BaseOrigin(); base != "" && o == base {
		return true
	}
	return strings.EqualFold(u.Host, r.Host)
}

// ViaCloudflare reports whether a request came through Cloudflare (Cf-Ray)
// while Access is configured.
func (a *Authenticator) ViaCloudflare(r *http.Request) bool {
	return a.Access != nil && r.Header.Get("Cf-Ray") != ""
}

// access resolves the Cloudflare Access identity carried by the request.
func (a *Authenticator) access(r *http.Request) (*Principal, error) {
	claims, err := a.Access.Verify(r.Context(), TokenFromRequest(r))
	if err != nil {
		return nil, err
	}
	u, err := a.userForEmail(r.Context(), claims.Email)
	if err != nil {
		return nil, err
	}
	return &Principal{User: u, method: "access", Email: claims.Email}, nil
}

// userForEmail maps an Access email through SHELFMARK_CF_ACCESS_USERS; without
// a mapping (single-user instance) the default user is used.
func (a *Authenticator) userForEmail(ctx context.Context, email string) (*store.User, error) {
	if email != "" {
		for name, mapped := range a.Cfg.CFAccessUsers {
			if mapped == email {
				u, err := store.GetUserByName(ctx, a.DB, name)
				if err != nil {
					return nil, ErrAccessInvalid
				}
				return u, nil
			}
		}
	}
	u, err := a.DefaultUser(ctx)
	if err != nil {
		return nil, ErrAccessInvalid
	}
	return u, nil
}
