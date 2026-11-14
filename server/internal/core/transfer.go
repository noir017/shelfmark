package core

import (
	"context"
	"database/sql"

	"shelfmark/internal/store"
	"shelfmark/internal/tree"
)

// TransferResult reports a move between libraries.
type TransferResult struct {
	Source *WriteResult
	Target *WriteResult
	NewID  int64
}

// Transfer moves an item (with descendants) to another library of the same
// user. The target assigns new ids; notes, tags, visits, icons and link check
// results travel along. Both libraries get a revision in one transaction.
func (s *Service) Transfer(ctx context.Context, src, dst *store.Library, itemID, parentID int64, pos int, actor Actor) (*TransferResult, error) {
	if src.ID == dst.ID {
		return nil, Invalid("library", "目标库与源库相同，请直接移动")
	}
	unlock, err := s.acquireMany(ctx, []LibKey{{src.UserID, src.Slug}, {dst.UserID, dst.Slug}}, false)
	if err != nil {
		return nil, err
	}
	defer unlock()
	out := &TransferResult{}
	var afters []func()
	err = s.DB.Tx(ctx, func(tx *sql.Tx) error {
		meta, err := store.LoadMeta(ctx, tx, src.ID)
		if err != nil {
			return err
		}
		var moved *tree.Tree // the subtree, rooted at itemID
		var rootID int64
		res, after, err := s.WriteTx(ctx, tx, src, actor, WriteOpts{NoMerge: true}, func(w *WriteCtx) error {
			it := w.Tree.Get(itemID)
			if it == nil {
				return ErrNotFound
			}
			moved = tree.New()
			rootID = it.ID
			c := *it
			c.Tags = append([]string(nil), it.Tags...)
			moved.Insert(&c, 0, -1)
			var copyKids func(parent int64) error
			copyKids = func(parent int64) error {
				for _, id := range w.Tree.Children(parent) {
					k := *w.Tree.Get(id)
					k.Tags = append([]string(nil), k.Tags...)
					if err := moved.Insert(&k, parent, -1); err != nil {
						return err
					}
					if k.Type == tree.Folder {
						if err := copyKids(id); err != nil {
							return err
						}
					}
				}
				return nil
			}
			if it.Type == tree.Folder {
				if err := copyKids(it.ID); err != nil {
					return err
				}
			}
			w.Tree.Remove(itemID)
			return nil
		})
		if err != nil {
			return err
		}
		out.Source = res
		afters = append(afters, after)
		mapping := map[int64]int64{}
		res, after, err = s.WriteTx(ctx, tx, dst, actor, WriteOpts{NoMerge: true, SkipHooks: true}, func(w *WriteCtx) error {
			if !w.Tree.IsFolder(parentID) {
				if w.Tree.Get(parentID) == nil {
					return Invalid("parentId", "目标文件夹不存在")
				}
				return Invalid("parentId", "目标不是文件夹")
			}
			var add func(old, parent int64, pos int) error
			add = func(old, parent int64, pos int) error {
				src := moved.Get(old)
				id := w.Tree.NextID()
				mapping[old] = id
				n := &tree.Item{ID: id, Type: src.Type, Title: src.Title, URL: src.URL, Notes: src.Notes,
					Tags: append([]string(nil), src.Tags...), CreatedAt: src.CreatedAt}
				if err := w.Tree.Insert(n, parent, pos); err != nil {
					return err
				}
				for _, c := range moved.Children(old) {
					if err := add(c, id, -1); err != nil {
						return err
					}
				}
				return nil
			}
			return add(rootID, parentID, pos)
		})
		if err != nil {
			return err
		}
		out.Target = res
		out.NewID = mapping[rootID]
		afters = append(afters, after)
		for old, nw := range mapping {
			if m := meta[old]; m != nil {
				if err := store.CopyMeta(ctx, tx, dst.ID, nw, m); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for _, f := range afters {
		f()
	}
	return out, nil
}
