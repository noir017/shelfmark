package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"shelfmark/internal/auth"
	"shelfmark/internal/config"
	"shelfmark/internal/core"
	"shelfmark/internal/store"
)

type meJSON struct {
	User       userJSON `json:"user"`
	AuthMethod string   `json:"authMethod"`
	Email      string   `json:"email,omitempty"`
}

func (a *API) systemInfo(w http.ResponseWriter, r *http.Request) error {
	var base *string
	if a.Cfg.BaseURL != "" {
		base = &a.Cfg.BaseURL
	}
	writeJSON(w, 200, map[string]any{
		"version": config.Version, "commit": config.Commit, "davPath": "/dav/", "baseUrl": base,
		"features": map[string]bool{
			"ai": a.AI != nil, "metrics": a.Cfg.Metrics, "linkcheck": a.Cfg.LinkcheckInterval > 0,
			"metadata": a.Cfg.FetchMetadata, "autoCreateLibrary": a.Cfg.DAVAutoCreate, "cfAccess": a.Cfg.AccessEnabled(),
		},
	})
	return nil
}

func (a *API) me(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	writeJSON(w, 200, meJSON{User: toUser(p.User), AuthMethod: p.Method(), Email: p.Email})
	return nil
}

func validScopes(scopes []string) ([]string, error) {
	if len(scopes) == 0 {
		return nil, validation("scopes", "至少一个 scope")
	}
	seen := map[string]bool{}
	var out []string
	for _, s := range scopes {
		if s != "api" && s != "dav" {
			return nil, validation("scopes", "scope 只能是 api 或 dav")
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

func (a *API) issueToken(r *http.Request, u *store.User, name string, scopes []string) (tokenJSON, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 {
		return tokenJSON{}, validation("name", "名称不能为空，最长 100 字")
	}
	scopes, err := validScopes(scopes)
	if err != nil {
		return tokenJSON{}, err
	}
	plain, err := auth.NewToken()
	if err != nil {
		return tokenJSON{}, err
	}
	t, err := store.CreateToken(r.Context(), a.DB, u.ID, name, scopes, auth.HashSecret(plain), auth.TokenPrefix(plain), a.Core.Now())
	if err != nil {
		return tokenJSON{}, err
	}
	j := toToken(t)
	j.Token = plain
	return j, nil
}

// ---- users (admin) ----

func (a *API) listUsers(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if err := adminOnly(p); err != nil {
		return err
	}
	users, err := store.ListUsers(r.Context(), a.DB)
	if err != nil {
		return err
	}
	out := []userJSON{}
	for _, u := range users {
		out = append(out, toUser(u))
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) createUser(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if err := adminOnly(p); err != nil {
		return err
	}
	var body struct {
		Username string `json:"username"`
		IsAdmin  bool   `json:"isAdmin"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	u, err := a.Core.CreateUser(r.Context(), body.Username, body.IsAdmin)
	if err != nil {
		return err
	}
	writeJSON(w, 201, toUser(u))
	return nil
}

func (a *API) targetUser(r *http.Request) (*store.User, error) {
	id, err := pathInt(r, "userId")
	if err != nil {
		return nil, err
	}
	return store.GetUser(r.Context(), a.DB, id)
}

func (a *API) updateUser(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if err := adminOnly(p); err != nil {
		return err
	}
	u, err := a.targetUser(r)
	if err != nil {
		return err
	}
	var body struct {
		IsAdmin *bool `json:"isAdmin"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	if body.IsAdmin != nil && !*body.IsAdmin && u.IsAdmin {
		n, err := store.CountAdmins(ctx, a.DB)
		if err != nil {
			return err
		}
		if n <= 1 {
			return errf(409, "conflict", "不能取消最后一个管理员")
		}
	}
	if body.IsAdmin != nil {
		if err := store.SetUserAdmin(ctx, a.DB, u.ID, *body.IsAdmin, a.Core.Now()); err != nil {
			return err
		}
	}
	u, err = store.GetUser(ctx, a.DB, u.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, toUser(u))
	return nil
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if err := adminOnly(p); err != nil {
		return err
	}
	u, err := a.targetUser(r)
	if err != nil {
		return err
	}
	if u.ID == p.User.ID {
		return errf(409, "conflict", "不能删除自己")
	}
	if u.IsAdmin {
		n, err := store.CountAdmins(r.Context(), a.DB)
		if err != nil {
			return err
		}
		if n <= 1 {
			return errf(409, "conflict", "不能删除最后一个管理员")
		}
	}
	if err := store.DeleteUser(r.Context(), a.DB, u.ID); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

// ---- tokens ----

func (a *API) listTokens(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	ts, err := store.ListTokens(r.Context(), a.DB, p.User.ID)
	if err != nil {
		return err
	}
	out := []tokenJSON{}
	for _, t := range ts {
		out = append(out, toToken(t))
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) createToken(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	t, err := a.issueToken(r, p.User, body.Name, body.Scopes)
	if err != nil {
		return err
	}
	writeJSON(w, 201, t)
	return nil
}

func (a *API) revokeToken(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	id, err := pathInt(r, "tokenId")
	if err != nil {
		return err
	}
	ok, err := store.RevokeToken(r.Context(), a.DB, p.User.ID, id, a.Core.Now())
	if err != nil {
		return err
	}
	if !ok {
		return errNotFound
	}
	w.WriteHeader(204)
	return nil
}

// davURL is the Floccus server address: BASE_URL, else inferred from the request.
func (a *API) davURL(r *http.Request) string {
	if a.Cfg.BaseURL != "" {
		return a.Cfg.BaseURL + "/dav/"
	}
	scheme := "http"
	if auth.IsHTTPS(r, a.Cfg.TrustedProxies) {
		scheme = "https"
	}
	host := r.Host
	if auth.FromTrustedProxy(r, a.Cfg.TrustedProxies) {
		if h := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); h != "" {
			host = h
		}
	}
	return (&url.URL{Scheme: scheme, Host: host, Path: "/dav/"}).String()
}

// floccusProfile builds the file Floccus imports via "Import profiles":
// Account.import iterates over a JSON array of account data objects
// (src/lib/Account.ts, src/ui/views/ImportExport.vue); WebDAV fields follow
// WebDavAdapter.getDefaultValues.
func floccusProfile(davURL, username, token, file, slug string) []map[string]any {
	return []map[string]any{{
		"type":                 "webdav",
		"url":                  davURL,
		"username":             username,
		"password":             token,
		"bookmark_file":        file,
		"bookmark_file_type":   "xbel",
		"includeCredentials":   false,
		"allowRedirects":       false,
		"passphrase":           "",
		"allowNetwork":         false,
		"label":                "shelfmark · " + slug,
		"localRoot":            nil,
		"strategy":             "default",
		"syncInterval":         15,
		"syncIntervalEnabled":  true,
		"syncOnStartupEnabled": false,
		"nestedSync":           false,
		"failsafe":             true,
		"clickCountEnabled":    false,
		"notifyOnly":           false,
		"notificationsEnabled": false,
	}}
}

func (a *API) floccusSetup(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		Library    string `json:"library"`
		DeviceName string `json:"deviceName"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if !core.ValidSlug(body.Library) {
		return errNotFound
	}
	lib, err := a.Core.GetLibrary(r.Context(), p.User.ID, body.Library)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(body.DeviceName)
	if name == "" || len([]rune(name)) > 80 {
		return validation("deviceName", "设备名不能为空，最长 80 字")
	}
	t, err := a.issueToken(r, p.User, name, []string{"dav"})
	if err != nil {
		return err
	}
	dav := a.davURL(r)
	file := lib.Slug + ".xbel"
	fileName := fmt.Sprintf("floccus-%s-%s.json", lib.Slug, sanitizeFileName(name))
	writeJSON(w, 201, map[string]any{
		"token": t, "library": lib.Slug, "davUrl": dav, "username": p.User.Username, "bookmarkFile": file,
		"profile":         floccusProfile(dav, p.User.Username, t.Token, file, lib.Slug),
		"profileFileName": fileName,
	})
	return nil
}

func sanitizeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		case r > 127:
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "device"
	}
	return out
}
