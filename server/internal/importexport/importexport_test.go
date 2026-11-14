package importexport

import (
	"strings"
	"testing"
	"time"

	"shelfmark/internal/core"
	"shelfmark/internal/tree"
)

const chromeHTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://example.com/a" ADD_DATE="1700000002" TAGS="go,dev">A &amp; B</A>
        <DD>some notes
        <DT><H3>Empty</H3>
        <DL><p>
        </DL><p>
        <DT><A HREF="https://example.org/">Org</A>
    </DL><p>
    <DT><A HREF="https://example.net/">Net</A>
</DL><p>
`

func TestParseHTML(t *testing.T) {
	format, nodes, err := Parse([]byte(chromeHTML))
	if err != nil || format != FormatHTML {
		t.Fatal(format, err)
	}
	if len(nodes) != 2 || nodes[0].Title != "书签栏" || len(nodes[0].Children) != 3 || nodes[1].Title != "Net" {
		t.Fatalf("%+v", nodes)
	}
	a := nodes[0].Children[0]
	if a.Title != "A & B" || a.Notes != "some notes" || strings.Join(a.Tags, ",") != "go,dev" || a.Created.Unix() != 1700000002 {
		t.Fatalf("%+v", a)
	}
	if e := nodes[0].Children[1]; e.Type != tree.Folder || e.Title != "Empty" || len(e.Children) != 0 {
		t.Fatalf("%+v", e)
	}
}

func TestApplyModesAndRoundTrip(t *testing.T) {
	_, nodes, _ := Parse([]byte(chromeHTML))
	now := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	base := tree.New()
	base.Insert(&tree.Item{ID: 1, Type: tree.Folder, Title: "书签栏"}, 0, -1)
	base.Insert(&tree.Item{ID: 2, Type: tree.Bookmark, Title: "dup", URL: "https://Example.com/a#x"}, 1, -1)

	w := &core.WriteCtx{Tree: base.Clone(), Now: now}
	r, err := Apply(w, nodes, ModeFolder, "")
	if err != nil || r.AddedBookmarks != 3 || r.AddedFolders != 3 {
		t.Fatalf("%+v %v", r, err)
	}
	if f := w.Tree.FindChildFolder(0, "导入 2026-11-14"); f == nil {
		t.Fatal("import folder missing")
	}

	w = &core.WriteCtx{Tree: base.Clone(), Now: now}
	r, err = Apply(w, nodes, ModeMerge, "")
	if err != nil || r.SkippedDuplicates != 1 || r.AddedBookmarks != 2 || r.AddedFolders != 1 {
		t.Fatalf("merge %+v %v", r, err)
	}

	w = &core.WriteCtx{Tree: base.Clone(), Now: now}
	if _, err := Apply(w, nodes, ModeReplace, ""); err != nil {
		t.Fatal(err)
	}
	if w.Tree.Get(2) != nil {
		t.Fatal("replace kept old item")
	}
	for _, format := range []string{FormatHTML, FormatXBEL, FormatJSON} {
		body, _, _, err := Export(ExportInput{Slug: "bookmarks", Tree: w.Tree, Now: now}, format)
		if err != nil {
			t.Fatal(err)
		}
		got, again, err := Parse(body)
		if err != nil || got != format {
			t.Fatalf("%s: %s %v", format, got, err)
		}
		w2 := &core.WriteCtx{Tree: tree.New(), Now: now}
		Apply(w2, again, ModeReplace, "")
		b1, f1 := w.Tree.Counts()
		b2, f2 := w2.Tree.Counts()
		if b1 != b2 || f1 != f2 {
			t.Fatalf("%s round trip: %d/%d vs %d/%d", format, b1, f1, b2, f2)
		}
		if format != FormatXBEL {
			var notes string
			w2.Tree.Walk(func(it *tree.Item, _ int) bool {
				notes += it.Notes
				return true
			})
			if notes != "some notes" {
				t.Fatalf("%s notes %q", format, notes)
			}
		}
	}
	if _, _, err := Parse([]byte("hello")); err != ErrUnknownFormat {
		t.Fatal(err)
	}
}
