package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"shelfmark/internal/ai"
	"shelfmark/internal/auth"
	"shelfmark/internal/core"
	"shelfmark/internal/importexport"
	"shelfmark/internal/jobs"
	"shelfmark/internal/search"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/urlnorm"
)

// ---- settings ----

type saveTarget struct {
	Library  string `json:"library"`
	FolderID int64  `json:"folderId"`
}

type startSection struct {
	ID        string  `json:"id"`
	Library   string  `json:"library"`
	FolderID  int64   `json:"folderId"`
	Title     *string `json:"title"`
	Layout    string  `json:"layout"`
	Collapsed bool    `json:"collapsed"`
}

type startPage struct {
	ShowSearch    bool           `json:"showSearch"`
	ShowRecent    bool           `json:"showRecent"`
	RecentCount   int            `json:"recentCount"`
	ShowFrequent  bool           `json:"showFrequent"`
	FrequentCount int            `json:"frequentCount"`
	Sections      []startSection `json:"sections"`
}

// startLocation 是 / 打开的位置：上次、库根或固定文件夹。
type startLocation struct {
	Kind     string `json:"kind"`
	Library  string `json:"library,omitempty"`
	FolderID int64  `json:"folderId,omitempty"`
}

type settings struct {
	Language          string        `json:"language"`
	Theme             string        `json:"theme"`
	OpenInNewTab      bool          `json:"openInNewTab"`
	DefaultSave       *saveTarget   `json:"defaultSave"`
	RecentSaveTargets []saveTarget  `json:"recentSaveTargets"`
	StartLocation     startLocation `json:"startLocation"`
	StartPage         startPage     `json:"startPage"`
}

func defaultSettings() *settings {
	return &settings{Language: "auto", Theme: "system", RecentSaveTargets: []saveTarget{},
		StartLocation: startLocation{Kind: "last"},
		StartPage:     startPage{ShowSearch: true, ShowRecent: true, RecentCount: 10, ShowFrequent: true, FrequentCount: 10, Sections: []startSection{}}}
}

func (a *API) loadSettings(ctx context.Context, userID int64) (*settings, error) {
	s := defaultSettings()
	raw, err := store.GetSettingsJSON(ctx, a.DB, userID)
	if err != nil {
		return nil, err
	}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), s); err != nil {
			s = defaultSettings()
		}
	}
	if s.RecentSaveTargets == nil {
		s.RecentSaveTargets = []saveTarget{}
	}
	if s.StartPage.Sections == nil {
		s.StartPage.Sections = []startSection{}
	}
	// 旧数据迁移：没有 startLocation 时，把起始页第一段变成固定文件夹，否则用上次位置。
	if s.StartLocation.Kind == "" {
		if len(s.StartPage.Sections) > 0 {
			sec := s.StartPage.Sections[0]
			s.StartLocation = startLocation{Kind: "folder", Library: sec.Library, FolderID: sec.FolderID}
		} else {
			s.StartLocation = startLocation{Kind: "last"}
		}
	}
	return s, nil
}

func (a *API) saveSettings(ctx context.Context, userID int64, s *settings) error {
	raw, _ := json.Marshal(s)
	return store.PutSettingsJSON(ctx, a.DB, userID, string(raw))
}

func (a *API) getSettings(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	s, err := a.loadSettings(r.Context(), p.User.ID)
	if err != nil {
		return err
	}
	writeJSON(w, 200, s)
	return nil
}

func (a *API) checkTarget(ctx context.Context, userID int64, field string, t saveTarget) error {
	if !core.ValidSlug(t.Library) {
		return validation(field+".library", "库不存在")
	}
	lib, err := a.Core.GetLibrary(ctx, userID, t.Library)
	if err != nil {
		return validation(field+".library", "库不存在")
	}
	if t.FolderID == 0 {
		return nil
	}
	v, err := a.Core.LoadView(ctx, lib)
	if err != nil {
		return err
	}
	if !v.Tree.IsFolder(t.FolderID) {
		return validation(field+".folderId", "文件夹不存在")
	}
	return nil
}

func (a *API) updateSettings(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		Language      *string         `json:"language"`
		Theme         *string         `json:"theme"`
		OpenInNewTab  *bool           `json:"openInNewTab"`
		DefaultSave   opt[saveTarget] `json:"defaultSave"`
		StartLocation *startLocation  `json:"startLocation"`
		StartPage     *startPage      `json:"startPage"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	s, err := a.loadSettings(ctx, p.User.ID)
	if err != nil {
		return err
	}
	if body.Language != nil {
		switch *body.Language {
		case "auto", "zh-CN", "en":
			s.Language = *body.Language
		default:
			return validation("language", "language 只能是 auto、zh-CN、en")
		}
	}
	if body.Theme != nil {
		switch *body.Theme {
		case "system", "light", "dark":
			s.Theme = *body.Theme
		default:
			return validation("theme", "theme 只能是 system、light、dark")
		}
	}
	if body.OpenInNewTab != nil {
		s.OpenInNewTab = *body.OpenInNewTab
	}
	if body.DefaultSave.Set {
		if body.DefaultSave.Null {
			s.DefaultSave = nil
		} else {
			if err := a.checkTarget(ctx, p.User.ID, "defaultSave", body.DefaultSave.V); err != nil {
				return err
			}
			t := body.DefaultSave.V
			s.DefaultSave = &t
		}
	}
	if sl := body.StartLocation; sl != nil {
		switch sl.Kind {
		case "last", "root":
			s.StartLocation = startLocation{Kind: sl.Kind}
		case "folder":
			if sl.FolderID < 0 {
				return validation("startLocation.folderId", "folderId 不合法")
			}
			if err := a.checkTarget(ctx, p.User.ID, "startLocation", saveTarget{Library: sl.Library, FolderID: sl.FolderID}); err != nil {
				return err
			}
			s.StartLocation = startLocation{Kind: "folder", Library: sl.Library, FolderID: sl.FolderID}
		default:
			return validation("startLocation.kind", "kind 只能是 last、root、folder")
		}
	}
	if sp := body.StartPage; sp != nil {
		if sp.RecentCount < 1 || sp.RecentCount > 50 || sp.FrequentCount < 1 || sp.FrequentCount > 50 {
			return validation("startPage", "recentCount、frequentCount 范围 1–50")
		}
		if len(sp.Sections) > 50 {
			return validation("startPage.sections", "最多 50 个分组")
		}
		if sp.Sections == nil {
			sp.Sections = []startSection{}
		}
		for i, sec := range sp.Sections {
			f := fmt.Sprintf("startPage.sections[%d]", i)
			if strings.TrimSpace(sec.ID) == "" {
				return validation(f+".id", "缺少 id")
			}
			if sec.Layout != "grid" && sec.Layout != "list" {
				return validation(f+".layout", "layout 只能是 grid 或 list")
			}
			if !core.ValidSlug(sec.Library) {
				return validation(f+".library", "slug 不合法")
			}
		}
		s.StartPage = *sp
	}
	if err := a.saveSettings(ctx, p.User.ID, s); err != nil {
		return err
	}
	writeJSON(w, 200, s)
	return nil
}

// ---- quick save ----

// inbox finds or creates the root folder "收件箱".
func inbox(t *tree.Tree) (int64, error) {
	if f := t.FindChildFolder(0, core.InboxTitle); f != nil {
		return f.ID, nil
	}
	id := t.NextID()
	return id, t.Insert(&tree.Item{ID: id, Type: tree.Folder, Title: core.InboxTitle}, 0, -1)
}

func (a *API) defaultLibrary(ctx context.Context, userID int64) (*store.Library, error) {
	if lib, err := a.Core.GetLibrary(ctx, userID, core.DefaultSlug); err == nil {
		return lib, nil
	}
	libs, err := store.ListLibraries(ctx, a.DB, userID)
	if err != nil {
		return nil, err
	}
	if len(libs) > 0 {
		return libs[0], nil
	}
	return a.Core.CreateLibrary(ctx, userID, core.DefaultSlug, core.DefaultSlug)
}

func (a *API) quickSave(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		URL            string   `json:"url"`
		Title          *string  `json:"title"`
		Library        string   `json:"library"`
		ParentID       *int64   `json:"parentId"`
		Notes          string   `json:"notes"`
		Tags           []string `json:"tags"`
		AllowDuplicate bool     `json:"allowDuplicate"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	body.URL = strings.TrimSpace(body.URL)
	if body.URL == "" {
		return validation("url", "缺少 url")
	}
	if err := checkLen("url", body.URL, 8192); err != nil {
		return err
	}
	tags, err := checkTags("tags", body.Tags)
	if err != nil {
		return err
	}
	ctx := r.Context()
	s, err := a.loadSettings(ctx, p.User.ID)
	if err != nil {
		return err
	}
	var lib *store.Library
	folder := int64(-1) // -1: inbox
	switch {
	case body.Library != "":
		if !core.ValidSlug(body.Library) {
			return errNotFound
		}
		if lib, err = a.Core.GetLibrary(ctx, p.User.ID, body.Library); err != nil {
			return err
		}
		if body.ParentID != nil {
			folder = *body.ParentID
		} // otherwise the library's root inbox
	case s.DefaultSave != nil:
		if lib, err = a.Core.GetLibrary(ctx, p.User.ID, s.DefaultSave.Library); err == nil {
			folder = s.DefaultSave.FolderID
		} else if lib, err = a.defaultLibrary(ctx, p.User.ID); err != nil {
			return err
		}
		if body.ParentID != nil {
			folder = *body.ParentID
		}
	default:
		if lib, err = a.defaultLibrary(ctx, p.User.ID); err != nil {
			return err
		}
		if body.ParentID != nil {
			folder = *body.ParentID
		}
	}
	if !body.AllowDuplicate {
		v, err := a.Core.LoadView(ctx, lib)
		if err != nil {
			return err
		}
		norm := urlnorm.Normalize(body.URL)
		for _, it := range v.Tree.Items() {
			if it.Type == tree.Bookmark && urlnorm.Normalize(it.URL) == norm {
				j := withPath(v, it.ID)
				writeJSON(w, 200, map[string]any{"existed": true, "library": lib.Slug, "item": j.Item, "path": j.Path, "revision": v.Lib.Revision})
				return nil
			}
		}
	}
	title := ""
	fill := false
	if body.Title != nil && strings.TrimSpace(*body.Title) != "" {
		title = *body.Title
	} else if urlnorm.IsHTTP(body.URL) && a.Meta != nil {
		fctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		if page, err := a.Meta.FetchPage(fctx, body.URL); err == nil && page.Title != "" {
			title = page.Title
		}
		cancel()
	}
	if title == "" {
		title, fill = body.URL, true
	}
	var id, target int64
	res, err := a.Core.Write(ctx, lib, a.actor(r, p), core.WriteOpts{}, func(wc *core.WriteCtx) error {
		target = folder
		if target == -1 {
			var err error
			if target, err = inbox(wc.Tree); err != nil {
				return err
			}
		} else if !wc.Tree.IsFolder(target) {
			if body.ParentID != nil {
				return parentError(wc.Tree, target)
			}
			// a stale default location falls back to the inbox
			var err error
			if target, err = inbox(wc.Tree); err != nil {
				return err
			}
		}
		id = wc.Tree.NextID()
		if fill {
			wc.FillTitle[id] = true
		}
		return wc.Tree.Insert(&tree.Item{ID: id, Type: tree.Bookmark, Title: core.SanitizeText(title), URL: core.SanitizeText(body.URL),
			Notes: strings.TrimSpace(body.Notes), Tags: tags}, target, -1)
	})
	if err != nil {
		return err
	}
	// remember where things were saved
	recent := []saveTarget{{Library: lib.Slug, FolderID: target}}
	for _, t := range s.RecentSaveTargets {
		if (t != saveTarget{Library: lib.Slug, FolderID: target}) && len(recent) < 10 {
			recent = append(recent, t)
		}
	}
	s.RecentSaveTargets = recent
	if err := a.saveSettings(ctx, p.User.ID, s); err != nil {
		return err
	}
	v, err := a.Core.LoadView(ctx, lib)
	if err != nil {
		return err
	}
	j := withPath(v, id)
	if j == nil {
		return errNotFound
	}
	writeJSON(w, 201, map[string]any{"existed": false, "library": lib.Slug, "item": j.Item, "path": j.Path, "revision": res.Revision})
	return nil
}

// ---- search ----

type viewCache struct {
	a     *API
	ctx   context.Context
	views map[int64]*core.View
}

func (c *viewCache) get(libID int64) (*core.View, error) {
	if v := c.views[libID]; v != nil {
		return v, nil
	}
	lib, err := store.GetLibraryByID(c.ctx, c.a.DB, libID)
	if err != nil {
		return nil, err
	}
	v, err := c.a.Core.LoadView(c.ctx, lib)
	if err != nil {
		return nil, err
	}
	c.views[libID] = v
	return v, nil
}

func (a *API) search(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	q := r.URL.Query().Get("q")
	limit, err := queryInt(r, "limit", 50, 1, 200)
	if err != nil {
		return err
	}
	offset, err := queryInt(r, "offset", 0, 0, 1<<30)
	if err != nil {
		return err
	}
	library := r.URL.Query().Get("library")
	if library != "" && !core.ValidSlug(library) {
		return validation("library", "slug 不合法")
	}
	parsed := search.Parse(q)
	results := []map[string]any{}
	if parsed.Empty() {
		writeJSON(w, 200, map[string]any{"query": q, "total": 0, "results": results})
		return nil
	}
	total, hits, err := search.Run(r.Context(), a.DB.R, p.User.ID, parsed, library, limit, offset)
	if err != nil {
		return err
	}
	vc := &viewCache{a: a, ctx: r.Context(), views: map[int64]*core.View{}}
	for _, h := range hits {
		v, err := vc.get(h.LibraryID)
		if err != nil {
			return err
		}
		j := withPath(v, h.ItemID)
		if j == nil {
			continue
		}
		results = append(results, map[string]any{"library": j.Library, "item": j.Item, "path": j.Path, "pathIds": j.PathIDs, "highlights": h.Highlights})
	}
	writeJSON(w, 200, map[string]any{"query": q, "total": total, "results": results})
	return nil
}

// ---- reports ----

func (a *API) userLibraries(r *http.Request, p *auth.Principal, slug string) ([]*store.Library, error) {
	if slug != "" {
		if !core.ValidSlug(slug) {
			return nil, errNotFound
		}
		lib, err := a.Core.GetLibrary(r.Context(), p.User.ID, slug)
		if err != nil {
			return nil, err
		}
		return []*store.Library{lib}, nil
	}
	return store.ListLibraries(r.Context(), a.DB, p.User.ID)
}

func (a *API) broken(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	libs, err := a.userLibraries(r, p, r.URL.Query().Get("library"))
	if err != nil {
		return err
	}
	want := map[string]bool{"redirect": true, "broken": true, "unreachable": true}
	if s := r.URL.Query()["status"]; len(s) > 0 {
		want = map[string]bool{}
		for _, part := range s {
			for _, st := range strings.Split(part, ",") {
				switch st = strings.TrimSpace(st); st {
				case "ok", "redirect", "broken", "unreachable", "skipped", "unknown":
					want[st] = true
				case "":
				default:
					return validation("status", "未知状态 "+st)
				}
			}
		}
	}
	out := []*itemWithPath{}
	for _, lib := range libs {
		v, err := a.Core.LoadView(r.Context(), lib)
		if err != nil {
			return err
		}
		v.Tree.Walk(func(it *tree.Item, _ int) bool {
			if it.Type == tree.Bookmark {
				status := "unknown"
				if m := v.Meta[it.ID]; m != nil && m.HealthStatus != nil {
					status = *m.HealthStatus
				}
				if want[status] {
					out = append(out, withPath(v, it.ID))
				}
			}
			return true
		})
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) recheck(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var body struct {
		Library string  `json:"library"`
		ItemIDs []int64 `json:"itemIds"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if len(body.ItemIDs) > 500 {
		return validation("itemIds", "最多 500 个")
	}
	if !core.ValidSlug(body.Library) {
		return errNotFound
	}
	lib, err := a.Core.GetLibrary(r.Context(), p.User.ID, body.Library)
	if err != nil {
		return err
	}
	a.Jobs.Recheck(r.Context(), p.User.ID, lib.ID, body.ItemIDs)
	w.WriteHeader(202)
	return nil
}

func (a *API) duplicates(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	libs, err := a.userLibraries(r, p, r.URL.Query().Get("library"))
	if err != nil {
		return err
	}
	groups := map[string][]*itemWithPath{}
	var order []string
	for _, lib := range libs {
		v, err := a.Core.LoadView(r.Context(), lib)
		if err != nil {
			return err
		}
		v.Tree.Walk(func(it *tree.Item, _ int) bool {
			if it.Type != tree.Bookmark {
				return true
			}
			n := urlnorm.Normalize(it.URL)
			if n == "" {
				return true
			}
			if _, ok := groups[n]; !ok {
				order = append(order, n)
			}
			groups[n] = append(groups[n], withPath(v, it.ID))
			return true
		})
	}
	out := []map[string]any{}
	for _, n := range order {
		if len(groups[n]) > 1 {
			out = append(out, map[string]any{"normalizedUrl": n, "items": groups[n]})
		}
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) listJobs(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	out := []map[string]any{}
	for _, s := range a.Jobs.List(r.Context()) {
		out = append(out, map[string]any{"name": s.Name, "enabled": s.Enabled, "running": s.Running,
			"lastStartedAt": tsp(s.LastStartedAt), "lastFinishedAt": tsp(s.LastFinishedAt), "lastOk": s.LastOK,
			"lastSummary": s.LastSummary, "nextRunAt": tsp(s.NextRunAt)})
	}
	writeJSON(w, 200, out)
	return nil
}

func (a *API) runJob(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	err := a.Jobs.Trigger(r.Context(), r.PathValue("name"), p.User.ID, p.User.IsAdmin)
	if errors.Is(err, jobs.ErrUnknown) {
		return validation("name", "没有这个任务")
	}
	if err != nil {
		return err
	}
	w.WriteHeader(202)
	return nil
}

// ---- import / export ----

func (a *API) importBookmarks(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, core.MaxUpload+1<<20)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errf(413, "payload_too_large", "文件超过 32 MiB")
		}
		return validation("file", "需要 multipart/form-data 上传 file")
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("file")
	if err != nil {
		return validation("file", "缺少 file")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, core.MaxUpload+1))
	if err != nil {
		return err
	}
	if len(data) > core.MaxUpload {
		return errf(413, "payload_too_large", "文件超过 32 MiB")
	}
	mode := r.FormValue("mode")
	if mode == "" {
		mode = importexport.ModeFolder
	}
	if mode != importexport.ModeFolder && mode != importexport.ModeMerge && mode != importexport.ModeReplace {
		return validation("mode", "mode 只能是 folder、merge、replace")
	}
	format, nodes, err := importexport.Parse(data)
	if err != nil {
		return errf(415, "unsupported_media_type", err.Error())
	}
	actor := a.actor(r, p)
	actor.Source = core.SourceImport
	var result *importexport.Result
	res, err := a.Core.Write(r.Context(), lib, actor, core.WriteOpts{NoMerge: true}, func(wc *core.WriteCtx) error {
		var err error
		result, err = importexport.Apply(wc, nodes, mode, r.FormValue("folderName"))
		return err
	})
	if err != nil {
		return err
	}
	for id, n := range result.Visits {
		store.SetVisits(r.Context(), a.DB, lib.ID, id, n, nil)
	}
	writeJSON(w, 200, map[string]any{"format": format, "mode": mode, "addedBookmarks": result.AddedBookmarks,
		"addedFolders": result.AddedFolders, "skippedDuplicates": result.SkippedDuplicates, "revision": res.Revision})
	return nil
}

func sendExport(w http.ResponseWriter, in importexport.ExportInput, format, base string) error {
	body, ctype, ext, err := importexport.Export(in, format)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.%s"`, base, ext))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	w.Write(body)
	return nil
}

func (a *API) exportBookmarks(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	lib, err := a.library(r, p)
	if err != nil {
		return err
	}
	v, err := a.Core.LoadView(r.Context(), lib)
	if err != nil {
		return err
	}
	v.Tree.HighestID = max(v.Tree.HighestID, v.Lib.HighestID)
	now := a.Core.Now()
	return sendExport(w, importexport.ExportInput{Slug: lib.Slug, Name: lib.Name, Revision: v.Lib.Revision, Tree: v.Tree, Meta: v.Meta, Now: now},
		r.URL.Query().Get("format"), fmt.Sprintf("%s-%s", lib.Slug, now.Format("20060102")))
}

// ---- AI ----

func (a *API) aiStatus(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	var model *string
	if a.AI != nil {
		model = &a.AI.Model
	}
	writeJSON(w, 200, map[string]any{"enabled": a.AI != nil, "model": model})
	return nil
}

func folders(t *tree.Tree) []ai.Folder {
	out := []ai.Folder{{ID: 0, Path: []string{}}}
	t.Walk(func(it *tree.Item, _ int) bool {
		if it.Type == tree.Folder {
			p, _ := t.Path(it.ID)
			out = append(out, ai.Folder{ID: it.ID, Path: append(p, it.Title)})
		}
		return true
	})
	return out
}

func folderPath(fs []ai.Folder, id int64) []string {
	for _, f := range fs {
		if f.ID == id {
			return f.Path
		}
	}
	return []string{}
}

func (a *API) aiSuggest(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if a.AI == nil {
		return errf(503, "unavailable", "AI 未启用")
	}
	var body struct {
		Library string `json:"library"`
		URL     string `json:"url"`
		Title   string `json:"title"`
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
	if strings.TrimSpace(body.URL) == "" {
		return validation("url", "缺少 url")
	}
	v, err := a.Core.LoadView(r.Context(), lib)
	if err != nil {
		return err
	}
	title, desc := body.Title, ""
	if urlnorm.IsHTTP(body.URL) && a.Meta != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		if page, err := a.Meta.FetchPage(ctx, body.URL); err == nil {
			if title == "" {
				title = page.Title
			}
			desc = page.Description
		}
		cancel()
	}
	fs := folders(v.Tree)
	s, err := a.AI.Suggest(r.Context(), body.URL, title, desc, fs)
	if err != nil {
		return err
	}
	outFolders := []map[string]any{}
	for _, f := range s.Folders {
		outFolders = append(outFolders, map[string]any{"folderId": f.ID, "path": folderPath(fs, f.ID), "score": f.Score})
	}
	var t *string
	if s.Title != "" {
		t = &s.Title
	}
	writeJSON(w, 200, map[string]any{"title": t, "folders": outFolders, "tags": s.Tags})
	return nil
}

func (a *API) aiOrganize(w http.ResponseWriter, r *http.Request, p *auth.Principal) error {
	if a.AI == nil {
		return errf(503, "unavailable", "AI 未启用")
	}
	var body struct {
		Library  string `json:"library"`
		FolderID int64  `json:"folderId"`
		Limit    int    `json:"limit"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	if body.Limit == 0 {
		body.Limit = 50
	}
	if body.Limit < 1 || body.Limit > 100 {
		return validation("limit", "limit 范围 1–100")
	}
	if !core.ValidSlug(body.Library) {
		return errNotFound
	}
	lib, err := a.Core.GetLibrary(r.Context(), p.User.ID, body.Library)
	if err != nil {
		return err
	}
	v, err := a.Core.LoadView(r.Context(), lib)
	if err != nil {
		return err
	}
	if !v.Tree.IsFolder(body.FolderID) {
		return errNotFound
	}
	var items []ai.Item
	for _, id := range v.Tree.Children(body.FolderID) {
		if it := v.Tree.Get(id); it.Type == tree.Bookmark && len(items) < body.Limit {
			items = append(items, ai.Item{ID: it.ID, Title: it.Title, URL: it.URL})
		}
	}
	out := []map[string]any{}
	if len(items) > 0 {
		fs := folders(v.Tree)
		placements, err := a.AI.Organize(r.Context(), items, fs)
		if err != nil {
			return err
		}
		for _, pl := range placements {
			it := v.Tree.Get(pl.ItemID)
			out = append(out, map[string]any{"itemId": it.ID, "title": it.Title, "url": it.URL, "folderId": pl.FolderID,
				"path": folderPath(fs, pl.FolderID), "tags": pl.Tags})
		}
	}
	writeJSON(w, 200, map[string]any{"suggestions": out})
	return nil
}
