// Package api implements the REST API of api/openapi.yaml.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"shelfmark/internal/ai"
	"shelfmark/internal/auth"
	"shelfmark/internal/config"
	"shelfmark/internal/core"
	"shelfmark/internal/jobs"
	"shelfmark/internal/meta"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/xbel"
)

type API struct {
	Core *core.Service
	Auth *auth.Authenticator
	Cfg  *config.Config
	DB   *store.DB
	Jobs *jobs.Manager
	Meta *meta.Client
	AI   *ai.Client
	Log  *slog.Logger
}

// Error is an API error response.
type Error struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
	Headers map[string]string
}

func (e *Error) Error() string { return e.Message }

func errf(status int, code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

var (
	errUnauthorized = errf(http.StatusUnauthorized, "unauthorized", "未登录或令牌无效")
	errForbidden    = errf(http.StatusForbidden, "forbidden", "没有权限")
	errNotFound     = errf(http.StatusNotFound, "not_found", "不存在")
)

func validation(field, msg string) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: "validation", Message: msg, Details: map[string]any{field: msg}}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func (a *API) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var e *Error
	var ve *core.ValidationError
	var ce *core.ConflictError
	var le *core.LockedError
	var pe *xbel.ParseError
	switch {
	case errors.As(err, &e):
	case errors.As(err, &ve):
		d := map[string]any{}
		for k, v := range ve.Fields {
			d[k] = v
		}
		e = &Error{Status: 422, Code: "validation", Message: ve.Msg, Details: d}
	case errors.As(err, &ce):
		e = errf(409, "conflict", ce.Msg)
	case errors.As(err, &le):
		e = &Error{Status: 423, Code: "locked", Message: "正在与 " + le.Actor + " 同步，请稍后再试",
			Details: map[string]any{"actor": le.Actor, "since": store.TS(le.Since), "modifiedAt": store.TS(le.Modified)},
			Headers: map[string]string{"Retry-After": "5"}}
	case errors.Is(err, core.ErrNotFound), errors.Is(err, store.ErrNotFound), errors.Is(err, tree.ErrNotFound):
		e = errNotFound
	case errors.Is(err, tree.ErrCycle):
		e = errf(409, "conflict", tree.ErrCycle.Error())
	case errors.Is(err, tree.ErrNotFolder):
		e = validation("parentId", tree.ErrNotFolder.Error())
	case errors.Is(err, jobs.ErrRunning):
		e = errf(409, "conflict", err.Error())
	case errors.Is(err, jobs.ErrForbidden):
		e = errf(403, "forbidden", err.Error())
	case errors.Is(err, ai.ErrUpstream):
		e = errf(503, "unavailable", err.Error())
	case errors.Is(err, xbel.ErrEncrypted), errors.Is(err, xbel.ErrHTML), errors.Is(err, xbel.ErrNotXBEL):
		e = errf(415, "unsupported_media_type", err.Error())
	case errors.As(err, &pe):
		e = errf(415, "unsupported_media_type", err.Error())
	case errors.Is(err, auth.ErrAccessMissing), errors.Is(err, auth.ErrAccessInvalid):
		e = errf(403, "forbidden", "经 Cloudflare 访问时需要有效的 Access 登录："+err.Error())
	default:
		if r.Context().Err() != nil {
			return
		}
		a.Log.Error("api", "method", r.Method, "path", r.URL.Path, "err", err)
		e = errf(500, "internal", "服务器内部错误")
	}
	for k, v := range e.Headers {
		w.Header().Set(k, v)
	}
	body := map[string]any{"code": e.Code, "message": e.Message}
	if len(e.Details) > 0 {
		body["details"] = e.Details
	}
	writeJSON(w, e.Status, map[string]any{"error": body})
}

type authedFunc func(w http.ResponseWriter, r *http.Request, p *auth.Principal) error

func unsafeMethod(m string) bool {
	return m != http.MethodGet && m != http.MethodHead && m != http.MethodOptions
}

// authed requires a session or api token; cookie writes need the CSRF header and origin.
func (a *API) authed(fn authedFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := a.Auth.Request(r)
		if err != nil {
			if errors.Is(err, auth.ErrScope) {
				a.writeError(w, r, errf(403, "forbidden", "令牌没有 api 权限"))
				return
			}
			if errors.Is(err, auth.ErrUnauthorized) {
				a.writeError(w, r, errUnauthorized)
				return
			}
			a.writeError(w, r, err)
			return
		}
		if p == nil {
			a.writeError(w, r, errUnauthorized)
			return
		}
		if !p.IsToken() && unsafeMethod(r.Method) {
			if !a.Auth.OriginAllowed(r) {
				a.writeError(w, r, errf(403, "forbidden", "来源不被允许（Origin 校验失败）"))
				return
			}
			beacon := r.URL.Path == "/api/v1/visits"
			if !beacon && r.Header.Get("X-Requested-With") != "shelfmark" {
				a.writeError(w, r, errf(403, "forbidden", "缺少请求头 X-Requested-With: shelfmark"))
				return
			}
		}
		if err := fn(w, r, p); err != nil {
			a.writeError(w, r, err)
		}
	}
}

// public is for endpoints without authentication. Endpoints that start a
// cookie session (checkOrigin) still need an allowed Origin; others, like
// token issuance for the extension, must accept chrome-extension:// origins.
func (a *API) public(checkOrigin bool, fn func(w http.ResponseWriter, r *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if checkOrigin && unsafeMethod(r.Method) && !a.Auth.OriginAllowed(r) {
			a.writeError(w, r, errf(403, "forbidden", "来源不被允许（Origin 校验失败）"))
			return
		}
		if err := fn(w, r); err != nil {
			a.writeError(w, r, err)
		}
	}
}

func adminOnly(p *auth.Principal) error {
	if !p.User.IsAdmin {
		return errf(403, "forbidden", "仅管理员可用")
	}
	return nil
}

const maxJSON = 4 << 20

func decode(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSON+1))
	if err != nil {
		return errf(400, "validation", "读取请求失败")
	}
	if len(body) > maxJSON {
		return errf(413, "payload_too_large", "请求太大")
	}
	if err := json.Unmarshal(body, v); err != nil {
		return &Error{Status: 422, Code: "validation", Message: "JSON 格式不正确：" + err.Error(), Details: map[string]any{"body": err.Error()}}
	}
	return nil
}

func pathInt(r *http.Request, name string) (int64, error) {
	v, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil {
		return 0, validation(name, name+" 必须是整数")
	}
	return v, nil
}

func queryInt(r *http.Request, name string, def, lo, hi int) (int, error) {
	s := r.URL.Query().Get(name)
	if s == "" {
		return def, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < lo || v > hi {
		return 0, validation(name, name+" 超出范围")
	}
	return v, nil
}

// actor builds the revision actor for a principal.
func (a *API) actor(r *http.Request, p *auth.Principal) core.Actor {
	source := core.SourceWeb
	if p.IsToken() {
		source = core.SourceAPI
		o := strings.ToLower(r.Header.Get("Origin"))
		if strings.HasPrefix(o, "chrome-extension://") || strings.HasPrefix(o, "moz-extension://") || strings.HasPrefix(o, "safari-web-extension://") {
			source = core.SourceExtension
		}
	}
	return core.Actor{UserID: p.User.ID, Name: p.ActorName(), Source: source, TokenID: p.TokenID()}
}

func (a *API) library(r *http.Request, p *auth.Principal) (*store.Library, error) {
	slug := r.PathValue("slug")
	if !core.ValidSlug(slug) {
		return nil, errNotFound
	}
	return a.Core.GetLibrary(r.Context(), p.User.ID, slug)
}

// ---- JSON shapes ----

type healthJSON struct {
	Status     string  `json:"status"`
	HTTPStatus *int    `json:"httpStatus"`
	FinalURL   *string `json:"finalUrl"`
	CheckedAt  *string `json:"checkedAt"`
	Error      *string `json:"error"`
}

type itemJSON struct {
	ID            int64        `json:"id"`
	Type          string       `json:"type"`
	ParentID      int64        `json:"parentId"`
	Position      int          `json:"position"`
	Title         string       `json:"title"`
	URL           *string      `json:"url"`
	CreatedAt     string       `json:"createdAt"`
	UpdatedAt     string       `json:"updatedAt"`
	Notes         *string      `json:"notes"`
	Tags          []string     `json:"tags"`
	FaviconID     *string      `json:"faviconId"`
	Health        *healthJSON  `json:"health"`
	VisitCount    int          `json:"visitCount"`
	LastVisitedAt *string      `json:"lastVisitedAt"`
	Children      *[]*itemJSON `json:"children,omitempty"`
}

func tsp(t *time.Time) *string {
	if t == nil || t.IsZero() {
		return nil
	}
	s := store.TS(*t)
	return &s
}

func ts(t time.Time) string {
	if t.IsZero() {
		return store.TS(time.Unix(0, 0))
	}
	return store.TS(t)
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func toItem(it *tree.Item, m *store.Meta) *itemJSON {
	j := &itemJSON{ID: it.ID, Type: it.Type, ParentID: it.ParentID, Position: it.Position, Title: it.Title,
		CreatedAt: ts(it.CreatedAt), UpdatedAt: ts(it.UpdatedAt), Notes: strp(it.Notes), Tags: tree.SortedTags(it.Tags)}
	if it.Type == tree.Bookmark {
		u := it.URL
		j.URL = &u
	}
	if m != nil {
		j.FaviconID = m.FaviconID
		j.VisitCount = m.VisitCount
		j.LastVisitedAt = tsp(m.LastVisitedAt)
		if m.HealthStatus != nil {
			j.Health = &healthJSON{Status: *m.HealthStatus, HTTPStatus: m.HealthHTTP, FinalURL: m.HealthFinalURL, CheckedAt: tsp(m.HealthCheckedAt), Error: m.HealthError}
		}
	}
	return j
}

type itemWithPath struct {
	Library string    `json:"library"`
	Item    *itemJSON `json:"item"`
	Path    []string  `json:"path"`
	PathIDs []int64   `json:"pathIds"`
}

func withPath(v *core.View, id int64) *itemWithPath {
	it := v.Tree.Get(id)
	if it == nil {
		return nil
	}
	path, ids := v.Tree.Path(id)
	return &itemWithPath{Library: v.Lib.Slug, Item: toItem(it, v.Meta[id]), Path: path, PathIDs: ids}
}

func treeJSON(v *core.View) []*itemJSON {
	var conv func(parent int64) []*itemJSON
	conv = func(parent int64) []*itemJSON {
		out := []*itemJSON{}
		for _, id := range v.Tree.Children(parent) {
			it := v.Tree.Get(id)
			j := toItem(it, v.Meta[id])
			if it.Type == tree.Folder {
				kids := conv(id)
				j.Children = &kids
			}
			out = append(out, j)
		}
		return out
	}
	return conv(0)
}

type userJSON struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	IsAdmin   bool   `json:"isAdmin"`
	CreatedAt string `json:"createdAt"`
}

func toUser(u *store.User) userJSON {
	return userJSON{ID: u.ID, Username: u.Username, IsAdmin: u.IsAdmin, CreatedAt: ts(u.CreatedAt)}
}

type tokenJSON struct {
	ID         int64    `json:"id"`
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	Prefix     string   `json:"prefix"`
	CreatedAt  string   `json:"createdAt"`
	LastUsedAt *string  `json:"lastUsedAt"`
	LastUsedIP *string  `json:"lastUsedIp"`
	Token      string   `json:"token,omitempty"`
}

func toToken(t *store.Token) tokenJSON {
	return tokenJSON{ID: t.ID, Name: t.Name, Scopes: t.Scopes, Prefix: t.Prefix, CreatedAt: ts(t.CreatedAt), LastUsedAt: tsp(t.LastUsedAt), LastUsedIP: t.LastUsedIP}
}
