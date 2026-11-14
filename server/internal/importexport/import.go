// Package importexport reads and writes Netscape HTML, XBEL and shelfmark JSON.
package importexport

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"strconv"
	"strings"
	"time"

	nethtml "golang.org/x/net/html"

	"shelfmark/internal/core"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/urlnorm"
	"shelfmark/internal/xbel"
)

const (
	FormatHTML = "html"
	FormatXBEL = "xbel"
	FormatJSON = "json"

	ModeFolder  = "folder"
	ModeMerge   = "merge"
	ModeReplace = "replace"
)

var ErrUnknownFormat = errors.New("无法识别的书签文件格式（支持浏览器导出的 HTML、XBEL、shelfmark JSON）")

// Node is an imported folder or bookmark.
type Node struct {
	Type       string
	Title      string
	URL        string
	Notes      string
	Tags       []string
	Created    time.Time
	VisitCount int
	Children   []*Node
}

// Detect guesses the format from the content.
func Detect(data []byte) (string, error) {
	t := bytes.TrimSpace(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")))
	if len(t) == 0 {
		return "", ErrUnknownFormat
	}
	if t[0] == '{' || t[0] == '[' {
		return FormatJSON, nil
	}
	head := bytes.ToLower(t[:min(len(t), 4096)])
	if bytes.Contains(head, []byte("netscape-bookmark-file")) || bytes.Contains(head, []byte("<dl")) {
		return FormatHTML, nil
	}
	if bytes.Contains(bytes.ToLower(t), []byte("<xbel")) {
		return FormatXBEL, nil
	}
	return "", ErrUnknownFormat
}

// Parse detects the format and parses the file.
func Parse(data []byte) (string, []*Node, error) {
	format, err := Detect(data)
	if err != nil {
		return "", nil, err
	}
	var nodes []*Node
	switch format {
	case FormatHTML:
		nodes, err = ParseHTML(data)
	case FormatXBEL:
		nodes, err = ParseXBEL(data)
	case FormatJSON:
		nodes, err = ParseJSON(data)
	}
	if err != nil {
		return format, nil, err
	}
	return format, nodes, nil
}

// ---- Netscape HTML ----

func unixAttr(s string) time.Time {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	if n > 1e14 { // microseconds (some exporters)
		return time.UnixMicro(n).UTC()
	}
	if n > 1e11 { // milliseconds
		return time.UnixMilli(n).UTC()
	}
	return time.Unix(n, 0).UTC()
}

func splitTags(s string) []string {
	var out []string
	for _, t := range strings.Split(s, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, strings.Join(strings.Fields(t), "-"))
		}
	}
	return tree.NormalizeTags(out)
}

// ParseHTML parses the Netscape bookmark format exported by browsers.
func ParseHTML(data []byte) ([]*Node, error) {
	z := nethtml.NewTokenizer(bytes.NewReader(data))
	root := &Node{Type: tree.Folder}
	stack := []*Node{root}
	var pendingFolder *Node // H3 seen, waiting for its DL
	var textTarget *string  // title being read
	var last *Node          // last item, for DD notes
	inDD := false
	for {
		tt := z.Next()
		if tt == nethtml.ErrorToken {
			if z.Err() == io.EOF {
				break
			}
			return nil, z.Err()
		}
		switch tt {
		case nethtml.StartTagToken, nethtml.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			attrs := map[string]string{}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				attrs[strings.ToLower(string(k))] = string(v)
			}
			tag := string(name)
			if tag != "p" && tag != "br" {
				inDD = false
			}
			parent := stack[len(stack)-1]
			switch tag {
			case "h3":
				f := &Node{Type: tree.Folder, Created: unixAttr(attrs["add_date"])}
				parent.Children = append(parent.Children, f)
				pendingFolder, last = f, f
				textTarget = &f.Title
			case "a":
				b := &Node{Type: tree.Bookmark, URL: strings.TrimSpace(attrs["href"]), Created: unixAttr(attrs["add_date"]), Tags: splitTags(attrs["tags"])}
				parent.Children = append(parent.Children, b)
				last = b
				textTarget = &b.Title
			case "dl":
				if pendingFolder != nil {
					stack = append(stack, pendingFolder)
					pendingFolder = nil
				} else if len(stack) > 1 || len(root.Children) > 0 {
					// a stray DL: treat as continuation of the current folder
				}
			case "dd":
				inDD = last != nil
			}
		case nethtml.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "h3", "a":
				textTarget = nil
			case "dl":
				pendingFolder = nil
				inDD = false
				if len(stack) > 1 {
					stack = stack[:len(stack)-1]
				}
			}
		case nethtml.TextToken:
			text := string(z.Text())
			if textTarget != nil {
				*textTarget += text
			} else if inDD && last != nil {
				last.Notes += text
			}
		}
	}
	var clean func(nodes []*Node)
	clean = func(nodes []*Node) {
		for _, n := range nodes {
			n.Title = strings.TrimSpace(html.UnescapeString(n.Title))
			n.Notes = strings.TrimSpace(n.Notes)
			clean(n.Children)
		}
	}
	clean(root.Children)
	return root.Children, nil
}

// ---- XBEL ----

func ParseXBEL(data []byte) ([]*Node, error) {
	doc, err := xbel.ParseLenient(data)
	if err != nil {
		return nil, err
	}
	var conv func(items []*xbel.Item) []*Node
	conv = func(items []*xbel.Item) []*Node {
		out := []*Node{}
		for _, it := range items {
			n := &Node{Type: it.Type, Title: it.Title, URL: it.URL}
			if it.Type == xbel.TypeFolder {
				n.Children = conv(it.Children)
			}
			out = append(out, n)
		}
		return out
	}
	return conv(doc.Items), nil
}

// ---- shelfmark JSON ----

// JSONItem is one entry of the shelfmark JSON export.
type JSONItem struct {
	Type       string      `json:"type"`
	ID         int64       `json:"id,omitempty"`
	Title      string      `json:"title"`
	URL        string      `json:"url,omitempty"`
	Notes      string      `json:"notes,omitempty"`
	Tags       []string    `json:"tags,omitempty"`
	VisitCount int         `json:"visitCount,omitempty"`
	CreatedAt  string      `json:"createdAt,omitempty"`
	Children   []*JSONItem `json:"children,omitempty"`
}

// JSONFile is the shelfmark JSON export.
type JSONFile struct {
	Format     string      `json:"format"`
	Version    int         `json:"version"`
	Library    string      `json:"library"`
	Name       string      `json:"name"`
	Revision   int64       `json:"revision"`
	HighestID  int64       `json:"highestId"`
	ExportedAt string      `json:"exportedAt"`
	Items      []*JSONItem `json:"items"`
}

func ParseJSON(data []byte) ([]*Node, error) {
	var f JSONFile
	if err := json.Unmarshal(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), &f); err != nil {
		var items []*JSONItem
		if err2 := json.Unmarshal(data, &items); err2 != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnknownFormat, err)
		}
		f.Items = items
	}
	var conv func(items []*JSONItem) []*Node
	conv = func(items []*JSONItem) []*Node {
		out := []*Node{}
		for _, it := range items {
			if it == nil || (it.Type != tree.Folder && it.Type != tree.Bookmark) {
				continue
			}
			n := &Node{Type: it.Type, Title: it.Title, URL: it.URL, Notes: it.Notes, Tags: tree.NormalizeTags(it.Tags), VisitCount: it.VisitCount}
			if it.CreatedAt != "" {
				n.Created = store.ParseTS(it.CreatedAt)
			}
			if it.Type == tree.Folder {
				n.Children = conv(it.Children)
			}
			out = append(out, n)
		}
		return out
	}
	return conv(f.Items), nil
}

// ---- applying an import ----

// Result counts what an import did.
type Result struct {
	AddedBookmarks    int
	AddedFolders      int
	SkippedDuplicates int
	Visits            map[int64]int
}

// Apply inserts nodes into the tree being written.
func Apply(w *core.WriteCtx, nodes []*Node, mode, folderName string) (*Result, error) {
	t := w.Tree
	res := &Result{Visits: map[int64]int{}}
	add := func(n *Node, parent int64) (int64, error) {
		id := t.NextID()
		it := &tree.Item{ID: id, Type: n.Type, Title: core.SanitizeText(n.Title), Notes: strings.TrimSpace(n.Notes), Tags: validTags(n.Tags), CreatedAt: n.Created}
		if n.Type == tree.Bookmark {
			it.URL = core.SanitizeText(n.URL)
			res.AddedBookmarks++
			if n.VisitCount > 0 {
				res.Visits[id] = n.VisitCount
			}
		} else {
			res.AddedFolders++
		}
		return id, t.Insert(it, parent, -1)
	}
	var addAll func(nodes []*Node, parent int64) error
	addAll = func(nodes []*Node, parent int64) error {
		for _, n := range nodes {
			id, err := add(n, parent)
			if err != nil {
				return err
			}
			if n.Type == tree.Folder {
				if err := addAll(n.Children, id); err != nil {
					return err
				}
			}
		}
		return nil
	}
	var merge func(nodes []*Node, parent int64) error
	merge = func(nodes []*Node, parent int64) error {
		existing := map[string]bool{}
		for _, id := range t.Children(parent) {
			if it := t.Get(id); it.Type == tree.Bookmark {
				existing[urlnorm.Normalize(it.URL)] = true
			}
		}
		for _, n := range nodes {
			if n.Type == tree.Folder {
				target := t.FindChildFolder(parent, core.SanitizeText(n.Title))
				var id int64
				if target != nil {
					id = target.ID
				} else {
					var err error
					if id, err = add(&Node{Type: tree.Folder, Title: n.Title, Notes: n.Notes, Created: n.Created}, parent); err != nil {
						return err
					}
				}
				if err := merge(n.Children, id); err != nil {
					return err
				}
				continue
			}
			key := urlnorm.Normalize(n.URL)
			if existing[key] {
				res.SkippedDuplicates++
				continue
			}
			existing[key] = true
			if _, err := add(n, parent); err != nil {
				return err
			}
		}
		return nil
	}
	switch mode {
	case "", ModeFolder:
		name := strings.TrimSpace(folderName)
		if name == "" {
			name = "导入 " + w.Now.Format("2006-01-02")
		}
		id := t.NextID()
		if err := t.Insert(&tree.Item{ID: id, Type: tree.Folder, Title: core.SanitizeText(name)}, 0, -1); err != nil {
			return nil, err
		}
		res.AddedFolders++
		return res, addAll(nodes, id)
	case ModeMerge:
		return res, merge(nodes, 0)
	case ModeReplace:
		t.Clear()
		return res, addAll(nodes, 0)
	}
	return nil, core.Invalid("mode", "mode 只能是 folder、merge、replace")
}

func validTags(tags []string) []string {
	out := []string{}
	for _, t := range tree.NormalizeTags(tags) {
		if len([]rune(t)) <= 64 && !strings.ContainsAny(t, " \t\n,") {
			out = append(out, t)
		}
	}
	return out
}
