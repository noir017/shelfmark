// Package dav is the WebDAV subset Floccus needs (design section 4).
package dav

import (
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"shelfmark/internal/auth"
	"shelfmark/internal/config"
	"shelfmark/internal/core"
	"shelfmark/internal/metrics"
	"shelfmark/internal/store"
	"shelfmark/internal/xbel"
)

const Prefix = "/dav/"

const allow = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MOVE"

var libFileRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}\.xbel$`)

type Handler struct {
	Core    *core.Service
	Auth    *auth.Authenticator
	Cfg     *config.Config
	Metrics *metrics.Set
	Log     *slog.Logger
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func text(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	io.WriteString(w, msg+"\n")
}

// libSlug returns the slug if name is a library file.
func libSlug(name string) (string, bool) {
	if !libFileRe.MatchString(name) {
		return "", false
	}
	slug := strings.TrimSuffix(name, ".xbel")
	return slug, core.ValidSlug(slug)
}

func (h *Handler) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w := &statusWriter{ResponseWriter: rw}
	defer func() {
		if h.Metrics != nil {
			st := w.status
			if st == 0 {
				st = 200
			}
			h.Metrics.DAVRequests.Inc(r.Method, strconv.Itoa(st))
		}
	}()
	name := strings.TrimPrefix(r.URL.Path, "/dav")
	name = strings.TrimPrefix(name, "/")
	if r.Method == http.MethodOptions {
		w.Header().Set("DAV", "1")
		w.Header().Set("Allow", allow)
		w.Header().Set("MS-Author-Via", "DAV")
		w.WriteHeader(http.StatusOK)
		return
	}
	ip := auth.ClientIP(r, h.Cfg.TrustedProxies)
	if blocked, d := h.Auth.Limiter.Blocked(ip); blocked {
		w.Header().Set("Retry-After", strconv.Itoa(int(d.Seconds())+1))
		text(w, http.StatusTooManyRequests, "认证失败次数过多，请稍后再试")
		return
	}
	p, err := h.Auth.Basic(r)
	if errors.Is(err, auth.ErrUnauthorized) {
		// 内网且没带凭据：直接用默认用户，Floccus 不必配令牌。
		if _, _, ok := r.BasicAuth(); !ok && !h.Auth.ViaCloudflare(r) {
			if local, e := h.Auth.LocalPrincipal(r.Context()); e == nil {
				p, err = local, nil
			}
		}
	}
	if err != nil {
		if _, _, ok := r.BasicAuth(); ok {
			h.Auth.Limiter.Fail(ip)
		}
		if !errors.Is(err, auth.ErrUnauthorized) {
			h.Log.Error("dav auth", "err", err)
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="shelfmark"`)
		text(w, http.StatusUnauthorized, "需要用户名和 dav 令牌")
		return
	}
	if strings.Contains(name, "/") {
		text(w, http.StatusNotFound, "不支持子目录：文件名只能是 <库>.xbel 这样的扁平名字")
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		h.get(w, r, p, name)
	case "PROPFIND":
		h.propfind(w, r, p, name)
	case http.MethodPut:
		h.put(w, r, p, name)
	case http.MethodDelete:
		h.delete(w, r, p, name)
	case "MOVE":
		h.move(w, r, p, name)
	default:
		w.Header().Set("Allow", allow)
		text(w, http.StatusMethodNotAllowed, "不支持的方法 "+r.Method)
	}
}

func (h *Handler) actor(p *auth.Principal) core.Actor {
	return core.Actor{UserID: p.User.ID, Name: p.ActorName(), Source: core.SourceWebDAV, TokenID: p.TokenID()}
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request, p *auth.Principal, name string) {
	ctx := r.Context()
	w.Header().Set("Cache-Control", "no-store")
	if name == "" {
		files, err := h.listing(r, p)
		if err != nil {
			h.fail(w, err)
			return
		}
		var b strings.Builder
		for _, f := range files {
			b.WriteString(f.name + "\n")
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(b.Len()))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			io.WriteString(w, b.String())
		}
		return
	}
	if slug, ok := libSlug(name); ok {
		lib, err := store.GetLibrary(ctx, h.Core.DB, p.User.ID, slug)
		if errors.Is(err, store.ErrNotFound) {
			text(w, http.StatusNotFound, "库 "+slug+" 不存在")
			return
		}
		if err != nil {
			h.fail(w, err)
			return
		}
		f, err := h.Core.XBEL(ctx, lib)
		if err != nil {
			h.fail(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len(f.Data)))
		w.Header().Set("Last-Modified", f.ModTime.UTC().Format(http.TimeFormat))
		w.Header().Set("ETag", f.ETag)
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			w.Write(f.Data)
		}
		return
	}
	f, err := store.GetDavFile(ctx, h.Core.DB, p.User.ID, name)
	if errors.Is(err, store.ErrNotFound) {
		text(w, http.StatusNotFound, "文件不存在")
		return
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	ct := f.ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.Itoa(len(f.Data)))
	w.Header().Set("Last-Modified", f.ModifiedAt.UTC().Format(http.TimeFormat))
	w.Header().Set("ETag", fmt.Sprintf(`"f%d"`, f.ModifiedAt.UnixMilli()))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		w.Write(f.Data)
	}
}

type entry struct {
	name       string
	size       int64
	mod        time.Time
	etag       string
	ctype      string
	collection bool
}

func (h *Handler) libEntry(r *http.Request, lib *store.Library) (*entry, error) {
	f, err := h.Core.XBEL(r.Context(), lib)
	if err != nil {
		return nil, err
	}
	return &entry{name: lib.Slug + ".xbel", size: int64(len(f.Data)), mod: f.ModTime, etag: f.ETag, ctype: "application/xml; charset=utf-8"}, nil
}

func fileEntry(f *store.DavFile) *entry {
	ct := f.ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	return &entry{name: f.Name, size: f.Size, mod: f.ModifiedAt, etag: fmt.Sprintf(`"f%d"`, f.ModifiedAt.UnixMilli()), ctype: ct}
}

func (h *Handler) listing(r *http.Request, p *auth.Principal) ([]*entry, error) {
	ctx := r.Context()
	libs, err := store.ListLibraries(ctx, h.Core.DB, p.User.ID)
	if err != nil {
		return nil, err
	}
	var out []*entry
	for _, lib := range libs {
		e, err := h.libEntry(r, lib)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	files, err := store.ListDavFiles(ctx, h.Core.DB, p.User.ID)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		out = append(out, fileEntry(f))
	}
	return out, nil
}

func (h *Handler) propfind(w http.ResponseWriter, r *http.Request, p *auth.Principal, name string) {
	ctx := r.Context()
	io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
	var entries []*entry
	switch {
	case name == "":
		entries = append(entries, &entry{name: "", collection: true, mod: time.Now()})
		if r.Header.Get("Depth") != "0" {
			list, err := h.listing(r, p)
			if err != nil {
				h.fail(w, err)
				return
			}
			entries = append(entries, list...)
		}
	default:
		if slug, ok := libSlug(name); ok {
			lib, err := store.GetLibrary(ctx, h.Core.DB, p.User.ID, slug)
			if errors.Is(err, store.ErrNotFound) {
				text(w, http.StatusNotFound, "库 "+slug+" 不存在")
				return
			}
			if err != nil {
				h.fail(w, err)
				return
			}
			e, err := h.libEntry(r, lib)
			if err != nil {
				h.fail(w, err)
				return
			}
			entries = append(entries, e)
		} else {
			f, err := store.StatDavFile(ctx, h.Core.DB, p.User.ID, name)
			if errors.Is(err, store.ErrNotFound) {
				text(w, http.StatusNotFound, "文件不存在")
				return
			}
			if err != nil {
				h.fail(w, err)
				return
			}
			entries = append(entries, fileEntry(f))
		}
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>` + "\n")
	b.WriteString(`<D:multistatus xmlns:D="DAV:">` + "\n")
	for _, e := range entries {
		href := Prefix + url.PathEscape(e.name)
		b.WriteString("<D:response><D:href>" + html.EscapeString(href) + "</D:href><D:propstat><D:prop>")
		if e.collection {
			b.WriteString("<D:resourcetype><D:collection/></D:resourcetype><D:displayname>dav</D:displayname>")
			b.WriteString("<D:getlastmodified>" + e.mod.UTC().Format(http.TimeFormat) + "</D:getlastmodified>")
		} else {
			b.WriteString("<D:displayname>" + html.EscapeString(e.name) + "</D:displayname>")
			b.WriteString("<D:getcontentlength>" + strconv.FormatInt(e.size, 10) + "</D:getcontentlength>")
			b.WriteString("<D:getlastmodified>" + e.mod.UTC().Format(http.TimeFormat) + "</D:getlastmodified>")
			b.WriteString("<D:getetag>" + html.EscapeString(e.etag) + "</D:getetag>")
			b.WriteString("<D:getcontenttype>" + html.EscapeString(e.ctype) + "</D:getcontenttype>")
			b.WriteString("<D:resourcetype/>")
		}
		b.WriteString("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n")
	}
	b.WriteString("</D:multistatus>\n")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusMultiStatus)
	io.WriteString(w, b.String())
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	data, err := io.ReadAll(io.LimitReader(r.Body, core.MaxUpload+1))
	if err != nil {
		text(w, http.StatusBadRequest, "读取请求正文失败")
		return nil, false
	}
	if len(data) > core.MaxUpload {
		text(w, http.StatusRequestEntityTooLarge, "文件超过 32 MiB")
		return nil, false
	}
	return data, true
}

func (h *Handler) put(w http.ResponseWriter, r *http.Request, p *auth.Principal, name string) {
	if name == "" {
		w.Header().Set("Allow", allow)
		text(w, http.StatusMethodNotAllowed, "不能写入集合")
		return
	}
	data, ok := readBody(w, r)
	if !ok {
		return
	}
	if slug, ok := libSlug(name); ok {
		res, err := h.Core.ApplyUpload(r.Context(), p.User.ID, slug, data, h.actor(p))
		if err != nil {
			h.uploadError(w, err)
			return
		}
		if res.LibraryCreated {
			w.WriteHeader(http.StatusCreated)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}
	ctx := r.Context()
	now := h.Core.Now()
	tok := p.TokenID()
	f := &store.DavFile{UserID: p.User.ID, Name: name, Data: data, ContentType: r.Header.Get("Content-Type"), ModifiedAt: now, TokenID: &tok}
	if strings.HasSuffix(name, ".lock") {
		key := name
		if strings.HasSuffix(name, ".xbel.lock") {
			key = strings.TrimSuffix(name, ".xbel.lock")
		}
		unlock := h.Core.LockLibrary(p.User.ID, key)
		defer unlock()
		existing, err := store.StatDavFile(ctx, h.Core.DB, p.User.ID, name)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			h.fail(w, err)
			return
		}
		keep := false
		if existing != nil {
			fresh := now.Sub(existing.ModifiedAt) < core.LockTimeout
			same := existing.TokenID != nil && *existing.TokenID == tok
			if fresh && !same {
				holder := "其它设备"
				if existing.TokenID != nil {
					if t, err := store.GetToken(ctx, h.Core.DB, *existing.TokenID); err == nil {
						holder = t.Name
					}
				}
				text(w, http.StatusLocked, "已被 "+holder+" 锁定（"+existing.ModifiedAt.Format(time.RFC3339)+"）")
				return
			}
			keep = fresh && same
		}
		created, err := store.PutDavFile(ctx, h.Core.DB, f, keep)
		if err != nil {
			h.fail(w, err)
			return
		}
		if created {
			w.WriteHeader(http.StatusCreated)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}
	created, err := store.PutDavFile(ctx, h.Core.DB, f, true)
	if err != nil {
		h.fail(w, err)
		return
	}
	if created {
		w.WriteHeader(http.StatusCreated)
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *Handler) uploadError(w http.ResponseWriter, err error) {
	var ge *core.GuardedError
	var pe *xbel.ParseError
	switch {
	case errors.As(err, &ge):
		text(w, http.StatusPreconditionFailed, ge.Error())
	case errors.Is(err, xbel.ErrEncrypted), errors.Is(err, xbel.ErrHTML), errors.Is(err, xbel.ErrNotXBEL):
		text(w, http.StatusUnsupportedMediaType, err.Error())
	case errors.As(err, &pe):
		text(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, core.ErrNotFound):
		text(w, http.StatusNotFound, "库不存在，且服务端未开启自动建库（SHELFMARK_DAV_AUTO_CREATE）")
	default:
		h.fail(w, err)
	}
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request, p *auth.Principal, name string) {
	if name == "" {
		text(w, http.StatusForbidden, "不能删除集合")
		return
	}
	if _, ok := libSlug(name); ok {
		text(w, http.StatusForbidden, "库文件不能通过 WebDAV 删除，请在网页的库设置里删除")
		return
	}
	ctx := r.Context()
	if slug, isLock := strings.CutSuffix(name, ".xbel.lock"); isLock {
		unlock := h.Core.LockLibrary(p.User.ID, slug)
		defer unlock()
		existing, err := store.StatDavFile(ctx, h.Core.DB, p.User.ID, name)
		if errors.Is(err, store.ErrNotFound) {
			text(w, http.StatusNotFound, "文件不存在")
			return
		}
		if err != nil {
			h.fail(w, err)
			return
		}
		if _, err := store.DeleteDavFile(ctx, h.Core.DB, p.User.ID, name); err != nil {
			h.fail(w, err)
			return
		}
		// Floccus removes its lock when a sync finishes: record it as the last sync.
		if existing.TokenID != nil && *existing.TokenID == p.TokenID() {
			if lib, err := store.GetLibrary(ctx, h.Core.DB, p.User.ID, slug); err == nil {
				store.SetLibrarySync(ctx, h.Core.DB, lib.ID, p.ActorName(), h.Core.Now())
			}
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ok, err := store.DeleteDavFile(ctx, h.Core.DB, p.User.ID, name)
	if err != nil {
		h.fail(w, err)
		return
	}
	if !ok {
		text(w, http.StatusNotFound, "文件不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// destinationName extracts the flat file name from a Destination header.
// Only the path counts: behind proxies the host often differs from Host.
func destinationName(dest string) (string, int, string) {
	if dest == "" {
		return "", http.StatusBadRequest, "缺少 Destination 头"
	}
	u, err := url.Parse(dest)
	if err != nil {
		return "", http.StatusBadRequest, "Destination 头无效"
	}
	p := u.Path
	var rest string
	switch {
	case strings.HasPrefix(p, Prefix):
		rest = p[len(Prefix):]
	case strings.Contains(p, Prefix):
		rest = p[strings.LastIndex(p, Prefix)+len(Prefix):]
	default:
		return "", http.StatusBadRequest, "Destination 不在 /dav/ 下"
	}
	if rest == "" || strings.Contains(rest, "/") {
		return "", http.StatusNotFound, "不支持子目录：目标只能是 /dav/ 下的扁平文件名"
	}
	return rest, 0, ""
}

func (h *Handler) move(w http.ResponseWriter, r *http.Request, p *auth.Principal, name string) {
	ctx := r.Context()
	if name == "" {
		text(w, http.StatusForbidden, "不能移动集合")
		return
	}
	if _, ok := libSlug(name); ok {
		text(w, http.StatusForbidden, "不支持移动库文件")
		return
	}
	dest, status, msg := destinationName(r.Header.Get("Destination"))
	if status != 0 {
		text(w, status, msg)
		return
	}
	if dest == name {
		text(w, http.StatusForbidden, "源和目标相同")
		return
	}
	overwrite := !strings.EqualFold(strings.TrimSpace(r.Header.Get("Overwrite")), "F")
	src, err := store.GetDavFile(ctx, h.Core.DB, p.User.ID, name)
	if errors.Is(err, store.ErrNotFound) {
		text(w, http.StatusNotFound, "源文件不存在")
		return
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	if slug, ok := libSlug(dest); ok {
		if !overwrite {
			if _, err := store.GetLibrary(ctx, h.Core.DB, p.User.ID, slug); err == nil {
				text(w, http.StatusPreconditionFailed, "目标已存在且 Overwrite: F")
				return
			}
		}
		res, err := h.Core.ApplyUpload(ctx, p.User.ID, slug, src.Data, h.actor(p))
		if err != nil {
			h.uploadError(w, err)
			return
		}
		if _, err := store.DeleteDavFile(ctx, h.Core.DB, p.User.ID, name); err != nil {
			h.fail(w, err)
			return
		}
		if res.LibraryCreated {
			w.WriteHeader(http.StatusCreated)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}
	_, err = store.StatDavFile(ctx, h.Core.DB, p.User.ID, dest)
	exists := err == nil
	if exists && !overwrite {
		text(w, http.StatusPreconditionFailed, "目标已存在且 Overwrite: F")
		return
	}
	if err := store.RenameDavFile(ctx, h.Core.DB, p.User.ID, name, dest, h.Core.Now()); err != nil {
		h.fail(w, err)
		return
	}
	if exists {
		w.WriteHeader(http.StatusNoContent)
	} else {
		w.WriteHeader(http.StatusCreated)
	}
}

func (h *Handler) fail(w http.ResponseWriter, err error) {
	h.Log.Error("dav", "err", err)
	text(w, http.StatusInternalServerError, "服务器内部错误")
}
