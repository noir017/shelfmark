package api

import (
	"fmt"
	"net/http"
	"strconv"

	"shelfmark/internal/auth"
	"shelfmark/internal/core"
	"shelfmark/internal/importexport"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
)

type revisionJSON struct {
	Rev            int64  `json:"rev"`
	CreatedAt      string `json:"createdAt"`
	Source         string `json:"source"`
	Actor          string `json:"actor"`
	Added          int    `json:"added"`
	Removed        int    `json:"removed"`
	Changed        int    `json:"changed"`
	Moved          int    `json:"moved"`
	TotalBookmarks int    `json:"totalBookmarks"`
}

func toRevision(r *store.Revision) revisionJSON {
	return revisionJSON{Rev: r.Rev, CreatedAt: ts(r.CreatedAt), Source: r.Source, Actor: r.Actor, Added: r.Added, Removed: r.Removed,
		Changed: r.Changed, Moved: r.Moved, TotalBookmarks: r.TotalBookmarks}
}

func (a *API) listRevisions(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	limit, err := queryInt(r, "limit", 50, 1, 200)
	if err != nil {
		return err
	}
	var before int64
	if s := r.URL.Query().Get("before"); s != "" {
		if before, err = strconv.ParseInt(s, 10, 64); err != nil {
			return validation("before", "before 必须是整数")
		}
	}
	revs, err := store.ListRevisions(r.Context(), a.DB, lib.ID, before, limit+1)
	if err != nil {
		return err
	}
	var next *int64
	if len(revs) > limit {
		revs = revs[:limit]
		n := revs[len(revs)-1].Rev
		next = &n
	}
	items := []revisionJSON{}
	for _, rv := range revs {
		items = append(items, toRevision(rv))
	}
	writeJSON(w, 200, map[string]any{"items": items, "nextBefore": next})
	return nil
}

func (a *API) getRevision(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	rev, err := pathInt(r, "rev")
	if err != nil {
		return err
	}
	rv, d, err := a.Core.RevisionDiff(r.Context(), lib.ID, rev)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": toRevision(rv), "diff": d})
	return nil
}

func (a *API) exportRevision(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	rev, err := pathInt(r, "rev")
	if err != nil {
		return err
	}
	rv, t, err := a.Core.RevisionTree(r.Context(), lib.ID, rev)
	if err != nil {
		return err
	}
	return sendExport(w, importexport.ExportInput{Slug: lib.Slug, Name: lib.Name, Revision: rv.Rev, Tree: t, Now: a.Core.Now()},
		r.URL.Query().Get("format"), fmt.Sprintf("%s-r%d", lib.Slug, rv.Rev))
}

func (a *API) restoreRevision(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	rev, err := pathInt(r, "rev")
	if err != nil {
		return err
	}
	res, err := a.Core.RestoreRevision(r.Context(), lib, rev, a.actor(r, p))
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": res.Revision})
	return nil
}

func (a *API) listDeleted(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	days, err := queryInt(r, "days", 30, 1, 365)
	if err != nil {
		return err
	}
	entries, err := a.Core.ListDeleted(r.Context(), lib, days)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, e := range entries {
		out = append(out, map[string]any{"revision": e.Revision, "deletedAt": ts(e.DeletedAt), "source": e.Source, "actor": e.Actor, "item": e.Item})
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) restoreDeleted(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	var body struct {
		Entries []struct {
			Revision int64 `json:"revision"`
			ItemID   int64 `json:"itemId"`
		} `json:"entries"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if len(body.Entries) == 0 || len(body.Entries) > 1000 {
		return validation("entries", "entries 需要 1–1000 项")
	}
	var entries []core.RestoreEntry
	for _, e := range body.Entries {
		entries = append(entries, core.RestoreEntry{Revision: e.Revision, ItemID: e.ItemID})
	}
	res, n, err := a.Core.RestoreDeleted(r.Context(), lib, entries, a.actor(r, p))
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": res.Revision, "restored": n})
	return nil
}

func toPending(pd *store.Pending) map[string]any {
	return map[string]any{"id": pd.ID, "library": pd.LibrarySlug, "createdAt": ts(pd.CreatedAt), "actor": pd.Actor, "added": pd.Added,
		"removed": pd.Removed, "changed": pd.Changed, "moved": pd.Moved, "totalBefore": pd.TotalBefore, "reason": pd.Reason}
}

func (a *API) listPending(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	list, err := store.ListPending(r.Context(), a.DB, p.User.ID)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, pd := range list {
		out = append(out, toPending(pd))
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) getPending(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "pendingId")
	if err != nil {
		return err
	}
	pd, d, err := a.Core.PendingDetail(r.Context(), lib, id)
	if err != nil {
		return err
	}
	if d == nil {
		d = &tree.Diff{}
	}
	writeJSON(w, 200, map[string]any{"pending": toPending(pd), "diff": d})
	return nil
}

func (a *API) approvePending(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "pendingId")
	if err != nil {
		return err
	}
	res, err := a.Core.ApprovePending(r.Context(), lib, id, a.actor(r, p))
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": res.Revision})
	return nil
}

func (a *API) discardPending(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "pendingId")
	if err != nil {
		return err
	}
	if err := a.Core.DiscardPending(r.Context(), lib, id); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

// Register mounts all API routes.
func (a *API) Register(mux *http.ServeMux) {
	h := func(pattern string, fn authedFunc) { mux.HandleFunc(pattern, a.authed(fn)) }
	pub := func(pattern string, fn func(http.ResponseWriter, *http.Request) error) {
		mux.HandleFunc(pattern, a.public(false, fn))
	}
	session := func(pattern string, fn func(http.ResponseWriter, *http.Request) error) {
		mux.HandleFunc(pattern, a.public(true, fn))
	}

	pub("GET /api/v1/system/info", a.systemInfo)
	session("POST /api/v1/setup", a.setup)
	session("POST /api/v1/auth/login", a.login)
	session("POST /api/v1/auth/access", a.loginWithAccess)
	pub("POST /api/v1/auth/token", a.tokenWithPassword)
	pub("GET /api/v1/favicons/{faviconId}", a.favicon)
	h("POST /api/v1/auth/logout", a.logout)
	h("GET /api/v1/auth/me", a.me)
	h("POST /api/v1/auth/password", a.changePassword)

	h("GET /api/v1/users", a.listUsers)
	h("POST /api/v1/users", a.createUser)
	h("PATCH /api/v1/users/{userId}", a.updateUser)
	h("DELETE /api/v1/users/{userId}", a.deleteUser)

	h("GET /api/v1/tokens", a.listTokens)
	h("POST /api/v1/tokens", a.createToken)
	h("DELETE /api/v1/tokens/{tokenId}", a.revokeToken)
	h("POST /api/v1/floccus/setup", a.floccusSetup)

	h("GET /api/v1/libraries", a.listLibraries)
	h("POST /api/v1/libraries", a.createLibrary)
	h("GET /api/v1/libraries/{slug}", a.getLibrary)
	h("PATCH /api/v1/libraries/{slug}", a.updateLibrary)
	h("DELETE /api/v1/libraries/{slug}", a.deleteLibrary)
	h("POST /api/v1/libraries/{slug}/lock/release", a.releaseLock)
	h("GET /api/v1/libraries/{slug}/tree", a.getTree)
	h("POST /api/v1/libraries/{slug}/items", a.createItem)
	h("POST /api/v1/libraries/{slug}/items/batch", a.batch)
	h("GET /api/v1/libraries/{slug}/items/{itemId}", a.getItem)
	h("PATCH /api/v1/libraries/{slug}/items/{itemId}", a.updateItem)
	h("DELETE /api/v1/libraries/{slug}/items/{itemId}", a.deleteItem)
	h("POST /api/v1/libraries/{slug}/items/{itemId}/transfer", a.transfer)
	h("GET /api/v1/libraries/{slug}/recent", a.recent)
	h("GET /api/v1/libraries/{slug}/frequent", a.frequent)
	h("GET /api/v1/recent", a.recent)
	h("GET /api/v1/frequent", a.frequent)
	h("POST /api/v1/quick-save", a.quickSave)
	h("GET /api/v1/lookup", a.lookup)
	h("GET /api/v1/search", a.search)
	h("GET /api/v1/tags", a.listTags)
	h("PATCH /api/v1/tags/{name}", a.renameTag)
	h("DELETE /api/v1/tags/{name}", a.deleteTag)
	h("POST /api/v1/visits", a.recordVisit)
	h("POST /api/v1/meta/fetch", a.fetchMeta)

	h("GET /api/v1/libraries/{slug}/revisions", a.listRevisions)
	h("GET /api/v1/libraries/{slug}/revisions/{rev}", a.getRevision)
	h("GET /api/v1/libraries/{slug}/revisions/{rev}/export", a.exportRevision)
	h("POST /api/v1/libraries/{slug}/revisions/{rev}/restore", a.restoreRevision)
	h("GET /api/v1/libraries/{slug}/deleted", a.listDeleted)
	h("POST /api/v1/libraries/{slug}/deleted/restore", a.restoreDeleted)
	h("GET /api/v1/pending", a.listPending)
	h("GET /api/v1/libraries/{slug}/pending/{pendingId}", a.getPending)
	h("POST /api/v1/libraries/{slug}/pending/{pendingId}/approve", a.approvePending)
	h("POST /api/v1/libraries/{slug}/pending/{pendingId}/discard", a.discardPending)

	h("GET /api/v1/reports/broken", a.broken)
	h("POST /api/v1/reports/broken/recheck", a.recheck)
	h("GET /api/v1/reports/duplicates", a.duplicates)
	h("GET /api/v1/jobs", a.listJobs)
	h("POST /api/v1/jobs/{name}/run", a.runJob)

	h("POST /api/v1/libraries/{slug}/import", a.importBookmarks)
	h("GET /api/v1/libraries/{slug}/export", a.exportBookmarks)
	h("GET /api/v1/settings", a.getSettings)
	h("PATCH /api/v1/settings", a.updateSettings)
	h("GET /api/v1/ai/status", a.aiStatus)
	h("POST /api/v1/ai/suggest", a.aiSuggest)
	h("POST /api/v1/ai/organize", a.aiOrganize)

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		a.writeError(w, r, errf(404, "not_found", "没有这个接口"))
	})
}
