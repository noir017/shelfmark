package tree

import "sort"

// DiffItem is an added or removed item (top-most only; descendants are folded in).
type DiffItem struct {
	ID         int64    `json:"id"`
	Type       string   `json:"type"`
	Title      string   `json:"title"`
	URL        *string  `json:"url"`
	Path       []string `json:"path"`
	Notes      *string  `json:"notes"`
	Tags       []string `json:"tags"`
	ChildCount *int     `json:"childCount,omitempty"`
}

type TitleURL struct {
	Title string  `json:"title"`
	URL   *string `json:"url"`
}

type DiffChange struct {
	ID     int64    `json:"id"`
	Type   string   `json:"type"`
	Path   []string `json:"path"`
	Before TitleURL `json:"before"`
	After  TitleURL `json:"after"`
}

type DiffMove struct {
	ID           int64    `json:"id"`
	Type         string   `json:"type"`
	Title        string   `json:"title"`
	URL          *string  `json:"url"`
	FromPath     []string `json:"fromPath"`
	ToPath       []string `json:"toPath"`
	FromPosition int      `json:"fromPosition"`
	ToPosition   int      `json:"toPosition"`
}

// Diff matches the Diff schema of the API.
type Diff struct {
	Added          []DiffItem   `json:"added"`
	Removed        []DiffItem   `json:"removed"`
	Changed        []DiffChange `json:"changed"`
	Moved          []DiffMove   `json:"moved"`
	ReorderedCount int          `json:"reorderedCount"`

	// counts (every item, not only top-most)
	AddedCount       int `json:"-"`
	RemovedCount     int `json:"-"`
	RemovedBookmarks int `json:"-"`
	MetaChanged      int `json:"-"`
}

// Counts are the numbers stored on revisions and pending uploads.
type Counts struct {
	Added, Removed, Changed, Moved int
}

func (d *Diff) Counts() Counts {
	return Counts{Added: d.AddedCount, Removed: d.RemovedCount, Changed: len(d.Changed), Moved: len(d.Moved) + d.ReorderedCount}
}

func urlPtr(it *Item) *string {
	if it.Type != Bookmark {
		return nil
	}
	u := it.URL
	return &u
}

func diffItem(t *Tree, it *Item) DiffItem {
	p, _ := t.Path(it.ID)
	d := DiffItem{ID: it.ID, Type: it.Type, Title: it.Title, URL: urlPtr(it), Path: p, Notes: strPtr(it.Notes), Tags: SortedTags(it.Tags)}
	if it.Type == Folder {
		n := t.DescendantBookmarks(it.ID)
		d.ChildCount = &n
	}
	return d
}

// Compare computes what changed from old to new, matching items by id.
func Compare(old, new *Tree) *Diff {
	d := &Diff{Added: []DiffItem{}, Removed: []DiffItem{}, Changed: []DiffChange{}, Moved: []DiffMove{}}
	// removed: list top-most only
	old.Walk(func(it *Item, _ int) bool {
		if new.items[it.ID] != nil {
			return true
		}
		d.Removed = append(d.Removed, diffItem(old, it))
		old.WalkFrom(it.ID, func(c *Item, _ int) bool {
			if new.items[c.ID] == nil {
				d.RemovedCount++
				if c.Type == Bookmark {
					d.RemovedBookmarks++
				}
			}
			return true
		})
		d.RemovedCount++
		if it.Type == Bookmark {
			d.RemovedBookmarks++
		}
		return false
	})
	new.Walk(func(it *Item, _ int) bool {
		o := old.items[it.ID]
		if o == nil {
			d.AddedCount++
			if p := new.items[it.ParentID]; p == nil || old.items[p.ID] != nil {
				d.Added = append(d.Added, diffItem(new, it))
			}
			return true
		}
		if o.Type == it.Type && (o.Title != it.Title || o.URL != it.URL) {
			p, _ := new.Path(it.ID)
			d.Changed = append(d.Changed, DiffChange{ID: it.ID, Type: it.Type, Path: p,
				Before: TitleURL{Title: o.Title, URL: urlPtr(o)}, After: TitleURL{Title: it.Title, URL: urlPtr(it)}})
		} else if o.Notes != it.Notes || !TagsEqual(o.Tags, it.Tags) {
			d.MetaChanged++
		}
		if o.ParentID != it.ParentID {
			from, _ := old.Path(it.ID)
			to, _ := new.Path(it.ID)
			d.Moved = append(d.Moved, DiffMove{ID: it.ID, Type: it.Type, Title: it.Title, URL: urlPtr(it),
				FromPath: from, ToPath: to, FromPosition: o.Position, ToPosition: it.Position})
		}
		return true
	})
	// added items inside an added folder are counted but not listed (except top-most)
	d.Added = topMost(new, d.Added, old)
	// reorders: siblings kept in the same parent whose relative order changed
	parents := map[int64]bool{}
	for p := range new.kids {
		parents[p] = true
	}
	for p := range parents {
		var seq []int
		for _, id := range new.kids[p] {
			if o := old.items[id]; o != nil && o.ParentID == p {
				seq = append(seq, o.Position)
			}
		}
		d.ReorderedCount += len(seq) - lisLen(seq)
	}
	sort.Slice(d.Changed, func(i, j int) bool { return d.Changed[i].ID < d.Changed[j].ID })
	sort.Slice(d.Moved, func(i, j int) bool { return d.Moved[i].ID < d.Moved[j].ID })
	return d
}

func topMost(t *Tree, items []DiffItem, old *Tree) []DiffItem {
	out := items[:0]
	for _, it := range items {
		top := true
		for p := t.items[t.items[it.ID].ParentID]; p != nil; p = t.items[p.ParentID] {
			if old.items[p.ID] == nil {
				top = false
				break
			}
		}
		if top {
			out = append(out, it)
		}
	}
	return out
}

// lisLen returns the length of the longest increasing subsequence.
func lisLen(seq []int) int {
	var tails []int
	for _, x := range seq {
		i := sort.SearchInts(tails, x)
		if i == len(tails) {
			tails = append(tails, x)
		} else {
			tails[i] = x
		}
	}
	return len(tails)
}

// Empty reports whether nothing at all changed (including notes and tags).
func (d *Diff) Empty() bool {
	return d.AddedCount == 0 && d.RemovedCount == 0 && len(d.Changed) == 0 && len(d.Moved) == 0 && d.ReorderedCount == 0 && d.MetaChanged == 0
}
