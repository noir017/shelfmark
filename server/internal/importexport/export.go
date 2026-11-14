package importexport

import (
	"encoding/json"
	"fmt"
	"html"
	"strings"
	"time"

	"shelfmark/internal/core"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/xbel"
)

// ExportInput is what an export needs.
type ExportInput struct {
	Slug     string
	Name     string
	Revision int64
	Tree     *tree.Tree
	Meta     map[int64]*store.Meta // may be nil (snapshots)
	Now      time.Time
}

// Export renders the tree; it returns body, content type and file extension.
func Export(in ExportInput, format string) ([]byte, string, string, error) {
	switch format {
	case "", FormatHTML:
		return ExportHTML(in), "text/html; charset=utf-8", "html", nil
	case FormatXBEL:
		return xbel.Write(core.TreeToXBEL(in.Tree), in.Tree.HighestID), "application/xml; charset=utf-8", "xbel", nil
	case FormatJSON:
		b, err := ExportJSON(in)
		return b, "application/json; charset=utf-8", "json", err
	}
	return nil, "", "", core.Invalid("format", "format 只能是 html、xbel、json")
}

func unix(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return fmt.Sprintf(` ADD_DATE="%d"`, t.Unix())
}

// ExportHTML writes the Netscape bookmark format.
func ExportHTML(in ExportInput) []byte {
	var b strings.Builder
	b.WriteString("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n")
	b.WriteString(`<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">` + "\n")
	b.WriteString("<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n")
	var rec func(parent int64, depth int)
	rec = func(parent int64, depth int) {
		ind := strings.Repeat("    ", depth)
		for _, id := range in.Tree.Children(parent) {
			it := in.Tree.Get(id)
			if it.Type == tree.Folder {
				fmt.Fprintf(&b, "%s<DT><H3%s>%s</H3>\n", ind, unix(it.CreatedAt), html.EscapeString(it.Title))
				fmt.Fprintf(&b, "%s<DL><p>\n", ind)
				rec(id, depth+1)
				fmt.Fprintf(&b, "%s</DL><p>\n", ind)
				continue
			}
			tags := ""
			if len(it.Tags) > 0 {
				tags = fmt.Sprintf(` TAGS="%s"`, html.EscapeString(strings.Join(it.Tags, ",")))
			}
			fmt.Fprintf(&b, "%s<DT><A HREF=\"%s\"%s%s>%s</A>\n", ind, html.EscapeString(it.URL), unix(it.CreatedAt), tags, html.EscapeString(it.Title))
			if it.Notes != "" {
				fmt.Fprintf(&b, "%s<DD>%s\n", ind, html.EscapeString(it.Notes))
			}
		}
	}
	rec(0, 1)
	b.WriteString("</DL><p>\n")
	return []byte(b.String())
}

// ExportJSON writes the shelfmark JSON format (notes, tags, visits).
func ExportJSON(in ExportInput) ([]byte, error) {
	var conv func(parent int64) []*JSONItem
	conv = func(parent int64) []*JSONItem {
		out := []*JSONItem{}
		for _, id := range in.Tree.Children(parent) {
			it := in.Tree.Get(id)
			j := &JSONItem{Type: it.Type, ID: it.ID, Title: it.Title, Notes: it.Notes, Tags: it.Tags}
			if !it.CreatedAt.IsZero() {
				j.CreatedAt = store.TS(it.CreatedAt)
			}
			if it.Type == tree.Bookmark {
				j.URL = it.URL
				if m := in.Meta[id]; m != nil {
					j.VisitCount = m.VisitCount
				}
			} else {
				j.Children = conv(id)
			}
			out = append(out, j)
		}
		return out
	}
	f := JSONFile{Format: "shelfmark", Version: 1, Library: in.Slug, Name: in.Name, Revision: in.Revision, HighestID: in.Tree.HighestID,
		ExportedAt: store.TS(in.Now), Items: conv(0)}
	return json.MarshalIndent(f, "", "  ")
}
