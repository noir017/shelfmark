// Package core holds the library write path: per-library mutex, Floccus lock
// coordination, revisions, uploads, restores.
package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"shelfmark/internal/config"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
)

const (
	LockTimeout  = 15 * time.Minute
	MergeWindow  = 120 * time.Second
	MaxUpload    = 32 << 20
	DefaultSlug  = "bookmarks"
	InboxTitle   = "收件箱"
	RestoredName = "已恢复"
)

// Revision sources.
const (
	SourceWebDAV    = "webdav"
	SourceWeb       = "web"
	SourceAPI       = "api"
	SourceExtension = "extension"
	SourceImport    = "import"
	SourceRestore   = "restore"
	SourceSystem    = "system"
)

var (
	ErrNotFound = errors.New("不存在")
)

// LockedError: the library is being synced by Floccus.
type LockedError struct {
	Actor    string
	Since    time.Time
	Modified time.Time
}

func (e *LockedError) Error() string { return "库正被 " + e.Actor + " 同步锁定" }

// GuardedError: an upload was intercepted and stored as pending.
type GuardedError struct {
	PendingID int64
	Removed   int
	Total     int
}

func (e *GuardedError) Error() string {
	return fmt.Sprintf("这次上传会删除 %d 个书签（共 %d 个），已拦截，请到网页确认", e.Removed, e.Total)
}

// ValidationError carries per-field messages.
type ValidationError struct {
	Msg    string
	Fields map[string]string
}

func (e *ValidationError) Error() string { return e.Msg }

func Invalid(field, msg string) *ValidationError {
	return &ValidationError{Msg: msg, Fields: map[string]string{field: msg}}
}

// ConflictError: the request conflicts with the current state.
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

// Actor identifies who makes a change.
type Actor struct {
	UserID  int64
	Name    string
	Source  string
	TokenID int64
}

// Hooks lets other packages observe writes without import cycles.
type Hooks struct {
	// NewBookmarks is called after commit with bookmarks that were added;
	// fillTitle lists the ids whose title/description should be fetched.
	NewBookmarks func(userID, libID int64, ids []int64, fillTitle map[int64]bool)
	Upload       func(result string)
}

type Service struct {
	DB    *store.DB
	Cfg   *config.Config
	Log   *slog.Logger
	Now   func() time.Time
	Hooks Hooks

	LockWait time.Duration
	LockPoll time.Duration

	mu    sync.Mutex
	locks map[string]*sync.Mutex
	xbel  map[int64]*xbelEntry
}

func New(db *store.DB, cfg *config.Config, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{DB: db, Cfg: cfg, Log: log, Now: func() time.Time { return time.Now().UTC() },
		LockWait: 10 * time.Second, LockPoll: 250 * time.Millisecond,
		locks: map[string]*sync.Mutex{}, xbel: map[int64]*xbelEntry{}}
}

func (s *Service) mutex(userID int64, slug string) *sync.Mutex {
	key := fmt.Sprintf("%d/%s", userID, slug)
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.locks[key]
	if m == nil {
		m = &sync.Mutex{}
		s.locks[key] = m
	}
	return m
}

// LockLibrary takes the in-process mutex of a library (by slug).
func (s *Service) LockLibrary(userID int64, slug string) func() {
	m := s.mutex(userID, slug)
	m.Lock()
	return m.Unlock
}

// LockInfo describes the Floccus lock file of a library.
type LockInfo struct {
	Actor      string
	Since      time.Time
	ModifiedAt time.Time
	Fresh      bool
}

func LockFileName(slug string) string { return slug + ".xbel.lock" }

// FloccusLock returns the lock of a library, or nil when there is none.
func (s *Service) FloccusLock(ctx context.Context, q store.Q, userID int64, slug string) (*LockInfo, error) {
	f, err := store.StatDavFile(ctx, q, userID, LockFileName(slug))
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	info := &LockInfo{Actor: "未知设备", Since: f.CreatedAt, ModifiedAt: f.ModifiedAt, Fresh: s.Now().Sub(f.ModifiedAt) < LockTimeout}
	if f.TokenID != nil {
		if t, err := store.GetToken(ctx, q, *f.TokenID); err == nil {
			info.Actor = t.Name
		}
	}
	return info, nil
}

// acquire takes the library mutex; unless skipFloccus it waits (without
// holding the mutex) up to LockWait for a fresh Floccus lock to go away.
func (s *Service) acquire(ctx context.Context, userID int64, slug string, skipFloccus bool) (func(), error) {
	m := s.mutex(userID, slug)
	deadline := time.Now().Add(s.LockWait)
	for {
		m.Lock()
		if skipFloccus {
			return m.Unlock, nil
		}
		info, err := s.FloccusLock(ctx, s.DB, userID, slug)
		if err != nil {
			m.Unlock()
			return nil, err
		}
		if info == nil || !info.Fresh {
			return m.Unlock, nil
		}
		m.Unlock()
		if !time.Now().Before(deadline) {
			return nil, &LockedError{Actor: info.Actor, Since: info.Since, Modified: info.ModifiedAt}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(s.LockPoll):
		}
	}
}

// WriteCtx is handed to write callbacks.
type WriteCtx struct {
	Ctx  context.Context
	Tx   *sql.Tx
	Lib  *store.Library
	Old  *tree.Tree
	Tree *tree.Tree
	Now  time.Time
	// FillTitle marks new bookmarks whose title should be fetched.
	FillTitle map[int64]bool
}

// WriteOpts tunes Write.
type WriteOpts struct {
	SkipFloccusLock bool
	NoMerge         bool
	SyncActor       bool
	MigrateMeta     bool
	// Guard may return a pending upload instead of applying the change.
	Guard func(w *WriteCtx, d *tree.Diff) *store.Pending
}

// WriteResult reports what a write did.
type WriteResult struct {
	Revision  int64
	Changed   bool
	Diff      *tree.Diff
	Tree      *tree.Tree
	Library   *store.Library
	PendingID int64
}

func mergeable(source string) bool {
	return source == SourceWeb || source == SourceAPI || source == SourceExtension
}

// Write runs fn on a copy of the library tree and stores the result with a
// revision. All writes to items go through here.
func (s *Service) Write(ctx context.Context, lib *store.Library, actor Actor, opts WriteOpts, fn func(w *WriteCtx) error) (*WriteResult, error) {
	unlock, err := s.acquire(ctx, lib.UserID, lib.Slug, opts.SkipFloccusLock)
	if err != nil {
		return nil, err
	}
	defer unlock()
	return s.writeLocked(ctx, lib, actor, opts, fn)
}

func (s *Service) writeLocked(ctx context.Context, lib *store.Library, actor Actor, opts WriteOpts, fn func(w *WriteCtx) error) (*WriteResult, error) {
	res := &WriteResult{}
	var fill map[int64]bool
	var added []int64
	now := s.Now()
	err := s.DB.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := store.GetLibraryByID(ctx, tx, lib.ID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return ErrNotFound
			}
			return err
		}
		old, err := store.LoadTree(ctx, tx, cur.ID, cur.HighestID)
		if err != nil {
			return err
		}
		w := &WriteCtx{Ctx: ctx, Tx: tx, Lib: cur, Old: old, Tree: old.Clone(), Now: now, FillTitle: map[int64]bool{}}
		if err := fn(w); err != nil {
			return err
		}
		nw := w.Tree
		var moves map[int64]int64
		if opts.MigrateMeta {
			moves = migrateMeta(old, nw)
		}
		diff := tree.Compare(old, nw)
		res.Diff = diff
		if opts.Guard != nil {
			if p := opts.Guard(w, diff); p != nil {
				p.LibraryID = cur.ID
				p.BaseRevision = cur.Revision
				p.CreatedAt = now
				id, err := store.UpsertPending(ctx, tx, p)
				if err != nil {
					return err
				}
				res.PendingID = id
				res.Library = cur
				res.Revision = cur.Revision
				return nil
			}
		}
		if err := store.PersistTree(ctx, tx, cur.UserID, cur.ID, old, nw, now, moves); err != nil {
			return err
		}
		highest := max(cur.HighestID, nw.HighestID)
		nw.HighestID = highest
		raw, hash := nw.Snapshot().Encode()
		latest, err := store.LatestRevision(ctx, tx, cur.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		rev := cur.Revision
		changed := false
		switch {
		case latest != nil && latest.SnapshotHash == hash:
		case latest == nil && diff.Empty() && highest == cur.HighestID:
		default:
			changed = true
			counts := diff.Counts()
			if !opts.NoMerge && latest != nil && mergeable(actor.Source) && latest.Rev == cur.Revision &&
				latest.Source == actor.Source && latest.Actor == actor.Name && now.Sub(latest.CreatedAt) < MergeWindow {
				base := tree.New()
				prev, err := store.PrevRevision(ctx, tx, cur.ID, latest.Rev, true)
				if err == nil {
					snap, err := tree.DecodeSnapshot(prev.Snapshot)
					if err != nil {
						return err
					}
					base = snap.Tree()
				} else if !errors.Is(err, store.ErrNotFound) {
					return err
				}
				counts = tree.Compare(base, nw).Counts()
				if err := store.DeleteRevision(ctx, tx, cur.ID, latest.Rev); err != nil {
					return err
				}
			}
			bookmarks, _ := nw.Counts()
			rev = cur.Revision + 1
			if err := store.InsertRevision(ctx, tx, &store.Revision{LibraryID: cur.ID, Rev: rev, CreatedAt: now, Source: actor.Source, Actor: actor.Name,
				Added: counts.Added, Removed: counts.Removed, Changed: counts.Changed, Moved: counts.Moved, TotalBookmarks: bookmarks,
				Snapshot: tree.Gzip(raw), SnapshotHash: hash}); err != nil {
				return err
			}
		}
		if changed || highest != cur.HighestID {
			if err := store.SetLibraryState(ctx, tx, cur.ID, rev, highest, now); err != nil {
				return err
			}
		}
		if opts.SyncActor {
			if err := store.SetLibrarySync(ctx, tx, cur.ID, actor.Name, now); err != nil {
				return err
			}
		}
		for _, it := range nw.Items() {
			if it.Type == tree.Bookmark && old.Get(it.ID) == nil {
				added = append(added, it.ID)
			}
		}
		fill = w.FillTitle
		res.Revision, res.Changed, res.Tree = rev, changed, nw
		res.Library, err = store.GetLibraryByID(ctx, tx, cur.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if len(added) > 0 && s.Hooks.NewBookmarks != nil && res.PendingID == 0 {
		s.Hooks.NewBookmarks(lib.UserID, lib.ID, added, fill)
	}
	return res, nil
}

// migrateMeta pairs removed bookmarks with added ones of the same normalized
// URL (a browser that changed ids) and carries notes and tags over.
func migrateMeta(old, nw *tree.Tree) map[int64]int64 {
	removed := map[string][]*tree.Item{}
	for _, it := range old.Items() {
		if it.Type == tree.Bookmark && nw.Get(it.ID) == nil {
			k := normalize(it.URL)
			removed[k] = append(removed[k], it)
		}
	}
	if len(removed) == 0 {
		return nil
	}
	moves := map[int64]int64{}
	for _, it := range nw.Items() {
		if it.Type != tree.Bookmark || old.Get(it.ID) != nil {
			continue
		}
		k := normalize(it.URL)
		cands := removed[k]
		if len(cands) == 0 {
			continue
		}
		from := cands[0]
		removed[k] = cands[1:]
		moves[from.ID] = it.ID
		if it.Notes == "" {
			it.Notes = from.Notes
		}
		if len(it.Tags) == 0 {
			it.Tags = append([]string(nil), from.Tags...)
		}
		if !from.CreatedAt.IsZero() {
			it.CreatedAt = from.CreatedAt
		}
	}
	return moves
}

// GetLibrary loads a library of a user by slug.
func (s *Service) GetLibrary(ctx context.Context, userID int64, slug string) (*store.Library, error) {
	l, err := store.GetLibrary(ctx, s.DB, userID, slug)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNotFound
	}
	return l, err
}

// View is a consistent read of a library: tree plus metadata.
type View struct {
	Lib  *store.Library
	Tree *tree.Tree
	Meta map[int64]*store.Meta
}

// LoadView reads a library tree with metadata in one read transaction.
func (s *Service) LoadView(ctx context.Context, lib *store.Library) (*View, error) {
	v := &View{}
	err := s.DB.ReadTx(ctx, func(tx *sql.Tx) error {
		cur, err := store.GetLibraryByID(ctx, tx, lib.ID)
		if err != nil {
			return err
		}
		t, err := store.LoadTree(ctx, tx, cur.ID, cur.HighestID)
		if err != nil {
			return err
		}
		m, err := store.LoadMeta(ctx, tx, cur.ID)
		if err != nil {
			return err
		}
		v.Lib, v.Tree, v.Meta = cur, t, m
		return nil
	})
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNotFound
	}
	return v, err
}
