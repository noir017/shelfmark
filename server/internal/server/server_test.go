package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"shelfmark/internal/auth"
	"shelfmark/internal/config"
	"shelfmark/internal/store"
)

func init() { auth.Argon2Params.Memory = 1024 }

type env struct {
	t        *testing.T
	srv      *Server
	ts       *httptest.Server
	client   *http.Client
	davToken string
	apiToken string
	contract *contract
}

type resp struct {
	status int
	header http.Header
	body   []byte
}

func (r resp) json(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("json: %v\n%s", err, r.body)
	}
}

func newEnv(t *testing.T, mutate func(*config.Config)) *env {
	t.Helper()
	cfg := config.Default()
	cfg.DataDir = t.TempDir()
	cfg.FetchMetadata = false
	cfg.LinkcheckInterval = 0
	cfg.Metrics = true
	if mutate != nil {
		mutate(cfg)
	}
	db, err := store.Open(filepath.Join(cfg.DataDir, "shelfmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	static := fstest.MapFS{"index.html": {Data: []byte("<!doctype html>app")}, "downloads/ext.zip": {Data: []byte("zip")}, "assets/a.js": {Data: []byte("js")}}
	srv, err := NewWithDB(cfg, log, db, static)
	if err != nil {
		t.Fatal(err)
	}
	srv.Core.LockWait = 300 * time.Millisecond
	srv.Core.LockPoll = 50 * time.Millisecond
	ts := httptest.NewServer(srv.Handler)
	jar, _ := cookiejar.New(nil)
	e := &env{t: t, srv: srv, ts: ts, client: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	e.contract = loadContract(t)
	t.Cleanup(func() {
		ts.Close()
		srv.Close()
	})
	return e
}

// do sends a request; web=true adds the CSRF header used by the web app.
func (e *env) do(method, path string, body any, headers map[string]string) resp {
	e.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	case string:
		rd = strings.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
	if body != nil {
		if _, isBytes := body.([]byte); !isBytes {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := e.client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	r := resp{status: res.StatusCode, header: res.Header, body: raw}
	if strings.HasPrefix(path, "/api/") {
		e.contract.check(e.t, req, r)
	}
	return r
}

var web = map[string]string{"X-Requested-With": "shelfmark"}

func (e *env) api(method, path string, body any) resp {
	e.t.Helper()
	return e.do(method, path, body, web)
}

func (e *env) expect(r resp, status int) resp {
	e.t.Helper()
	if r.status != status {
		e.t.Fatalf("status %d, want %d: %s", r.status, status, r.body)
	}
	return r
}

func (e *env) dav(method, name string, body []byte, headers map[string]string) resp {
	e.t.Helper()
	h := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:"+e.davToken))}
	for k, v := range headers {
		h[k] = v
	}
	if body == nil {
		body = []byte{}
	}
	return e.do(method, "/dav/"+name, body, h)
}

// setup creates alice (admin, logged in) plus a dav and an api token.
func (e *env) setup() {
	e.t.Helper()
	e.expect(e.api("POST", "/api/v1/setup", map[string]string{"username": "alice", "password": "correct horse"}), 201)
	var tok struct{ Token string }
	e.expect(e.api("POST", "/api/v1/tokens", map[string]any{"name": "laptop", "scopes": []string{"dav"}}), 201).json(e.t, &tok)
	e.davToken = tok.Token
	e.expect(e.api("POST", "/api/v1/tokens", map[string]any{"name": "script", "scopes": []string{"api"}}), 201).json(e.t, &tok)
	e.apiToken = tok.Token
}

func xbelDoc(highest int, body string) []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">
<xbel version="1.0">
<!--- highestId :` + strconv.Itoa(highest) + `: for Floccus bookmark sync browser extension -->
` + body + `
</xbel>`)
}

func bookmarks(from, to int) string {
	var b strings.Builder
	for i := from; i <= to; i++ {
		fmt.Fprintf(&b, "\n<bookmark href=\"https://example.com/%d\" id=\"%d\">\n  <title>B%d</title>\n</bookmark>", i, i, i)
	}
	return b.String()
}

var lengthRe = regexp.MustCompile(`<.*?:?getcontentlength[^>]*?>(.*?)<`)

// propfindSize is Floccus' getFileSizeWeb.
func propfindSize(t *testing.T, r resp) int {
	t.Helper()
	m := lengthRe.FindSubmatch(r.body)
	if r.status != 207 || m == nil {
		t.Fatalf("PROPFIND %d: %s", r.status, r.body)
	}
	n, _ := strconv.Atoi(string(m[1]))
	return n
}

func TestFloccusBrowserSync(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	// 1. lock
	e.expect(e.dav("GET", "bookmarks.xbel.lock", nil, nil), 404)
	e.expect(e.dav("PUT", "bookmarks.xbel.lock", []byte("<html><body>I am a lock file</body></html>"), map[string]string{"Content-Type": "text/html"}), 201)
	r := e.expect(e.dav("GET", "bookmarks.xbel.lock", nil, nil), 200)
	if lm, err := http.ParseTime(r.header.Get("Last-Modified")); err != nil || time.Since(lm) > time.Minute {
		t.Fatalf("lock Last-Modified %q", r.header.Get("Last-Modified"))
	}
	// 2. GET + PROPFIND agree; body has the literal header and highestId line
	r = e.expect(e.dav("GET", "bookmarks.xbel", nil, nil), 200)
	if !bytes.Contains(r.body, []byte(`<?xml version="1.0" encoding="UTF-8"?>`)) || !bytes.Contains(r.body, []byte("<!--- highestId :0:")) {
		t.Fatalf("body %s", r.body)
	}
	if r.header.Get("Cache-Control") != "no-store" || r.header.Get("ETag") != `"r0-0"` {
		t.Fatalf("headers %v", r.header)
	}
	if n := propfindSize(t, e.dav("PROPFIND", "bookmarks.xbel", nil, map[string]string{"Depth": "0"})); n != len(r.body) {
		t.Fatalf("PROPFIND %d != GET %d", n, len(r.body))
	}
	// 3. renew lock (same token)
	e.expect(e.dav("PUT", "bookmarks.xbel.lock", []byte("lock"), nil), 204)
	// 4. upload: PUT temp -> PROPFIND temp -> MOVE -> PROPFIND file
	doc := xbelDoc(3, `
<bookmark href="https://example.com/" id="1">
  <title>Example</title>
</bookmark>
<folder id="2">
  <title>工具</title>
  <bookmark href="https://example.org/" id="3">
    <title>Org</title>
  </bookmark>
</folder>`)
	e.expect(e.dav("PUT", "bookmarks.xbel.temp", doc, map[string]string{"Content-Type": "application/xml"}), 201)
	if n := propfindSize(t, e.dav("PROPFIND", "bookmarks.xbel.temp", nil, map[string]string{"Depth": "0"})); n != len(doc) {
		t.Fatalf("temp size %d != %d", n, len(doc))
	}
	// Destination host differs from the request host (proxies): only the path counts
	e.expect(e.dav("MOVE", "bookmarks.xbel.temp", nil, map[string]string{"Destination": "https://bm.example.com/dav/bookmarks.xbel", "Overwrite": "T"}), 204)
	e.expect(e.dav("GET", "bookmarks.xbel.temp", nil, nil), 404)
	r = e.expect(e.dav("GET", "bookmarks.xbel", nil, nil), 200)
	if !bytes.Equal(r.body, doc) {
		t.Fatalf("server file differs from Floccus upload\n%s\n---\n%s", r.body, doc)
	}
	if n := propfindSize(t, e.dav("PROPFIND", "bookmarks.xbel", nil, map[string]string{"Depth": "0"})); n != len(r.body) {
		t.Fatalf("PROPFIND after move %d != %d", n, len(r.body))
	}
	// 5. unlock
	e.expect(e.dav("DELETE", "bookmarks.xbel.lock", nil, nil), 204)
	e.expect(e.dav("DELETE", "bookmarks.xbel.lock", nil, nil), 404)
	// the web sees the tree, a revision and the last sync
	var tree struct {
		Revision int64
		Children []struct {
			ID    int64
			Title string
		}
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/tree", nil), 200).json(t, &tree)
	if tree.Revision != 1 || len(tree.Children) != 2 || tree.Children[1].Title != "工具" {
		t.Fatalf("tree %+v", tree)
	}
	var lib struct {
		LastSyncActor *string
		BookmarkCount int
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks", nil), 200).json(t, &lib)
	if lib.LastSyncActor == nil || *lib.LastSyncActor != "laptop" || lib.BookmarkCount != 2 {
		t.Fatalf("library %+v", lib)
	}
	// unchanged re-upload creates no revision
	e.expect(e.dav("PUT", "bookmarks.xbel", doc, nil), 204)
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/tree", nil), 200).json(t, &tree)
	if tree.Revision != 1 {
		t.Fatalf("unchanged upload made revision %d", tree.Revision)
	}
	// Overwrite: F onto an existing library -> 412
	e.expect(e.dav("PUT", "x.temp", doc, nil), 201)
	e.expect(e.dav("MOVE", "x.temp", nil, map[string]string{"Destination": e.ts.URL + "/dav/bookmarks.xbel", "Overwrite": "F"}), 412)
	// subdirectories are rejected
	e.expect(e.dav("MOVE", "x.temp", nil, map[string]string{"Destination": "http://other.example.com/dav/sub/bookmarks.xbel"}), 404)
	e.expect(e.dav("GET", "sub/x", nil, nil), 404)
}

func TestFloccusNativeAndErrors(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	// native app: PUT the file directly (auto-creates the library), then HEAD
	doc := xbelDoc(5, bookmarks(1, 5))
	e.expect(e.dav("PUT", "work.xbel", doc, nil), 201)
	h := e.expect(e.dav("HEAD", "work.xbel", nil, nil), 200)
	if h.header.Get("Content-Length") != strconv.Itoa(len(doc)) || len(h.body) != 0 {
		t.Fatalf("HEAD %v", h.header)
	}
	// DELETE of a library file is refused
	e.expect(e.dav("DELETE", "work.xbel", nil, nil), 403)
	// encrypted, HTML and garbage bodies
	e.expect(e.dav("PUT", "work.xbel", []byte(`{"ciphertext":"abc","salt":"00"}`), nil), 415)
	e.expect(e.dav("PUT", "work.xbel", []byte("<!DOCTYPE NETSCAPE-Bookmark-file-1><DL></DL>"), nil), 415)
	e.expect(e.dav("PUT", "work.xbel", []byte("U2FsdGVkX1+cipher"), nil), 415)
	e.expect(e.dav("PUT", "work.xbel", xbelDoc(1, `<bookmark href="a" id="1"/><bookmark href="b" id="1"/>`), nil), 400)
	// OPTIONS, unsupported methods, auth
	o := e.do("OPTIONS", "/dav/", nil, nil)
	if o.status != 200 || o.header.Get("DAV") != "1" || !strings.Contains(o.header.Get("Allow"), "PROPFIND") {
		t.Fatalf("OPTIONS %d %v", o.status, o.header)
	}
	e.expect(e.dav("MKCOL", "dir", nil, nil), 405)
	e.expect(e.dav("LOCK", "work.xbel", nil, nil), 405)
	bad := e.do("GET", "/dav/work.xbel", nil, map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:"+e.apiToken))})
	if bad.status != 401 || bad.header.Get("WWW-Authenticate") != `Basic realm="shelfmark"` {
		t.Fatalf("api token on dav: %d", bad.status)
	}
	// collection listing
	r := e.expect(e.dav("PROPFIND", "", nil, map[string]string{"Depth": "1"}), 207)
	if !bytes.Contains(r.body, []byte("/dav/work.xbel")) || !bytes.Contains(r.body, []byte("/dav/bookmarks.xbel")) {
		t.Fatalf("listing %s", r.body)
	}
}

func TestFloccusLockContention(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	var other struct{ Token string }
	e.expect(e.api("POST", "/api/v1/tokens", map[string]any{"name": "phone", "scopes": []string{"dav"}}), 201).json(t, &other)
	e.expect(e.dav("PUT", "bookmarks.xbel.lock", []byte("lock"), nil), 201)
	phone := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:"+other.Token))}
	e.expect(e.do("PUT", "/dav/bookmarks.xbel.lock", []byte("lock"), phone), 423)
	// the web waits, then gives up with 423 + Retry-After and the device name
	r := e.expect(e.api("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "bookmark", "title": "x", "url": "https://example.com/x"}), 423)
	if r.header.Get("Retry-After") != "5" || !bytes.Contains(r.body, []byte(`"actor":"laptop"`)) {
		t.Fatalf("locked %v %s", r.header, r.body)
	}
	var lib struct {
		Lock *struct {
			Actor string
			Fresh bool
		}
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks", nil), 200).json(t, &lib)
	if lib.Lock == nil || !lib.Lock.Fresh || lib.Lock.Actor != "laptop" {
		t.Fatalf("lock info %+v", lib.Lock)
	}
	// force unlock from the web
	e.expect(e.api("POST", "/api/v1/libraries/bookmarks/lock/release", nil), 204)
	e.expect(e.api("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "bookmark", "title": "x", "url": "https://example.com/x"}), 201)
	e.expect(e.do("PUT", "/dav/bookmarks.xbel.lock", []byte("lock"), phone), 201)
	// a stale lock (older than 15 minutes) can be taken over
	_, err := e.srv.DB.Exec(`UPDATE dav_files SET modified_at = ? WHERE name = 'bookmarks.xbel.lock'`, store.TS(time.Now().Add(-16*time.Minute)))
	if err != nil {
		t.Fatal(err)
	}
	e.expect(e.dav("PUT", "bookmarks.xbel.lock", []byte("lock"), nil), 204)
}

func TestGuardAndApprove(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	full := xbelDoc(30, bookmarks(1, 30))
	e.expect(e.dav("PUT", "bookmarks.xbel", full, nil), 204)
	// a browser that lost most bookmarks: 20 of 30 removed -> intercepted
	shrunk := xbelDoc(30, bookmarks(1, 10))
	r := e.expect(e.dav("PUT", "bookmarks.xbel.temp", shrunk, nil), 201)
	r = e.expect(e.dav("MOVE", "bookmarks.xbel.temp", nil, map[string]string{"Destination": "https://bm.example.com/dav/bookmarks.xbel", "Overwrite": "T"}), 412)
	if !strings.Contains(string(r.body), "删除 20 个书签") || !strings.HasPrefix(r.header.Get("Content-Type"), "text/plain") {
		t.Fatalf("guard body %s", r.body)
	}
	g := e.expect(e.dav("GET", "bookmarks.xbel", nil, nil), 200)
	if !bytes.Equal(g.body, full) {
		t.Fatal("guarded upload was applied")
	}
	var pending []struct {
		ID      int64
		Removed int
		Actor   string
	}
	e.expect(e.api("GET", "/api/v1/pending", nil), 200).json(t, &pending)
	if len(pending) != 1 || pending[0].Removed != 20 || pending[0].Actor != "laptop" {
		t.Fatalf("pending %+v", pending)
	}
	var detail struct {
		Diff struct{ Removed []any }
	}
	e.expect(e.api("GET", fmt.Sprintf("/api/v1/libraries/bookmarks/pending/%d", pending[0].ID), nil), 200).json(t, &detail)
	if len(detail.Diff.Removed) != 20 {
		t.Fatalf("diff removed %d", len(detail.Diff.Removed))
	}
	var wr struct{ Revision int64 }
	e.expect(e.api("POST", fmt.Sprintf("/api/v1/libraries/bookmarks/pending/%d/approve", pending[0].ID), nil), 200).json(t, &wr)
	g = e.expect(e.dav("GET", "bookmarks.xbel", nil, nil), 200)
	if !bytes.Equal(g.body, shrunk) {
		t.Fatalf("approved file differs\n%s", g.body)
	}
	var revs struct {
		Items []struct {
			Source, Actor string
			Removed       int
		}
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/revisions", nil), 200).json(t, &revs)
	if revs.Items[0].Actor != "laptop（已确认）" || revs.Items[0].Source != "webdav" || revs.Items[0].Removed != 20 {
		t.Fatalf("revision %+v", revs.Items[0])
	}
	// recently deleted -> restore with new ids
	var deleted []struct {
		Revision int64
		Item     struct{ ID int64 }
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/deleted", nil), 200).json(t, &deleted)
	if len(deleted) != 20 {
		t.Fatalf("deleted %d", len(deleted))
	}
	var restored struct{ Restored int }
	e.expect(e.api("POST", "/api/v1/libraries/bookmarks/deleted/restore", map[string]any{"entries": []map[string]int64{{"revision": deleted[0].Revision, "itemId": deleted[0].Item.ID}}}), 200).json(t, &restored)
	if restored.Restored != 1 {
		t.Fatalf("restored %d", restored.Restored)
	}
	// ratio 0 disables the guard
	e.srv.Cfg.GuardRatio = 0
	e.expect(e.dav("PUT", "bookmarks.xbel", xbelDoc(40, ""), nil), 204)
}

func TestWebFlowRevisionsAndRestore(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	// CSRF: missing header and foreign origin are refused for cookie sessions
	e.expect(e.do("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "folder", "title": "x"}, nil), 403)
	e.expect(e.do("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "folder", "title": "x"},
		map[string]string{"X-Requested-With": "shelfmark", "Origin": "https://evil.example.com"}), 403)
	// Bearer requests from the extension carry chrome-extension:// origins and are fine
	ext := map[string]string{"Authorization": "Bearer " + e.apiToken, "Origin": "chrome-extension://abcdef"}
	var folder struct {
		Revision int64
		Item     struct{ ID int64 }
	}
	e.expect(e.do("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "folder", "title": "工具"}, ext), 201).json(t, &folder)
	var bm struct {
		Revision int64
		Item     struct {
			ID    int64
			Title string
		}
	}
	e.expect(e.api("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "bookmark", "title": "Go", "url": "https://go.dev/", "parentId": folder.Item.ID, "tags": []string{"golang"}, "notes": "docs"}), 201).json(t, &bm)
	// consecutive web edits within 120s merge into one revision; the ETag still changes
	etag := e.expect(e.api("GET", "/api/v1/libraries/bookmarks/tree", nil), 200).header.Get("ETag")
	var patched struct{ Revision int64 }
	e.expect(e.api("PATCH", fmt.Sprintf("/api/v1/libraries/bookmarks/items/%d", bm.Item.ID), map[string]any{"title": "Go 官网"}), 200).json(t, &patched)
	if patched.Revision != bm.Revision {
		t.Fatalf("merged edit changed revision %d -> %d", bm.Revision, patched.Revision)
	}
	if r := e.do("GET", "/api/v1/libraries/bookmarks/tree", nil, map[string]string{"If-None-Match": etag}); r.status != 200 || r.header.Get("ETag") == etag {
		t.Fatalf("stale ETag after merged edit: %d %s", r.status, r.header.Get("ETag"))
	}
	var revs struct {
		Items []struct {
			Rev    int64
			Source string
			Added  int
		}
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/revisions", nil), 200).json(t, &revs)
	if len(revs.Items) != 2 || revs.Items[0].Source != "web" || revs.Items[1].Source != "extension" || revs.Items[0].Added != 1 {
		t.Fatalf("revisions %+v", revs.Items)
	}
	// ETag on the tree
	tr := e.expect(e.api("GET", "/api/v1/libraries/bookmarks/tree", nil), 200)
	e.expect(e.do("GET", "/api/v1/libraries/bookmarks/tree", nil, map[string]string{"If-None-Match": tr.header.Get("ETag")}), 304)
	// search, lookup, quick-save dedupe
	var sr struct{ Total int }
	e.expect(e.api("GET", "/api/v1/search?q="+"%23golang%20in:工具", nil), 200).json(t, &sr)
	if sr.Total != 1 {
		t.Fatalf("search total %d", sr.Total)
	}
	var lk struct{ Matches []any }
	e.expect(e.api("GET", "/api/v1/lookup?url=https://GO.dev/?utm_source=x", nil), 200).json(t, &lk)
	if len(lk.Matches) != 1 {
		t.Fatalf("lookup %+v", lk)
	}
	var qs struct {
		Existed bool
		Item    struct{ Title string }
	}
	e.expect(e.do("POST", "/api/v1/quick-save", map[string]any{"url": "https://go.dev", "title": "changed"}, ext), 200).json(t, &qs)
	if !qs.Existed || qs.Item.Title != "Go 官网" {
		t.Fatalf("quick-save %+v", qs)
	}
	e.expect(e.do("POST", "/api/v1/quick-save", map[string]any{"url": "https://example.com/new", "title": "New", "tags": []string{"later"}}, ext), 201).json(t, &qs)
	// delete the folder, then roll back to the revision before
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/revisions", nil), 200).json(t, &revs)
	before := revs.Items[0].Rev
	e.expect(e.api("DELETE", fmt.Sprintf("/api/v1/libraries/bookmarks/items/%d", folder.Item.ID), nil), 200)
	var detail struct {
		Diff struct {
			Removed []struct {
				Title      string
				ChildCount int
			}
		}
	}
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/revisions", nil), 200).json(t, &revs)
	e.expect(e.api("GET", fmt.Sprintf("/api/v1/libraries/bookmarks/revisions/%d", revs.Items[0].Rev), nil), 200).json(t, &detail)
	if len(detail.Diff.Removed) != 1 || detail.Diff.Removed[0].ChildCount != 1 {
		t.Fatalf("diff %+v", detail.Diff)
	}
	e.expect(e.api("POST", fmt.Sprintf("/api/v1/libraries/bookmarks/revisions/%d/restore", before), nil), 200)
	var item struct {
		Item struct {
			Notes *string
			Tags  []string
		}
		Path []string
	}
	e.expect(e.api("GET", fmt.Sprintf("/api/v1/libraries/bookmarks/items/%d", bm.Item.ID), nil), 200).json(t, &item)
	if item.Item.Notes == nil || *item.Item.Notes != "docs" || len(item.Item.Tags) != 1 || item.Path[0] != "工具" {
		t.Fatalf("restored item %+v", item)
	}
	// exports
	x := e.expect(e.api("GET", "/api/v1/libraries/bookmarks/export?format=xbel", nil), 200)
	if !bytes.Contains(x.body, []byte("<title>Go 官网</title>")) || !strings.Contains(x.header.Get("Content-Disposition"), "bookmarks-") {
		t.Fatalf("export %s", x.body)
	}
	e.expect(e.api("GET", fmt.Sprintf("/api/v1/libraries/bookmarks/revisions/%d/export?format=json", before), nil), 200)
	// tags, settings, jobs, misc
	e.expect(e.api("PATCH", "/api/v1/tags/golang", map[string]string{"name": "go"}), 204)
	e.expect(e.api("GET", "/api/v1/tags", nil), 200)
	e.expect(e.api("PATCH", "/api/v1/settings", map[string]any{"theme": "dark", "defaultSave": map[string]any{"library": "bookmarks", "folderId": folder.Item.ID}}), 200)
	e.expect(e.api("PATCH", "/api/v1/settings", map[string]any{"theme": "neon"}), 422)
	e.expect(e.api("GET", "/api/v1/settings", nil), 200)
	e.expect(e.api("GET", "/api/v1/jobs", nil), 200)
	e.expect(e.api("POST", "/api/v1/jobs/cleanup/run", nil), 202)
	e.expect(e.api("GET", "/api/v1/reports/duplicates", nil), 200)
	e.expect(e.api("GET", "/api/v1/reports/broken", nil), 200)
	e.expect(e.api("GET", "/api/v1/recent?limit=5", nil), 200)
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/frequent", nil), 200)
	e.expect(e.api("GET", "/api/v1/ai/status", nil), 200)
	e.expect(e.api("POST", "/api/v1/ai/suggest", map[string]any{"library": "bookmarks", "url": "https://example.com"}), 503)
	e.expect(e.api("GET", "/api/v1/system/info", nil), 200)
	e.expect(e.api("GET", "/api/v1/auth/me", nil), 200)
	e.expect(e.api("GET", "/api/v1/libraries", nil), 200)
	e.expect(e.api("GET", "/api/v1/tokens", nil), 200)
	e.expect(e.api("GET", "/api/v1/users", nil), 200)
	e.expect(e.api("GET", "/api/v1/nope", nil), 404)
	// static: SPA fallback, downloads, ops endpoints
	if r := e.do("GET", "/lib/bookmarks/f/3", nil, nil); r.status != 200 || string(r.body) != "<!doctype html>app" || r.header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("spa %d %s", r.status, r.body)
	}
	e.expect(e.do("GET", "/downloads/ext.zip", nil, nil), 200)
	e.expect(e.do("GET", "/downloads/missing.zip", nil, nil), 404)
	if r := e.do("GET", "/healthz", nil, nil); !strings.HasPrefix(string(r.body), "ok ") {
		t.Fatalf("healthz %s", r.body)
	}
	if r := e.do("GET", "/metrics", nil, nil); !bytes.Contains(r.body, []byte(`shelfmark_library_bookmarks{user="alice",library="bookmarks"} 2`)) {
		t.Fatalf("metrics %s", r.body)
	}
	// logout
	e.expect(e.api("POST", "/api/v1/auth/logout", nil), 204)
	e.expect(e.api("GET", "/api/v1/auth/me", nil), 401)
}

func TestTransfer(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	e.expect(e.api("POST", "/api/v1/libraries", map[string]string{"slug": "work", "name": "工作"}), 201)
	var f, b struct{ Item struct{ ID int64 } }
	e.expect(e.api("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "folder", "title": "Dev"}), 201).json(t, &f)
	e.expect(e.api("POST", "/api/v1/libraries/bookmarks/items", map[string]any{"type": "bookmark", "title": "Go", "url": "https://go.dev/", "parentId": f.Item.ID, "tags": []string{"go"}, "notes": "n"}), 201).json(t, &b)
	e.expect(e.api("POST", "/api/v1/visits", map[string]any{"library": "bookmarks", "itemId": b.Item.ID}), 204)
	e.srv.DB.Exec(`UPDATE item_meta SET health_status = 'ok', favicon_id = '0123456789abcdef0123456789abcdef' WHERE item_id = ?`, b.Item.ID)
	var res struct {
		Revision, SourceRevision int64
		Item                     struct {
			ID    int64
			Title string
		}
	}
	e.expect(e.api("POST", fmt.Sprintf("/api/v1/libraries/bookmarks/items/%d/transfer", f.Item.ID), map[string]any{"library": "work", "parentId": 0}), 200).json(t, &res)
	if res.Item.Title != "Dev" || res.Revision != 1 || res.SourceRevision < 2 {
		t.Fatalf("transfer %+v", res)
	}
	var tree struct {
		Children []struct {
			Children []struct {
				ID         int64
				Tags       []string
				Notes      *string
				VisitCount int
				FaviconID  *string
				Health     *struct{ Status string }
			}
		}
	}
	e.expect(e.api("GET", "/api/v1/libraries/work/tree", nil), 200).json(t, &tree)
	moved := tree.Children[0].Children[0]
	if moved.VisitCount != 1 || moved.Notes == nil || len(moved.Tags) != 1 || moved.FaviconID == nil || moved.Health == nil || moved.Health.Status != "ok" {
		t.Fatalf("metadata lost %+v", moved)
	}
	var src struct{ Children []any }
	e.expect(e.api("GET", "/api/v1/libraries/bookmarks/tree", nil), 200).json(t, &src)
	if len(src.Children) != 0 {
		t.Fatal("source still has the folder")
	}
	e.expect(e.api("POST", fmt.Sprintf("/api/v1/libraries/work/items/%d/transfer", res.Item.ID), map[string]any{"library": "work", "parentId": 0}), 422)
	e.expect(e.api("POST", fmt.Sprintf("/api/v1/libraries/work/items/%d/transfer", res.Item.ID), map[string]any{"library": "bookmarks", "parentId": 999}), 422)
}

func TestLoginRateLimitAndTokens(t *testing.T) {
	e := newEnv(t, nil)
	e.setup()
	for i := 0; i < 10; i++ {
		e.expect(e.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "wrong password"}, nil), 401)
	}
	r := e.expect(e.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "correct horse"}, nil), 429)
	if r.header.Get("Retry-After") == "" {
		t.Fatal("Retry-After missing")
	}
	e.srv.Auth.Limiter = auth.NewLimiter()
	// the extension's login: chrome-extension origin, no cookie
	var tok struct{ Token string }
	e.expect(e.do("POST", "/api/v1/auth/token", map[string]any{"username": "alice", "password": "correct horse", "name": "插件 · Chrome · Linux", "scopes": []string{"api"}},
		map[string]string{"Origin": "chrome-extension://abc"}), 201).json(t, &tok)
	var me struct{ AuthMethod string }
	e.expect(e.do("GET", "/api/v1/auth/me", nil, map[string]string{"Authorization": "Bearer " + tok.Token}), 200).json(t, &me)
	if me.AuthMethod != "token" {
		t.Fatalf("method %s", me.AuthMethod)
	}
	// Floccus setup returns an importable profile array
	var fs struct {
		DavURL  string
		Profile []map[string]any
	}
	e.expect(e.api("POST", "/api/v1/floccus/setup", map[string]string{"library": "bookmarks", "deviceName": "Firefox"}), 201).json(t, &fs)
	if fs.DavURL != e.ts.URL+"/dav/" || fs.Profile[0]["type"] != "webdav" || fs.Profile[0]["bookmark_file"] != "bookmarks.xbel" {
		t.Fatalf("floccus %+v", fs)
	}
	e.expect(e.do("GET", "/dav/bookmarks.xbel", nil, map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:"+fs.Profile[0]["password"].(string)))}), 200)
	// password change with the CSRF header
	e.expect(e.api("POST", "/api/v1/auth/password", map[string]string{"currentPassword": "correct horse", "newPassword": "battery staple"}), 204)
	e.expect(e.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "battery staple"}, nil), 200)
	_ = context.Background
}
