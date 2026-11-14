package core

import (
	"context"
	"errors"
	"sort"
	"time"

	"shelfmark/internal/store"
	"shelfmark/internal/tree"
)

// RevisionTree loads the snapshot tree of a revision.
func (s *Service) RevisionTree(ctx context.Context, libID, rev int64) (*store.Revision, *tree.Tree, error) {
	r, err := store.GetRevision(ctx, s.DB, libID, rev, true)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	snap, err := tree.DecodeSnapshot(r.Snapshot)
	if err != nil {
		return nil, nil, err
	}
	return r, snap.Tree(), nil
}

// prevTree is the snapshot before rev (empty tree for the first revision).
func (s *Service) prevTree(ctx context.Context, libID, rev int64) (*tree.Tree, error) {
	p, err := store.PrevRevision(ctx, s.DB, libID, rev, true)
	if errors.Is(err, store.ErrNotFound) {
		return tree.New(), nil
	}
	if err != nil {
		return nil, err
	}
	snap, err := tree.DecodeSnapshot(p.Snapshot)
	if err != nil {
		return nil, err
	}
	return snap.Tree(), nil
}

// RevisionDiff returns a revision and its diff against the previous one.
func (s *Service) RevisionDiff(ctx context.Context, libID, rev int64) (*store.Revision, *tree.Diff, error) {
	r, t, err := s.RevisionTree(ctx, libID, rev)
	if err != nil {
		return nil, nil, err
	}
	prev, err := s.prevTree(ctx, libID, rev)
	if err != nil {
		return nil, nil, err
	}
	return r, tree.Compare(prev, t), nil
}

// RestoreRevision replaces the tree with a revision's snapshot (ids kept,
// highest id never goes back).
func (s *Service) RestoreRevision(ctx context.Context, lib *store.Library, rev int64, actor Actor) (*WriteResult, error) {
	_, snapTree, err := s.RevisionTree(ctx, lib.ID, rev)
	if err != nil {
		return nil, err
	}
	actor.Source = SourceRestore
	return s.Write(ctx, lib, actor, WriteOpts{NoMerge: true}, func(w *WriteCtx) error {
		highest := w.Tree.HighestID
		w.Tree.Clear()
		var add func(parent int64) error
		add = func(parent int64) error {
			for _, id := range snapTree.Children(parent) {
				src := snapTree.Get(id)
				it := &tree.Item{ID: src.ID, Type: src.Type, Title: src.Title, URL: src.URL, Notes: src.Notes, Tags: append([]string(nil), src.Tags...)}
				if o := w.Old.Get(id); o != nil {
					it.CreatedAt = o.CreatedAt
				}
				if err := w.Tree.Insert(it, parent, -1); err != nil {
					return err
				}
				if src.Type == tree.Folder {
					if err := add(id); err != nil {
						return err
					}
				}
			}
			return nil
		}
		if err := add(0); err != nil {
			return err
		}
		w.Tree.HighestID = max(highest, snapTree.HighestID, w.Tree.HighestID)
		return nil
	})
}

// DeletedEntry is one item removed by a revision.
type DeletedEntry struct {
	Revision  int64
	DeletedAt time.Time
	Source    string
	Actor     string
	Item      tree.DiffItem
}

// ListDeleted summarizes removals of the last days, newest first.
func (s *Service) ListDeleted(ctx context.Context, lib *store.Library, days int) ([]DeletedEntry, error) {
	revs, err := store.RevisionsWithRemovals(ctx, s.DB, lib.ID, s.Now().Add(-time.Duration(days)*24*time.Hour))
	if err != nil {
		return nil, err
	}
	out := []DeletedEntry{}
	for _, r := range revs {
		_, d, err := s.RevisionDiff(ctx, lib.ID, r.Rev)
		if err != nil {
			return nil, err
		}
		for _, it := range d.Removed {
			out = append(out, DeletedEntry{Revision: r.Rev, DeletedAt: r.CreatedAt, Source: r.Source, Actor: r.Actor, Item: it})
		}
	}
	return out, nil
}

// RestoreEntry selects a deleted item.
type RestoreEntry struct {
	Revision int64
	ItemID   int64
}

// RestoreDeleted re-creates deleted items (with descendants) under new ids.
func (s *Service) RestoreDeleted(ctx context.Context, lib *store.Library, entries []RestoreEntry, actor Actor) (*WriteResult, int, error) {
	type source struct {
		entry RestoreEntry
		prev  *tree.Tree
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Revision > entries[j].Revision })
	var sources []source
	cache := map[int64]*tree.Tree{}
	for _, e := range entries {
		prev, ok := cache[e.Revision]
		if !ok {
			if _, err := store.GetRevision(ctx, s.DB, lib.ID, e.Revision, false); err != nil {
				if errors.Is(err, store.ErrNotFound) {
					return nil, 0, ErrNotFound
				}
				return nil, 0, err
			}
			var err error
			prev, err = s.prevTree(ctx, lib.ID, e.Revision)
			if err != nil {
				return nil, 0, err
			}
			cache[e.Revision] = prev
		}
		if prev.Get(e.ItemID) == nil {
			return nil, 0, ErrNotFound
		}
		sources = append(sources, source{entry: e, prev: prev})
	}
	restored := 0
	res, err := s.Write(ctx, lib, actor, WriteOpts{}, func(w *WriteCtx) error {
		mapped := map[int64]int64{} // old id -> new id (this request)
		var restoredFolder int64 = -1
		target := func(oldParent int64) (int64, error) {
			if oldParent == 0 {
				return 0, nil
			}
			if id, ok := mapped[oldParent]; ok {
				return id, nil
			}
			if w.Tree.IsFolder(oldParent) {
				return oldParent, nil
			}
			if restoredFolder < 0 {
				if f := w.Tree.FindChildFolder(0, RestoredName); f != nil {
					restoredFolder = f.ID
				} else {
					id := w.Tree.NextID()
					if err := w.Tree.Insert(&tree.Item{ID: id, Type: tree.Folder, Title: RestoredName}, 0, -1); err != nil {
						return 0, err
					}
					restoredFolder = id
				}
			}
			return restoredFolder, nil
		}
		for _, src := range sources {
			root := src.prev.Get(src.entry.ItemID)
			if _, done := mapped[root.ID]; done {
				continue
			}
			parent, err := target(root.ParentID)
			if err != nil {
				return err
			}
			var copyItem func(it *tree.Item, parent int64, pos int) error
			copyItem = func(it *tree.Item, parent int64, pos int) error {
				id := w.Tree.NextID()
				n := &tree.Item{ID: id, Type: it.Type, Title: it.Title, URL: it.URL, Notes: it.Notes, Tags: append([]string(nil), it.Tags...)}
				if err := w.Tree.Insert(n, parent, pos); err != nil {
					return err
				}
				mapped[it.ID] = id
				restored++
				if it.Type == tree.Folder {
					for _, c := range src.prev.Children(it.ID) {
						if err := copyItem(src.prev.Get(c), id, -1); err != nil {
							return err
						}
					}
				}
				return nil
			}
			pos := root.Position
			if parent != root.ParentID {
				pos = -1
			}
			if err := copyItem(root, parent, pos); err != nil {
				return err
			}
		}
		return nil
	})
	return res, restored, err
}

// Retention prunes revisions per design 6.4 and returns how many were deleted.
func (s *Service) Retention(ctx context.Context) (int, error) {
	libs, err := store.ListAllLibraries(ctx, s.DB)
	if err != nil {
		return 0, err
	}
	now := s.Now()
	keepAll := now.Add(-time.Duration(s.Cfg.RevisionKeepDays) * 24 * time.Hour)
	keepDaily := now.Add(-time.Duration(s.Cfg.RevisionKeepDays+s.Cfg.RevisionKeepDailyDays) * 24 * time.Hour)
	deleted := 0
	for _, lib := range libs {
		revs, err := store.AllRevisionsMeta(ctx, s.DB, lib.ID)
		if err != nil {
			return deleted, err
		}
		var drop []int64
		lastOfDay := map[string]int64{}
		for _, r := range revs {
			if !r.CreatedAt.Before(keepAll) {
				continue
			}
			lastOfDay[r.CreatedAt.Format("2006-01-02")] = r.Rev // ascending: last wins
		}
		for i, r := range revs {
			if i == len(revs)-1 || r.Rev == lib.Revision {
				continue // never drop the current revision
			}
			if !r.CreatedAt.Before(keepAll) {
				continue
			}
			if r.CreatedAt.Before(keepDaily) || lastOfDay[r.CreatedAt.Format("2006-01-02")] != r.Rev {
				drop = append(drop, r.Rev)
			}
		}
		if len(drop) == 0 {
			continue
		}
		unlock := s.LockLibrary(lib.UserID, lib.Slug)
		for _, rev := range drop {
			if err := store.DeleteRevision(ctx, s.DB, lib.ID, rev); err != nil {
				unlock()
				return deleted, err
			}
			deleted++
		}
		unlock()
	}
	return deleted, nil
}
