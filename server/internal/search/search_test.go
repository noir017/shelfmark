package search

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"shelfmark/internal/store"
	"shelfmark/internal/tree"
)

func TestParse(t *testing.T) {
	q := Parse(`go "exact phrase" #Dev site:www.Example.com in:"工具 箱" lib:work is:broken is:duplicate -spam -"bad words" ab`)
	want := Query{Terms: []string{"go", "exact phrase", "ab"}, Excludes: []string{"spam", "bad words"}, Tags: []string{"Dev"},
		Sites: []string{"example.com"}, Ins: []string{"工具 箱"}, Libs: []string{"work"}, Broken: true, Duplicate: true}
	if !reflect.DeepEqual(q, want) {
		t.Fatalf("%+v", q)
	}
}

func TestRun(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	u, _ := store.CreateUser(ctx, db, "alice", "x", true, now)
	lib, _ := store.CreateLibrary(ctx, db, u.ID, "bookmarks", "bookmarks", now)
	work, _ := store.CreateLibrary(ctx, db, u.ID, "work", "work", now)
	t1 := tree.New()
	t1.Insert(&tree.Item{ID: 1, Type: tree.Folder, Title: "开发工具"}, 0, -1)
	t1.Insert(&tree.Item{ID: 2, Type: tree.Bookmark, Title: "Go 语言文档", URL: "https://go.dev/doc/", Tags: []string{"golang"}}, 1, -1)
	t1.Insert(&tree.Item{ID: 3, Type: tree.Bookmark, Title: "Rust Book", URL: "https://doc.rust-lang.org/book/", Notes: "golang alternative <b>"}, 1, -1)
	t1.Insert(&tree.Item{ID: 4, Type: tree.Bookmark, Title: "Example", URL: "https://www.example.com/a"}, 0, -1)
	t2 := tree.New()
	t2.Insert(&tree.Item{ID: 1, Type: tree.Bookmark, Title: "Example copy", URL: "https://www.example.com/a/#top"}, 0, -1)
	db.Tx(ctx, func(tx *sql.Tx) error {
		if err := store.PersistTree(ctx, tx, u.ID, lib.ID, tree.New(), t1, now, nil); err != nil {
			return err
		}
		return store.PersistTree(ctx, tx, u.ID, work.ID, tree.New(), t2, now, nil)
	})
	store.RecordVisit(ctx, db, lib.ID, 3, now)
	store.SetHealth(ctx, db, lib.ID, 4, store.Health{Status: "broken", HTTP: 404, CheckedAt: now})
	ids := func(q string, library string) []int64 {
		_, hits, err := Run(ctx, db, u.ID, Parse(q), library, 50, 0)
		if err != nil {
			t.Fatal(err)
		}
		var out []int64
		for _, h := range hits {
			out = append(out, h.LibraryID*100+h.ItemID)
		}
		return out
	}
	check := func(q, lib string, want ...int64) {
		t.Helper()
		got := ids(q, lib)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q: %v, want %v", q, got, want)
		}
	}
	l, w := lib.ID*100, work.ID*100
	if got := ids("golang", ""); len(got) != 2 {
		t.Errorf("golang: %v", got)
	}
	check("文档", "", l+2) // two characters: LIKE fallback
	check("in:开发 -rust", "", l+2)
	check("#GoLang", "", l+2)
	check("site:example.com", "", l+4, w+1)
	check("site:example.com lib:work", "", w+1)
	check("example", "work", w+1)
	check("is:broken", "", l+4)
	check("is:duplicate", "", l+4, w+1)
	check("is:duplicate", "bookmarks")
	check(`"rust book"`, "", l+3)
	_, hits, _ := Run(ctx, db, u.ID, Parse("rust golang"), "", 50, 0)
	if len(hits) != 1 || hits[0].Highlights["notes"] != "<mark>golang</mark> alternative &lt;b&gt;" || hits[0].Highlights["title"] != "<mark>Rust</mark> Book" {
		t.Fatalf("highlight %v", hits)
	}
}
