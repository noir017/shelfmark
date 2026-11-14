package auth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"shelfmark/internal/config"
	"shelfmark/internal/store"
)

const (
	SessionCookie = "shelfmark_session"
	SessionTTL    = 30 * 24 * time.Hour
	touchEvery    = time.Minute
)

var (
	ErrUnauthorized = errors.New("未登录或令牌无效")
	ErrScope        = errors.New("令牌没有所需权限")
)

// Principal is an authenticated caller.
type Principal struct {
	User    *store.User
	Session *store.Session
	Token   *store.Token
}

// Method is the Me.authMethod value.
func (p *Principal) Method() string {
	if p.Token != nil {
		return "token"
	}
	if p.Session != nil && p.Session.Method == "access" {
		return "access"
	}
	return "session"
}

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

// Request authenticates by Bearer token (scope api) or session cookie.
// It returns (nil, nil) when no credentials are present.
func (a *Authenticator) Request(r *http.Request) (*Principal, error) {
	if h := r.Header.Get("Authorization"); h != "" {
		scheme, tok, _ := strings.Cut(h, " ")
		if !strings.EqualFold(scheme, "Bearer") {
			return nil, ErrUnauthorized
		}
		return a.token(r, strings.TrimSpace(tok), "api")
	}
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	ctx := r.Context()
	s, err := store.GetSession(ctx, a.DB, HashSecret(c.Value))
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	now := a.Now()
	if now.After(s.ExpiresAt) {
		store.DeleteSession(ctx, a.DB, s.ID)
		return nil, nil
	}
	u, err := store.GetUser(ctx, a.DB, s.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if now.Sub(s.LastSeenAt) > touchEvery {
		s.LastSeenAt, s.ExpiresAt = now, now.Add(SessionTTL)
		store.TouchSession(ctx, a.DB, s.ID, s.LastSeenAt, s.ExpiresAt)
	}
	return &Principal{User: u, Session: s}, nil
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
	return &Principal{User: u, Token: t}, nil
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

// SecureCookies reports whether cookies need the Secure flag.
func (a *Authenticator) SecureCookies(r *http.Request) bool {
	return strings.HasPrefix(strings.ToLower(a.Cfg.BaseURL), "https://") || IsHTTPS(r, a.Cfg.TrustedProxies)
}

// StartSession creates a session and sets the cookie. method is "session" or "access".
func (a *Authenticator) StartSession(ctx context.Context, w http.ResponseWriter, r *http.Request, u *store.User, method string) (*store.Session, error) {
	secret, err := NewSessionID()
	if err != nil {
		return nil, err
	}
	now := a.Now()
	ua := r.UserAgent()
	if len(ua) > 300 {
		ua = ua[:300]
	}
	s := &store.Session{ID: HashSecret(secret), UserID: u.ID, CreatedAt: now, ExpiresAt: now.Add(SessionTTL), LastSeenAt: now,
		UserAgent: ua, IP: ClientIP(r, a.Cfg.TrustedProxies), Method: method}
	if err := store.CreateSession(ctx, a.DB, s); err != nil {
		return nil, err
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: secret, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: a.SecureCookies(r), MaxAge: int(SessionTTL.Seconds())})
	return s, nil
}

// EndSession deletes the current session and clears the cookie.
func (a *Authenticator) EndSession(ctx context.Context, w http.ResponseWriter, r *http.Request, p *Principal) error {
	if p != nil && p.Session != nil {
		if err := store.DeleteSession(ctx, a.DB, p.Session.ID); err != nil {
			return err
		}
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: a.SecureCookies(r), MaxAge: -1})
	return nil
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

// CheckPasswordGate enforces 7.1: password endpoints reached through
// Cloudflare need a valid Access JWT.
func (a *Authenticator) CheckPasswordGate(r *http.Request) error {
	if !a.ViaCloudflare(r) {
		return nil
	}
	_, err := a.Access.Verify(r.Context(), TokenFromRequest(r))
	return err
}

// AccessUser maps a valid Access identity to a shelfmark user (single sign-on).
func (a *Authenticator) AccessUser(r *http.Request) (*store.User, error) {
	if a.Access == nil {
		return nil, ErrAccessInvalid
	}
	claims, err := a.Access.Verify(r.Context(), TokenFromRequest(r))
	if err != nil {
		return nil, err
	}
	if claims.Email == "" {
		return nil, ErrAccessInvalid
	}
	for name, email := range a.Cfg.CFAccessUsers {
		if email == claims.Email {
			u, err := store.GetUserByName(r.Context(), a.DB, name)
			if err != nil {
				return nil, ErrAccessInvalid
			}
			return u, nil
		}
	}
	return nil, ErrAccessInvalid
}
