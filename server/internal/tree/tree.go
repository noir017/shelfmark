// Package tree is the in-memory bookmark tree used for writes, snapshots and diffs.
package tree

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	Folder   = "folder"
	Bookmark = "bookmark"
)

var (
	ErrNotFound  = errors.New("条目不存在")
	ErrNotFolder = errors.New("父条目不是文件夹")
	ErrCycle     = errors.New("不能把文件夹移到自身或其子文件夹里")
	ErrExists    = errors.New("条目 ID 已存在")
)

// Item is one folder or bookmark. Notes and tags are metadata that travel
// with snapshots; timestamps are not part of snapshots.
type Item struct {
	ID        int64
	ParentID  int64
	Position  int
	Type      string
	Title     string
	URL       string
	Notes     string
	Tags      []string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (it *Item) clone() *Item {
	c := *it
	c.Tags = append([]string(nil), it.Tags...)
	return &c
}

// Tree is an ordered forest under the virtual root 0.
type Tree struct {
	HighestID int64
	items     map[int64]*Item
	kids      map[int64][]int64
}

func New() *Tree {
	return &Tree{items: map[int64]*Item{}, kids: map[int64][]int64{}}
}

// Build assembles a tree from flat items ordered by (parent, position).
// Items whose parent is missing are attached to the root.
func Build(items []Item, highestID int64) *Tree {
	t := New()
	t.HighestID = highestID
	sorted := make([]*Item, len(items))
	for i := range items {
		it := items[i]
		sorted[i] = &it
		t.items[it.ID] = sorted[i]
	}
	sort.SliceStable(sorted, func(a, b int) bool {
		if sorted[a].ParentID != sorted[b].ParentID {
			return sorted[a].ParentID < sorted[b].ParentID
		}
		return sorted[a].Position < sorted[b].Position
	})
	for _, it := range sorted {
		p := it.ParentID
		if p != 0 {
			if parent, ok := t.items[p]; !ok || parent.Type != Folder || p == it.ID {
				it.ParentID = 0
				p = 0
			}
		}
		t.kids[p] = append(t.kids[p], it.ID)
	}
	// break cycles: anything not reachable from the root goes to the root
	reach := map[int64]bool{}
	var mark func(int64)
	mark = func(id int64) {
		for _, c := range t.kids[id] {
			if !reach[c] {
				reach[c] = true
				mark(c)
			}
		}
	}
	mark(0)
	if len(reach) != len(t.items) {
		for _, it := range sorted {
			if !reach[it.ID] {
				t.detach(it.ID)
				it.ParentID = 0
				t.kids[0] = append(t.kids[0], it.ID)
				reach[it.ID] = true
				mark(it.ID)
			}
		}
	}
	for p := range t.kids {
		t.renumber(p)
	}
	for id := range t.items {
		if id > t.HighestID {
			t.HighestID = id
		}
	}
	return t
}

func (t *Tree) Clone() *Tree {
	c := &Tree{HighestID: t.HighestID, items: make(map[int64]*Item, len(t.items)), kids: make(map[int64][]int64, len(t.kids))}
	for id, it := range t.items {
		c.items[id] = it.clone()
	}
	for p, k := range t.kids {
		c.kids[p] = append([]int64(nil), k...)
	}
	return c
}

func (t *Tree) Len() int { return len(t.items) }

func (t *Tree) Get(id int64) *Item { return t.items[id] }

// Children returns the ordered child ids of parent (do not modify).
func (t *Tree) Children(parent int64) []int64 { return t.kids[parent] }

// IsFolder reports whether id is the root or a folder.
func (t *Tree) IsFolder(id int64) bool {
	if id == 0 {
		return true
	}
	it := t.items[id]
	return it != nil && it.Type == Folder
}

// NextID hands out highestId + 1.
func (t *Tree) NextID() int64 {
	t.HighestID++
	for t.items[t.HighestID] != nil || t.HighestID == 0 {
		t.HighestID++
	}
	return t.HighestID
}

func (t *Tree) renumber(parent int64) {
	for i, id := range t.kids[parent] {
		it := t.items[id]
		it.Position = i
		it.ParentID = parent
	}
	if len(t.kids[parent]) == 0 {
		delete(t.kids, parent)
	}
}

func (t *Tree) detach(id int64) {
	it := t.items[id]
	k := t.kids[it.ParentID]
	for i, c := range k {
		if c == id {
			t.kids[it.ParentID] = append(k[:i:i], k[i+1:]...)
			break
		}
	}
	t.renumber(it.ParentID)
}

func (t *Tree) attach(id, parent int64, pos int) {
	k := t.kids[parent]
	if pos < 0 || pos > len(k) {
		pos = len(k)
	}
	k = append(k, 0)
	copy(k[pos+1:], k[pos:])
	k[pos] = id
	t.kids[parent] = k
	t.renumber(parent)
}

// Insert adds a new item under parent at pos (pos < 0 or past the end appends).
func (t *Tree) Insert(it *Item, parent int64, pos int) error {
	if _, ok := t.items[it.ID]; ok || it.ID == 0 {
		return ErrExists
	}
	if !t.IsFolder(parent) {
		if t.items[parent] == nil {
			return ErrNotFound
		}
		return ErrNotFolder
	}
	if it.Type == Folder {
		it.URL = ""
	}
	t.items[it.ID] = it
	it.ParentID = parent
	t.attach(it.ID, parent, pos)
	if it.ID > t.HighestID {
		t.HighestID = it.ID
	}
	return nil
}

// Move relocates id under parent at pos. Within the same parent, pos is the
// index in the resulting order.
func (t *Tree) Move(id, parent int64, pos int) error {
	it := t.items[id]
	if it == nil {
		return ErrNotFound
	}
	if !t.IsFolder(parent) {
		if t.items[parent] == nil {
			return ErrNotFound
		}
		return ErrNotFolder
	}
	if parent == id || t.IsAncestor(id, parent) {
		return ErrCycle
	}
	t.detach(id)
	t.attach(id, parent, pos)
	return nil
}

// Remove deletes id and its descendants, returning them in pre-order.
func (t *Tree) Remove(id int64) []*Item {
	it := t.items[id]
	if it == nil {
		return nil
	}
	var out []*Item
	var rec func(int64)
	rec = func(x int64) {
		out = append(out, t.items[x])
		for _, c := range t.kids[x] {
			rec(c)
		}
		delete(t.kids, x)
		delete(t.items, x)
	}
	t.detach(id)
	rec(id)
	return out
}

// Clear removes everything (highestId is kept).
func (t *Tree) Clear() {
	t.items = map[int64]*Item{}
	t.kids = map[int64][]int64{}
}

// IsAncestor reports whether a is a proper ancestor of b.
func (t *Tree) IsAncestor(a, b int64) bool {
	for cur := t.items[b]; cur != nil && cur.ParentID != 0; cur = t.items[cur.ParentID] {
		if cur.ParentID == a {
			return true
		}
	}
	return false
}

// Walk visits items depth-first in order. Returning false skips the subtree.
func (t *Tree) Walk(fn func(it *Item, depth int) bool) {
	var rec func(parent int64, depth int)
	rec = func(parent int64, depth int) {
		for _, id := range t.kids[parent] {
			it := t.items[id]
			if fn(it, depth) && it.Type == Folder {
				rec(id, depth+1)
			}
		}
	}
	rec(0, 0)
}

// WalkFrom is Walk restricted to the subtree below parent.
func (t *Tree) WalkFrom(parent int64, fn func(it *Item, depth int) bool) {
	var rec func(p int64, depth int)
	rec = func(p int64, depth int) {
		for _, id := range t.kids[p] {
			it := t.items[id]
			if fn(it, depth) && it.Type == Folder {
				rec(id, depth+1)
			}
		}
	}
	rec(parent, 0)
}

// Path returns the titles and ids of the ancestors of id, root first.
func (t *Tree) Path(id int64) ([]string, []int64) {
	titles := []string{}
	ids := []int64{}
	it := t.items[id]
	if it == nil {
		return titles, ids
	}
	for p := t.items[it.ParentID]; p != nil; p = t.items[p.ParentID] {
		titles = append(titles, p.Title)
		ids = append(ids, p.ID)
		if len(ids) > 1000 {
			break
		}
	}
	for i, j := 0, len(titles)-1; i < j; i, j = i+1, j-1 {
		titles[i], titles[j] = titles[j], titles[i]
		ids[i], ids[j] = ids[j], ids[i]
	}
	return titles, ids
}

// Counts returns the number of bookmarks and folders.
func (t *Tree) Counts() (bookmarks, folders int) {
	for _, it := range t.items {
		if it.Type == Bookmark {
			bookmarks++
		} else {
			folders++
		}
	}
	return
}

// DescendantBookmarks counts bookmarks below id.
func (t *Tree) DescendantBookmarks(id int64) int {
	n := 0
	t.WalkFrom(id, func(it *Item, _ int) bool {
		if it.Type == Bookmark {
			n++
		}
		return true
	})
	return n
}

// Items returns all items ordered by (parent, position).
func (t *Tree) Items() []*Item {
	out := make([]*Item, 0, len(t.items))
	parents := make([]int64, 0, len(t.kids))
	for p := range t.kids {
		parents = append(parents, p)
	}
	sort.Slice(parents, func(i, j int) bool { return parents[i] < parents[j] })
	for _, p := range parents {
		for _, id := range t.kids[p] {
			out = append(out, t.items[id])
		}
	}
	return out
}

// FindChildFolder finds a folder by exact title directly under parent.
func (t *Tree) FindChildFolder(parent int64, title string) *Item {
	for _, id := range t.kids[parent] {
		if it := t.items[id]; it.Type == Folder && it.Title == title {
			return it
		}
	}
	return nil
}

// Validate checks internal consistency (used by tests).
func (t *Tree) Validate() error {
	seen := 0
	for p, k := range t.kids {
		if p != 0 && !t.IsFolder(p) {
			return fmt.Errorf("parent %d is not a folder", p)
		}
		for i, id := range k {
			it := t.items[id]
			if it == nil || it.ParentID != p || it.Position != i {
				return fmt.Errorf("bad child %d of %d at %d", id, p, i)
			}
			seen++
		}
	}
	if seen != len(t.items) {
		return fmt.Errorf("%d items linked, %d total", seen, len(t.items))
	}
	return nil
}

// NormalizeTags trims, drops empties and case-insensitive duplicates, keeping order.
func NormalizeTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, tg := range tags {
		tg = strings.TrimSpace(tg)
		k := strings.ToLower(tg)
		if tg == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, tg)
	}
	return out
}

// SortedTags returns a case-insensitively sorted copy.
func SortedTags(tags []string) []string {
	out := append([]string{}, tags...)
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i]), strings.ToLower(out[j])
		if a != b {
			return a < b
		}
		return out[i] < out[j]
	})
	return out
}

// TagsEqual compares tag sets case-insensitively.
func TagsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	sa, sb := SortedTags(a), SortedTags(b)
	for i := range sa {
		if sa[i] != sb[i] {
			return false
		}
	}
	return true
}
