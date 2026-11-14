package tree

import "testing"

func sample() *Tree {
	return Build([]Item{
		{ID: 1, ParentID: 0, Position: 0, Type: Folder, Title: "A"},
		{ID: 2, ParentID: 1, Position: 0, Type: Bookmark, Title: "a1", URL: "https://example.com/1"},
		{ID: 3, ParentID: 1, Position: 1, Type: Bookmark, Title: "a2", URL: "https://example.com/2"},
		{ID: 4, ParentID: 0, Position: 1, Type: Bookmark, Title: "b", URL: "https://example.com/b"},
		{ID: 5, ParentID: 0, Position: 2, Type: Folder, Title: "C"},
	}, 5)
}

func TestTreeOps(t *testing.T) {
	tr := sample()
	if err := tr.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := tr.Move(1, 1, 0); err != ErrCycle {
		t.Fatalf("self move: %v", err)
	}
	if err := tr.Move(4, 2, 0); err != ErrNotFolder {
		t.Fatalf("into bookmark: %v", err)
	}
	if err := tr.Move(4, 1, 0); err != nil {
		t.Fatal(err)
	}
	if got := tr.Children(1); len(got) != 3 || got[0] != 4 {
		t.Fatalf("children %v", got)
	}
	id := tr.NextID()
	if id != 6 {
		t.Fatalf("next id %d", id)
	}
	if err := tr.Insert(&Item{ID: id, Type: Bookmark, Title: "new"}, 5, -1); err != nil {
		t.Fatal(err)
	}
	removed := tr.Remove(1)
	if len(removed) != 4 {
		t.Fatalf("removed %d", len(removed))
	}
	if err := tr.Validate(); err != nil {
		t.Fatal(err)
	}
	if p, _ := tr.Path(6); len(p) != 1 || p[0] != "C" {
		t.Fatalf("path %v", p)
	}
}

func TestBuildRepairsOrphansAndCycles(t *testing.T) {
	tr := Build([]Item{
		{ID: 1, ParentID: 99, Type: Bookmark},
		{ID: 2, ParentID: 3, Type: Folder},
		{ID: 3, ParentID: 2, Type: Folder},
	}, 0)
	if err := tr.Validate(); err != nil {
		t.Fatal(err)
	}
	if tr.HighestID != 3 {
		t.Fatalf("highest %d", tr.HighestID)
	}
}

func TestDiff(t *testing.T) {
	old := sample()
	nw := old.Clone()
	nw.Get(2).Title = "a1 renamed"
	nw.Move(4, 5, 0)
	nw.Remove(1) // removes 1, 2, 3
	id := nw.NextID()
	nw.Insert(&Item{ID: id, Type: Folder, Title: "N"}, 0, 0)
	nw.Insert(&Item{ID: nw.NextID(), Type: Bookmark, Title: "n1", URL: "https://example.com/n"}, id, 0)
	d := Compare(old, nw)
	c := d.Counts()
	if c.Added != 2 || len(d.Added) != 1 || *d.Added[0].ChildCount != 1 {
		t.Fatalf("added %+v %+v", c, d.Added)
	}
	if c.Removed != 3 || len(d.Removed) != 1 || d.RemovedBookmarks != 2 || *d.Removed[0].ChildCount != 2 {
		t.Fatalf("removed %+v %+v", c, d.Removed)
	}
	if len(d.Moved) != 1 || d.Moved[0].ToPath[0] != "C" {
		t.Fatalf("moved %+v", d.Moved)
	}
	if len(d.Changed) != 0 {
		t.Fatalf("changed in removed folder should not count: %+v", d.Changed)
	}
}

func TestReorderCount(t *testing.T) {
	old := sample()
	nw := old.Clone()
	nw.Move(5, 0, 0) // C to the front: one reorder
	id := nw.NextID()
	nw.Insert(&Item{ID: id, Type: Bookmark, URL: "x"}, 0, 0) // insert shifts positions but is no reorder
	d := Compare(old, nw)
	if d.ReorderedCount != 1 || len(d.Moved) != 0 {
		t.Fatalf("reordered %d moved %d", d.ReorderedCount, len(d.Moved))
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	tr := sample()
	tr.Get(2).Notes = "note"
	tr.Get(2).Tags = []string{"b", "A"}
	raw, hash := tr.Snapshot().Encode()
	s, err := DecodeSnapshot(Gzip(raw))
	if err != nil {
		t.Fatal(err)
	}
	raw2, hash2 := s.Tree().Snapshot().Encode()
	if hash != hash2 || string(raw) != string(raw2) {
		t.Fatalf("snapshot not stable\n%s\n%s", raw, raw2)
	}
}
