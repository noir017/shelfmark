package core

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/urlnorm"
	"shelfmark/internal/xbel"
)

var slugRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ValidSlug reports whether s is a valid library slug.
func ValidSlug(s string) bool { return slugRe.MatchString(s) && s != "." && s != ".." }

func normalize(u string) string { return urlnorm.Normalize(u) }

// ---- XBEL generation with per-revision cache ----

type xbelEntry struct {
	rev     int64
	libRev  int64
	data    []byte
	modTime time.Time
}

// XBELFile is a generated library file.
type XBELFile struct {
	Data     []byte
	Revision int64
	ModTime  time.Time
}

// TreeToXBEL converts a tree to XBEL items.
func TreeToXBEL(t *tree.Tree) []*xbel.Item {
	var conv func(parent int64) []*xbel.Item
	conv = func(parent int64) []*xbel.Item {
		var out []*xbel.Item
		for _, id := range t.Children(parent) {
			it := t.Get(id)
			x := &xbel.Item{Type: it.Type, ID: it.ID, Title: xbel.Clean(it.Title), URL: xbel.Clean(it.URL)}
			if it.Type == tree.Folder {
				x.Children = conv(id)
			}
			out = append(out, x)
		}
		return out
	}
	return conv(0)
}

// XBEL returns the library file, cached per revision so GET and PROPFIND agree.
func (s *Service) XBEL(ctx context.Context, lib *store.Library) (*XBELFile, error) {
	cur, err := store.GetLibraryByID(ctx, s.DB.R, lib.ID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	e := s.xbel[lib.ID]
	s.mu.Unlock()
	if e != nil && e.rev == cur.Revision && e.libRev == cur.HighestID {
		return &XBELFile{Data: e.data, Revision: e.rev, ModTime: e.modTime}, nil
	}
	var out *XBELFile
	err = s.DB.ReadTx(ctx, func(tx *sql.Tx) error {
		l, err := store.GetLibraryByID(ctx, tx, lib.ID)
		if err != nil {
			return err
		}
		t, err := store.LoadTree(ctx, tx, l.ID, l.HighestID)
		if err != nil {
			return err
		}
		mod := l.CreatedAt
		if r, err := store.LatestRevision(ctx, tx, l.ID); err == nil {
			mod = r.CreatedAt
		}
		out = &XBELFile{Data: xbel.Write(TreeToXBEL(t), max(l.HighestID, t.HighestID)), Revision: l.Revision, ModTime: mod}
		s.mu.Lock()
		s.xbel[lib.ID] = &xbelEntry{rev: l.Revision, libRev: l.HighestID, data: out.Data, modTime: mod}
		s.mu.Unlock()
		return nil
	})
	return out, err
}

// ---- libraries ----

// EnsureLibrary returns the library, creating it when create is true.
func (s *Service) EnsureLibrary(ctx context.Context, userID int64, slug string, create bool) (lib *store.Library, created bool, err error) {
	lib, err = store.GetLibrary(ctx, s.DB, userID, slug)
	if err == nil {
		return lib, false, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, false, err
	}
	if !create {
		return nil, false, ErrNotFound
	}
	lib, err = store.CreateLibrary(ctx, s.DB, userID, slug, slug, s.Now())
	if errors.Is(err, store.ErrConflict) {
		lib, err = store.GetLibrary(ctx, s.DB, userID, slug)
		return lib, false, err
	}
	return lib, err == nil, err
}

// ---- WebDAV uploads ----

// UploadResult reports an applied upload.
type UploadResult struct {
	LibraryCreated bool
	Revision       int64
	Changed        bool
}

// ParseUpload maps an XBEL body to a parsed document.
func ParseUpload(data []byte) (*xbel.Doc, error) {
	return xbel.Parse(data)
}

func replaceWithDoc(w *WriteCtx, doc *xbel.Doc) error {
	old := w.Old
	nw := w.Tree
	prevHighest := nw.HighestID
	nw.Clear()
	var add func(parent int64, items []*xbel.Item) error
	add = func(parent int64, items []*xbel.Item) error {
		for _, x := range items {
			it := &tree.Item{ID: x.ID, Type: x.Type, Title: x.Title, URL: x.URL}
			if o := old.Get(x.ID); o != nil {
				it.Notes = o.Notes
				it.Tags = append([]string(nil), o.Tags...)
				it.CreatedAt = o.CreatedAt
			}
			if err := nw.Insert(it, parent, -1); err != nil {
				return &xbel.ParseError{Msg: fmt.Sprintf("条目 %d: %v", x.ID, err)}
			}
			if x.Type == xbel.TypeFolder {
				if err := add(x.ID, x.Children); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := add(0, doc.Items); err != nil {
		return err
	}
	h := max(prevHighest, nw.HighestID, doc.MaxID())
	if doc.HasHighestID {
		h = max(h, doc.HighestID)
	}
	nw.HighestID = h
	return nil
}

func gz(data []byte) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	w.Write(data)
	w.Close()
	return b.Bytes()
}

func gunzip(data []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(r, MaxUpload+1))
}

// ApplyUpload applies a Floccus upload to <slug>.xbel (design 4.4).
func (s *Service) ApplyUpload(ctx context.Context, userID int64, slug string, data []byte, actor Actor) (*UploadResult, error) {
	doc, err := ParseUpload(data)
	if err != nil {
		s.hookUpload("rejected")
		return nil, err
	}
	unlock := s.LockLibrary(userID, slug)
	defer unlock()
	lib, created, err := s.EnsureLibrary(ctx, userID, slug, s.Cfg.DAVAutoCreate)
	if err != nil {
		return nil, err
	}
	totalBefore := 0
	guard := func(w *WriteCtx, d *tree.Diff) *store.Pending {
		ratio := s.Cfg.GuardRatio
		before, _ := w.Old.Counts()
		totalBefore = before
		if ratio <= 0 || before < s.Cfg.GuardMinItems || float64(d.RemovedBookmarks) < ratio*float64(before) {
			return nil
		}
		c := d.Counts()
		p := &store.Pending{Actor: actor.Name, XBEL: gz(data), Added: c.Added, Removed: c.Removed, Changed: c.Changed, Moved: c.Moved,
			TotalBefore: before, Reason: fmt.Sprintf("这次上传会删除 %d 个书签（共 %d 个），已拦截，请到网页确认", d.RemovedBookmarks, before)}
		if actor.TokenID > 0 {
			id := actor.TokenID
			p.TokenID = &id
		}
		return p
	}
	res, err := s.writeLocked(ctx, lib, actor, WriteOpts{SkipFloccusLock: true, NoMerge: true, SyncActor: true, MigrateMeta: true, Guard: guard},
		func(w *WriteCtx) error { return replaceWithDoc(w, doc) })
	if err != nil {
		var pe *xbel.ParseError
		if errors.As(err, &pe) {
			s.hookUpload("rejected")
		}
		return nil, err
	}
	if res.PendingID > 0 {
		s.hookUpload("guarded")
		return nil, &GuardedError{PendingID: res.PendingID, Removed: res.Diff.RemovedBookmarks, Total: totalBefore}
	}
	if res.Changed {
		s.hookUpload("applied")
	} else {
		s.hookUpload("unchanged")
	}
	return &UploadResult{LibraryCreated: created, Revision: res.Revision, Changed: res.Changed}, nil
}

func (s *Service) hookUpload(result string) {
	if s.Hooks.Upload != nil {
		s.Hooks.Upload(result)
	}
}

// PendingDetail returns a pending upload with its diff against the tree it was based on.
func (s *Service) PendingDetail(ctx context.Context, lib *store.Library, id int64) (*store.Pending, *tree.Diff, error) {
	p, err := store.GetPending(ctx, s.DB, lib.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	data, err := gunzip(p.XBEL)
	if err != nil {
		return nil, nil, err
	}
	doc, err := xbel.Parse(data)
	if err != nil {
		return nil, nil, err
	}
	var base *tree.Tree
	if r, err := store.GetRevision(ctx, s.DB, lib.ID, p.BaseRevision, true); err == nil {
		snap, err := tree.DecodeSnapshot(r.Snapshot)
		if err != nil {
			return nil, nil, err
		}
		base = snap.Tree()
	} else {
		v, err := s.LoadView(ctx, lib)
		if err != nil {
			return nil, nil, err
		}
		base = v.Tree
	}
	w := &WriteCtx{Old: base, Tree: base.Clone()}
	if err := replaceWithDoc(w, doc); err != nil {
		return nil, nil, err
	}
	return p, tree.Compare(base, w.Tree), nil
}

// ApprovePending applies a guarded upload (design 6.5).
func (s *Service) ApprovePending(ctx context.Context, lib *store.Library, id int64, approver Actor) (*WriteResult, error) {
	unlock, err := s.acquire(ctx, lib.UserID, lib.Slug, false)
	if err != nil {
		return nil, err
	}
	defer unlock()
	p, err := store.GetPending(ctx, s.DB, lib.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	cur, err := store.GetLibraryByID(ctx, s.DB, lib.ID)
	if err != nil {
		return nil, err
	}
	if cur.Revision != p.BaseRevision {
		return nil, &ConflictError{Msg: "拦截之后库已有新的修改，请在该设备上重新同步后再处理"}
	}
	data, err := gunzip(p.XBEL)
	if err != nil {
		return nil, err
	}
	doc, err := xbel.Parse(data)
	if err != nil {
		return nil, err
	}
	actor := Actor{UserID: lib.UserID, Name: p.Actor + "（已确认）", Source: SourceWebDAV, TokenID: approver.TokenID}
	res, err := s.writeLocked(ctx, cur, actor, WriteOpts{NoMerge: true, MigrateMeta: true}, func(w *WriteCtx) error {
		return replaceWithDoc(w, doc)
	})
	if err != nil {
		return nil, err
	}
	if _, err := store.DeletePending(ctx, s.DB, lib.ID, id); err != nil {
		return nil, err
	}
	s.hookUpload("approved")
	return res, nil
}

// DiscardPending drops a guarded upload.
func (s *Service) DiscardPending(ctx context.Context, lib *store.Library, id int64) error {
	ok, err := store.DeletePending(ctx, s.DB, lib.ID, id)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// SanitizeText strips characters that cannot be stored in XBEL.
func SanitizeText(s string) string { return strings.TrimSpace(xbel.Clean(s)) }
