package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"shelfmark/internal/tree"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestMigrateAndPersist(t *testing.T) {
	ctx := context.Background()
	db := openTest(t)
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	u, err := CreateUser(ctx, db, "alice", "h", true, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateUser(ctx, db, "Alice", "h", false, now); err != ErrConflict {
		t.Fatalf("case-insensitive unique: %v", err)
	}
	lib, err := CreateLibrary(ctx, db, u.ID, "bookmarks", "bookmarks", now)
	if err != nil {
		t.Fatal(err)
	}
	old := tree.New()
	nw := tree.New()
	nw.Insert(&tree.Item{ID: 1, Type: tree.Folder, Title: "工具箱"}, 0, -1)
	nw.Insert(&tree.Item{ID: 2, Type: tree.Bookmark, Title: "Example 示例", URL: "https://Example.com/?utm_source=x", Tags: []string{"Go", "dev"}, Notes: "note"}, 1, -1)
	if err := db.Tx(ctx, func(tx *sql.Tx) error { return PersistTree(ctx, tx, u.ID, lib.ID, old, nw, now, nil) }); err != nil {
		t.Fatal(err)
	}
	got, err := LoadTree(ctx, db, lib.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	it := got.Get(2)
	if it == nil || it.Notes != "note" || len(it.Tags) != 2 || it.ParentID != 1 {
		t.Fatalf("loaded %+v", it)
	}
	m, _ := GetMeta(ctx, db, lib.ID, 2)
	if m.NormalizedURL != "https://example.com/" {
		t.Fatalf("normalized %q", m.NormalizedURL)
	}
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH '"示例"'`).Scan(&n)
	if n != 0 { // two-character terms are below the trigram size
		t.Fatalf("trigram short match %d", n)
	}
	db.QueryRow(`SELECT COUNT(*) FROM items_fts WHERE items_fts MATCH '"工具箱"'`).Scan(&n)
	if n != 1 {
		t.Fatalf("fts path match %d", n)
	}
	// remove and check cascade cleanup
	nw2 := got.Clone()
	nw2.Remove(1)
	if err := db.Tx(ctx, func(tx *sql.Tx) error { return PersistTree(ctx, tx, u.ID, lib.ID, got, nw2, now, nil) }); err != nil {
		t.Fatal(err)
	}
	db.QueryRow(`SELECT COUNT(*) FROM items_fts`).Scan(&n)
	if n != 0 {
		t.Fatalf("fts rows left %d", n)
	}
	tags, _ := ListTagCounts(ctx, db, u.ID)
	if len(tags) != 0 {
		t.Fatalf("orphan tags %v", tags)
	}
	if err := DeleteUser(ctx, db, u.ID); err != nil {
		t.Fatal(err)
	}
	db.QueryRow(`SELECT COUNT(*) FROM libraries`).Scan(&n)
	if n != 0 {
		t.Fatal("cascade")
	}
}
