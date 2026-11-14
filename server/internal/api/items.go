package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"shelfmark/internal/auth"
	"shelfmark/internal/core"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/urlnorm"
)

// ---- libraries ----

type lockJSON struct {
	Actor      string `json:"actor"`
	Since      string `json:"since"`
	ModifiedAt string `json:"modifiedAt"`
	Fresh      bool   `json:"fresh"`
}

type libraryJSON struct {
	Slug          string    `json:"slug"`
	Name          string    `json:"name"`
	DavFile       string    `json:"davFile"`
	Revision      int64     `json:"revision"`
	HighestID     int64     `json:"highestId"`
	BookmarkCount int       `json:"bookmarkCount"`
	FolderCount   int       `json:"folderCount"`
	CreatedAt     string    `json:"createdAt"`
	UpdatedAt     string    `json:"updatedAt"`
	LastSyncAt    *string   `json:"lastSyncAt"`
	LastSyncActor *string   `json:"lastSyncActor"`
	Lock          *lockJSON `json:"lock"`
	PendingCount  int       `json:"pendingCount"`
}

func (a *API) libraryJSONs(ctx context.Context, userID int64, libs []*store.Library) ([]libraryJSON, error) {
	counts, err := store.LibraryCounts(ctx, a.DB, userID)
	if err != nil {
		return nil, err
	}
	pending, err := store.PendingCounts(ctx, a.DB, userID)
	if err != nil {
		return nil, err
	}
	out := []libraryJSON{}
	for _, l := range libs {
		j := libraryJSON{Slug: l.Slug, Name: l.Name, DavFile: l.Slug + ".xbel", Revision: l.Revision, HighestID: l.HighestID,
			BookmarkCount: counts[l.ID][0], FolderCount: counts[l.ID][1], CreatedAt: ts(l.CreatedAt), UpdatedAt: ts(l.UpdatedAt),
			LastSyncAt: tsp(l.LastSyncAt), LastSyncActor: l.LastSyncActor, PendingCount: pending[l.ID]}
		info, err := a.Core.FloccusLock(ctx, a.DB, userID, l.Slug)
		if err != nil {
			return nil, err
		}
		if info != nil {
			j.Lock = &lockJSON{Actor: info.Actor, Since: ts(info.Since), ModifiedAt: ts(info.ModifiedAt), Fresh: info.Fresh}
		}
		out = append(out, j)
	}
	return out, nil
}

func (a *API) oneLibrary(ctx context.Context, lib *store.Library) (libraryJSON, error) {
	list, err := a.libraryJSONs(ctx, lib.UserID, []*store.Library{lib})
	if err != nil {
		return libraryJSON{}, err
	}
	return list[0], nil
}

func (a *API) listLibraries(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	libs, err := store.ListLibraries(r.Context(), a.DB, p.User.ID)
	if err != nil {
		return err
	}
	out, err := a.libraryJSONs(r.Context(), p.User.ID, libs)
	if err != nil {
		return err
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) createLibrary(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	lib, err := a.Core.CreateLibrary(r.Context(), p.User.ID, body.Slug, body.Name)
	if err != nil {
		return err
	}
	j, err := a.oneLibrary(r.Context(), lib)
	if err != nil {
		return err
	}
	writeJSON(w, 201, j)
	return nil
}

func (a *API) getLibrary(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	j, err := a.oneLibrary(r.Context(), lib)
	if err != nil {
		return err
	}
	writeJSON(w, 200, j)
	return nil
}

func (a *API) updateLibrary(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	var body struct {
		Name *string `json:"name"`
		Slug *string `json:"slug"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	lib, err = a.Core.UpdateLibrary(r.Context(), lib, body.Name, body.Slug)
	if err != nil {
		return err
	}
	j, err := a.oneLibrary(r.Context(), lib)
	if err != nil {
		return err
	}
	writeJSON(w, 200, j)
	return nil
}

func (a *API) deleteLibrary(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("confirm") != lib.Slug {
		return validation("confirm", "confirm 必须等于库的 slug")
	}
	if err := a.Core.DeleteLibrary(r.Context(), lib); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *API) releaseLock(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	if err := a.Core.ReleaseLock(r.Context(), lib); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

// ---- tree & items ----

func (a *API) getTree(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	v, err := a.Core.LoadView(r.Context(), lib)
	if err != nil {
		return err
	}
	etag := v.Lib.ETag() // changes on every edit, including merged revisions
	w.Header().Set("ETag", etag)
	if inm := r.Header.Get("If-None-Match"); inm != "" {
		for _, t := range strings.Split(inm, ",") {
			if t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "W/")); t == etag || t == "*" {
				w.WriteHeader(http.StatusNotModified)
				return nil
			}
		}
	}
	writeJSON(w, 200, map[string]any{"library": v.Lib.Slug, "revision": v.Lib.Revision, "highestId": max(v.Lib.HighestID, v.Tree.HighestID), "children": treeJSON(v)})
	return nil
}

func validTag(t string) bool {
	if t == "" || len([]rune(t)) > 64 {
		return false
	}
	for _, r := range t {
		if unicode.IsSpace(r) || r == ',' {
			return false
		}
	}
	return true
}

func checkTags(field string, tags []string) ([]string, error) {
	if len(tags) > 50 {
		return nil, validation(field, "最多 50 个标签")
	}
	for _, t := range tags {
		if !validTag(strings.TrimSpace(t)) {
			return nil, validation(field, fmt.Sprintf("标签 %q 不合法（1–64 字，不含空白和逗号）", t))
		}
	}
	return tree.NormalizeTags(tags), nil
}

func checkLen(field, s string, maxLen int) error {
	if len([]rune(s)) > maxLen {
		return validation(field, fmt.Sprintf("%s 最长 %d 字", field, maxLen))
	}
	return nil
}

type createItemBody struct {
	Type     string   `json:"type"`
	ParentID int64    `json:"parentId"`
	Position *int     `json:"position"`
	Title    *string  `json:"title"`
	URL      string   `json:"url"`
	Notes    string   `json:"notes"`
	Tags     []string `json:"tags"`
}

func (b *createItemBody) validate() error {
	if b.Type != tree.Folder && b.Type != tree.Bookmark {
		return validation("type", "type 只能是 folder 或 bookmark")
	}
	if b.Title == nil {
		return validation("title", "缺少 title")
	}
	if err := checkLen("title", *b.Title, 2000); err != nil {
		return err
	}
	if err := checkLen("url", b.URL, 8192); err != nil {
		return err
	}
	if err := checkLen("notes", b.Notes, 20000); err != nil {
		return err
	}
	if b.Type == tree.Bookmark && strings.TrimSpace(b.URL) == "" {
		return validation("url", "书签必须有 url")
	}
	if b.Position != nil && *b.Position < 0 {
		return validation("position", "position 不能为负")
	}
	tags, err := checkTags("tags", b.Tags)
	if err != nil {
		return err
	}
	b.Tags = tags
	return nil
}

func parentError(t *tree.Tree, parent int64) error {
	if t.IsFolder(parent) {
		return nil
	}
	if t.Get(parent) == nil {
		return validation("parentId", "父文件夹不存在")
	}
	return validation("parentId", "父条目不是文件夹")
}

func (a *API) writeItemResult(w http.ResponseWriter, r *http.Request, lib *store.Library, status int, rev, id int64) error {
	v, err := a.Core.LoadView(r.Context(), lib)
	if err != nil {
		return err
	}
	it := v.Tree.Get(id)
	if it == nil {
		return errNotFound
	}
	writeJSON(w, status, map[string]any{"revision": rev, "item": toItem(it, v.Meta[id])})
	return nil
}

func (a *API) createItem(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	var body createItemBody
	if err := decode(r, &body); err != nil {
		return err
	}
	if err := body.validate(); err != nil {
		return err
	}
	var id int64
	res, err := a.Core.Write(r.Context(), lib, a.actor(r, p), core.WriteOpts{}, func(wc *core.WriteCtx) error {
		if err := parentError(wc.Tree, body.ParentID); err != nil {
			return err
		}
		id = wc.Tree.NextID()
		it := &tree.Item{ID: id, Type: body.Type, Title: core.SanitizeText(*body.Title), Notes: strings.TrimSpace(body.Notes), Tags: body.Tags}
		if body.Type == tree.Bookmark {
			it.URL = core.SanitizeText(body.URL)
			if it.Title == "" {
				wc.FillTitle[id] = true
			}
		}
		pos := -1
		if body.Position != nil {
			pos = *body.Position
		}
		return wc.Tree.Insert(it, body.ParentID, pos)
	})
	if err != nil {
		return err
	}
	return a.writeItemResult(w, r, lib, 201, res.Revision, id)
}

func (a *API) getItem(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "itemId")
	if err != nil {
		return err
	}
	v, err := a.Core.LoadView(r.Context(), lib)
	if err != nil {
		return err
	}
	j := withPath(v, id)
	if j == nil {
		return errNotFound
	}
	writeJSON(w, 200, j)
	return nil
}

// opt distinguishes "absent" from "null" in PATCH bodies.
type opt[T any] struct {
	Set  bool
	Null bool
	V    T
}

func (o *opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

type updateFields struct {
	Title    opt[string]   `json:"title"`
	URL      opt[string]   `json:"url"`
	Notes    opt[string]   `json:"notes"`
	Tags     opt[[]string] `json:"tags"`
	ParentID opt[int64]    `json:"parentId"`
	Position opt[int]      `json:"position"`
}

func (u *updateFields) validate(prefix string) error {
	if u.Title.Set && u.Title.Null {
		return validation(prefix+"title", "title 不能为 null")
	}
	if err := checkLen(prefix+"title", u.Title.V, 2000); err != nil {
		return err
	}
	if err := checkLen(prefix+"url", u.URL.V, 8192); err != nil {
		return err
	}
	if err := checkLen(prefix+"notes", u.Notes.V, 20000); err != nil {
		return err
	}
	if u.Tags.Set {
		tags, err := checkTags(prefix+"tags", u.Tags.V)
		if err != nil {
			return err
		}
		u.Tags.V = tags
	}
	if u.Position.Set && (u.Position.Null || u.Position.V < 0) {
		return validation(prefix+"position", "position 不能为负")
	}
	return nil
}

// apply changes item id in t.
func (u *updateFields) apply(t *tree.Tree, id int64) error {
	it := t.Get(id)
	if it == nil {
		return errNotFound
	}
	if u.URL.Set {
		if it.Type != tree.Bookmark {
			return validation("url", "文件夹没有 url")
		}
		if u.URL.Null || strings.TrimSpace(u.URL.V) == "" {
			return validation("url", "书签必须有 url")
		}
		it.URL = core.SanitizeText(u.URL.V)
	}
	if u.Title.Set {
		it.Title = core.SanitizeText(u.Title.V)
	}
	if u.Notes.Set {
		it.Notes = strings.TrimSpace(u.Notes.V)
	}
	if u.Tags.Set {
		it.Tags = u.Tags.V
	}
	if u.ParentID.Set || u.Position.Set {
		parent := it.ParentID
		if u.ParentID.Set && !u.ParentID.Null {
			parent = u.ParentID.V
		}
		pos := -1
		if u.Position.Set {
			pos = u.Position.V
		}
		if err := parentError(t, parent); err != nil {
			return err
		}
		if err := t.Move(id, parent, pos); err != nil {
			return err
		}
	}
	return nil
}

func (a *API) updateItem(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "itemId")
	if err != nil {
		return err
	}
	var body updateFields
	if err := decode(r, &body); err != nil {
		return err
	}
	if err := body.validate(""); err != nil {
		return err
	}
	res, err := a.Core.Write(r.Context(), lib, a.actor(r, p), core.WriteOpts{}, func(wc *core.WriteCtx) error {
		return body.apply(wc.Tree, id)
	})
	if err != nil {
		return err
	}
	return a.writeItemResult(w, r, lib, 200, res.Revision, id)
}

func (a *API) deleteItem(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "itemId")
	if err != nil {
		return err
	}
	res, err := a.Core.Write(r.Context(), lib, a.actor(r, p), core.WriteOpts{}, func(wc *core.WriteCtx) error {
		if wc.Tree.Get(id) == nil {
			return errNotFound
		}
		wc.Tree.Remove(id)
		return nil
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": res.Revision})
	return nil
}

type batchOp struct {
	Op        string `json:"op"`
	Ref       string `json:"ref"`
	ID        int64  `json:"id"`
	ParentRef string `json:"parentRef"`
	Add       []string
	Remove    []string
	create    createItemBody
	update    updateFields
}

func (o *batchOp) UnmarshalJSON(b []byte) error {
	var head struct {
		Op        string   `json:"op"`
		Ref       string   `json:"ref"`
		ID        int64    `json:"id"`
		ParentRef string   `json:"parentRef"`
		Add       []string `json:"add"`
		Remove    []string `json:"remove"`
	}
	if err := json.Unmarshal(b, &head); err != nil {
		return err
	}
	o.Op, o.Ref, o.ID, o.ParentRef, o.Add, o.Remove = head.Op, head.Ref, head.ID, head.ParentRef, head.Add, head.Remove
	switch head.Op {
	case "create":
		return json.Unmarshal(b, &o.create)
	case "update", "move":
		return json.Unmarshal(b, &o.update)
	}
	return nil
}

func (a *API) batch(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	var body struct {
		Ops []*batchOp `json:"ops"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if len(body.Ops) == 0 || len(body.Ops) > 1000 {
		return validation("ops", "ops 需要 1–1000 个操作")
	}
	for i, op := range body.Ops {
		field := fmt.Sprintf("ops[%d].", i)
		switch op.Op {
		case "create":
			if err := op.create.validate(); err != nil {
				return prefixed(err, field)
			}
		case "update":
			op.update.ParentID, op.update.Position = opt[int64]{}, opt[int]{}
			if err := op.update.validate(field); err != nil {
				return err
			}
		case "move":
			op.update = updateFields{ParentID: op.update.ParentID, Position: op.update.Position}
			if err := op.update.validate(field); err != nil {
				return err
			}
		case "delete":
		case "tag":
			if _, err := checkTags(field+"add", op.Add); err != nil {
				return err
			}
		default:
			return validation(field+"op", "未知操作 "+op.Op)
		}
	}
	created := map[string]int64{}
	res, err := a.Core.Write(r.Context(), lib, a.actor(r, p), core.WriteOpts{}, func(wc *core.WriteCtx) error {
		t := wc.Tree
		resolve := func(i int, op *batchOp, parent int64) (int64, error) {
			if op.ParentRef == "" {
				return parent, nil
			}
			id, ok := created[op.ParentRef]
			if !ok {
				return 0, validation(fmt.Sprintf("ops[%d].parentRef", i), "未知的 parentRef "+op.ParentRef)
			}
			return id, nil
		}
		for i, op := range body.Ops {
			if op.Op != "create" && t.Get(op.ID) == nil {
				return &Error{Status: 404, Code: "not_found", Message: fmt.Sprintf("ops[%d]: 条目 %d 不存在", i, op.ID), Details: map[string]any{"op": i}}
			}
			switch op.Op {
			case "create":
				c := op.create
				parent, err := resolve(i, op, c.ParentID)
				if err != nil {
					return err
				}
				if err := parentError(t, parent); err != nil {
					return prefixed(err, fmt.Sprintf("ops[%d].", i))
				}
				id := t.NextID()
				it := &tree.Item{ID: id, Type: c.Type, Title: core.SanitizeText(*c.Title), Notes: strings.TrimSpace(c.Notes), Tags: c.Tags}
				if c.Type == tree.Bookmark {
					it.URL = core.SanitizeText(c.URL)
					if it.Title == "" {
						wc.FillTitle[id] = true
					}
				}
				pos := -1
				if c.Position != nil {
					pos = *c.Position
				}
				if err := t.Insert(it, parent, pos); err != nil {
					return err
				}
				if op.Ref != "" {
					created[op.Ref] = id
				}
			case "update":
				if err := op.update.apply(t, op.ID); err != nil {
					return err
				}
			case "move":
				u := op.update
				if op.ParentRef != "" {
					parent, err := resolve(i, op, 0)
					if err != nil {
						return err
					}
					u.ParentID = opt[int64]{Set: true, V: parent}
				}
				if !u.ParentID.Set && !u.Position.Set {
					u.ParentID = opt[int64]{Set: true, V: t.Get(op.ID).ParentID}
				}
				if err := u.apply(t, op.ID); err != nil {
					return err
				}
			case "delete":
				t.Remove(op.ID)
			case "tag":
				it := t.Get(op.ID)
				remove := map[string]bool{}
				for _, x := range op.Remove {
					remove[strings.ToLower(strings.TrimSpace(x))] = true
				}
				var kept []string
				for _, x := range it.Tags {
					if !remove[strings.ToLower(x)] {
						kept = append(kept, x)
					}
				}
				it.Tags = tree.NormalizeTags(append(kept, op.Add...))
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"revision": res.Revision, "created": created})
	return nil
}

func prefixed(err error, prefix string) error {
	if e, ok := err.(*Error); ok && e.Code == "validation" {
		d := map[string]any{}
		for k, v := range e.Details {
			d[prefix+k] = v
		}
		return &Error{Status: e.Status, Code: e.Code, Message: e.Message, Details: d}
	}
	return err
}

// ---- discovery ----

type viewItem struct {
	v  *core.View
	it *tree.Item
}

func (x viewItem) visits() (int, time.Time) {
	if m := x.v.Meta[x.it.ID]; m != nil {
		var last time.Time
		if m.LastVisitedAt != nil {
			last = *m.LastVisitedAt
		}
		return m.VisitCount, last
	}
	return 0, time.Time{}
}

// recent serves /libraries/{slug}/recent and the cross-library /recent.
func (a *API) recent(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	return a.listBookmarks(w, r, p, func(items []viewItem) {
		sort.SliceStable(items, func(i, j int) bool {
			if !items[i].it.CreatedAt.Equal(items[j].it.CreatedAt) {
				return items[i].it.CreatedAt.After(items[j].it.CreatedAt)
			}
			return items[i].it.ID > items[j].it.ID
		})
	}, nil)
}

// frequent serves /libraries/{slug}/frequent and the cross-library /frequent.
func (a *API) frequent(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	return a.listBookmarks(w, r, p, func(items []viewItem) {
		sort.SliceStable(items, func(i, j int) bool {
			ci, li := items[i].visits()
			cj, lj := items[j].visits()
			if ci != cj {
				return ci > cj
			}
			return li.After(lj)
		})
	}, func(x viewItem) bool { n, _ := x.visits(); return n > 0 })
}

func (a *API) listBookmarks(w http.ResponseWriter, r *http.Request, p *auth.Principal, order func([]viewItem), keep func(viewItem) bool) error {
	var libs []*store.Library
	if r.PathValue("slug") != "" {
		lib, err := a.library(r, p)
		if err != nil {
			return err
		}
		libs = []*store.Library{lib}
	} else {
		var err error
		if libs, err = store.ListLibraries(r.Context(), a.DB, p.User.ID); err != nil {
			return err
		}
	}
	limit, err := queryInt(r, "limit", 20, 1, 100)
	if err != nil {
		return err
	}
	var items []viewItem
	for _, lib := range libs {
		v, err := a.Core.LoadView(r.Context(), lib)
		if err != nil {
			return err
		}
		for _, it := range v.Tree.Items() {
			x := viewItem{v, it}
			if it.Type == tree.Bookmark && (keep == nil || keep(x)) {
				items = append(items, x)
			}
		}
	}
	order(items)
	out := []*itemWithPath{}
	for i, x := range items {
		if i == limit {
			break
		}
		out = append(out, withPath(x.v, x.it.ID))
	}
	writeJSON(w, 200, out)
	return nil
}

// transfer moves an item to another library.
func (a *API) transfer(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	src, err := a.library(r, p)
	if err != nil {
		return err
	}
	id, err := pathInt(r, "itemId")
	if err != nil {
		return err
	}
	var body struct {
		Library  string `json:"library"`
		ParentID *int64 `json:"parentId"`
		Position *int   `json:"position"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if !core.ValidSlug(body.Library) {
		return validation("library", "目标库不存在")
	}
	if body.ParentID == nil {
		return validation("parentId", "缺少 parentId")
	}
	pos := -1
	if body.Position != nil {
		if *body.Position < 0 {
			return validation("position", "position 不能为负")
		}
		pos = *body.Position
	}
	dst, err := a.Core.GetLibrary(r.Context(), p.User.ID, body.Library)
	if err != nil {
		return validation("library", "目标库不存在")
	}
	res, err := a.Core.Transfer(r.Context(), src, dst, id, *body.ParentID, pos, a.actor(r, p))
	if err != nil {
		return err
	}
	v, err := a.Core.LoadView(r.Context(), dst)
	if err != nil {
		return err
	}
	it := v.Tree.Get(res.NewID)
	if it == nil {
		return errNotFound
	}
	writeJSON(w, 200, map[string]any{"revision": res.Target.Revision, "sourceRevision": res.Source.Revision, "item": toItem(it, v.Meta[it.ID])})
	return nil
}

func (a *API) lookup(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	raw := r.URL.Query().Get("url")
	if strings.TrimSpace(raw) == "" {
		return validation("url", "缺少 url")
	}
	norm := urlnorm.Normalize(raw)
	ctx := r.Context()
	rows, err := a.DB.QueryContext(ctx, `SELECT im.library_id, im.item_id FROM item_meta im JOIN libraries l ON l.id = im.library_id
		JOIN items i ON i.library_id = im.library_id AND i.id = im.item_id
		WHERE l.user_id = ? AND im.normalized_url = ? AND i.type = 'bookmark' ORDER BY im.library_id, im.item_id`, p.User.ID, norm)
	if err != nil {
		return err
	}
	type ref struct{ lib, id int64 }
	var refs []ref
	for rows.Next() {
		var x ref
		if err := rows.Scan(&x.lib, &x.id); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, x)
	}
	rows.Close()
	matches := []*itemWithPath{}
	views := map[int64]*core.View{}
	for _, x := range refs {
		v := views[x.lib]
		if v == nil {
			lib, err := store.GetLibraryByID(ctx, a.DB, x.lib)
			if err != nil {
				return err
			}
			if v, err = a.Core.LoadView(ctx, lib); err != nil {
				return err
			}
			views[x.lib] = v
		}
		if j := withPath(v, x.id); j != nil {
			matches = append(matches, j)
		}
	}
	writeJSON(w, 200, map[string]any{"url": raw, "normalizedUrl": norm, "matches": matches})
	return nil
}

func (a *API) recordVisit(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		Library string `json:"library"`
		ItemID  int64  `json:"itemId"`
	}
	// sendBeacon may post the JSON as text/plain; malformed beacons are ignored
	if err := decode(r, &body); err == nil && core.ValidSlug(body.Library) {
		if lib, err := store.GetLibrary(r.Context(), a.DB, p.User.ID, body.Library); err == nil {
			if err := store.RecordVisit(r.Context(), a.DB, lib.ID, body.ItemID, a.Core.Now()); err != nil {
				return err
			}
		}
	}
	w.WriteHeader(204)
	return nil
}

func (a *API) favicon(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("faviconId")
	if len(id) != 32 || strings.Trim(id, "0123456789abcdef") != "" {
		return errNotFound
	}
	f, err := store.GetFavicon(r.Context(), a.DB, id)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", f.Mime)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("Content-Length", fmt.Sprint(len(f.Data)))
	w.WriteHeader(200)
	w.Write(f.Data)
	return nil
}

func (a *API) fetchMeta(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		URL string `json:"url"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if !urlnorm.IsHTTP(body.URL) {
		return validation("url", "只支持 http/https 地址")
	}
	out := map[string]any{"url": body.URL, "finalUrl": nil, "title": nil, "description": nil, "faviconId": nil}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	page, err := a.Meta.FetchPage(ctx, body.URL)
	if err == nil {
		out["finalUrl"] = page.FinalURL
		if page.Title != "" {
			out["title"] = page.Title
		}
		if page.Description != "" {
			out["description"] = page.Description
		}
		if icon, err := a.Meta.FetchIcon(ctx, page.Icons); err == nil {
			if store.PutFavicon(ctx, a.DB, &store.Favicon{ID: icon.ID, Mime: icon.Mime, Data: icon.Data}, icon.Source, a.Core.Now()) == nil {
				out["faviconId"] = icon.ID
			}
		}
	}
	writeJSON(w, 200, out)
	return nil
}

// ---- tags ----

func (a *API) listTags(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	tags, err := store.ListTagCounts(r.Context(), a.DB, p.User.ID)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, t := range tags {
		out = append(out, map[string]any{"name": t.Name, "count": t.Count})
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) editTag(r *http.Request, p *auth.Principal, name string, fn func(tags []string) []string) error {
	ctx := r.Context()
	libIDs, err := store.LibrariesWithTag(ctx, a.DB, p.User.ID, name)
	if err != nil {
		return err
	}
	if len(libIDs) == 0 {
		return errNotFound
	}
	for _, id := range libIDs {
		lib, err := store.GetLibraryByID(ctx, a.DB, id)
		if err != nil {
			return err
		}
		_, err = a.Core.Write(ctx, lib, a.actor(r, p), core.WriteOpts{}, func(wc *core.WriteCtx) error {
			for _, it := range wc.Tree.Items() {
				for _, t := range it.Tags {
					if strings.EqualFold(t, name) {
						it.Tags = tree.NormalizeTags(fn(it.Tags))
						break
					}
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (a *API) renameTag(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	old := r.PathValue("name")
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	newName := strings.TrimSpace(body.Name)
	if !validTag(newName) {
		return validation("name", "标签名不合法（1–64 字，不含空白和逗号）")
	}
	err := a.editTag(r, p, old, func(tags []string) []string {
		out := []string{}
		for _, t := range tags {
			if strings.EqualFold(t, old) {
				t = newName
			}
			out = append(out, t)
		}
		return out
	})
	if err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func (a *API) deleteTag(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	name := r.PathValue("name")
	err := a.editTag(r, p, name, func(tags []string) []string {
		out := []string{}
		for _, t := range tags {
			if !strings.EqualFold(t, name) {
				out = append(out, t)
			}
		}
		return out
	})
	if err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}
