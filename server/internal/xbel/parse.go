// Package xbel parses and generates XBEL files the way Floccus does.
//
// Parsing mirrors floccus src/lib/serializers/Xbel.ts (fast-xml-parser with
// trimmed values, title taken from the first child element only) and
// DerivedIds.ts (ids for id-less items derived from their content).
// Generation is byte-compatible with createXBEL + XbelSerializer.serialize.
package xbel

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Header is the literal XML declaration Floccus requires in every file.
const Header = `<?xml version="1.0" encoding="UTF-8"?>`

const (
	MaxDepth = 64
	MaxItems = 200000
)

var (
	ErrEncrypted = errors.New("文件已加密：请在 Floccus 里关闭加密（shelfmark 需要读取书签内容）")
	ErrHTML      = errors.New("只支持 XBEL 格式：请在 Floccus 里把书签文件格式改为 XBEL")
	ErrNotXBEL   = errors.New("不是 XBEL 文件：缺少 XML 头或根元素不是 xbel")
)

// ParseError is a malformed file (HTTP 400).
type ParseError struct{ Msg string }

func (e *ParseError) Error() string { return "XBEL 解析失败：" + e.Msg }

const (
	TypeFolder   = "folder"
	TypeBookmark = "bookmark"
)

// Item is a parsed bookmark or folder.
type Item struct {
	Type     string
	ID       int64
	Title    string
	URL      string
	HasURL   bool
	Children []*Item
	Derived  bool
}

// Doc is a parsed file.
type Doc struct {
	HighestID    int64
	HasHighestID bool
	Items        []*Item
	Explicit     int
	DerivedCount int
	Count        int
}

// PersistIDs mirrors mustPersistDerivedIds.
func (d *Doc) PersistIDs() bool { return d.DerivedCount > 0 && d.Explicit > 0 }

// MaxID returns the largest id in the file (0 if none is positive).
func (d *Doc) MaxID() int64 {
	var m int64
	var walk func([]*Item)
	walk = func(items []*Item) {
		for _, it := range items {
			if it.ID > m {
				m = it.ID
			}
			walk(it.Children)
		}
	}
	walk(d.Items)
	return m
}

// Detect classifies an upload body before parsing.
func Detect(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var probe map[string]json.RawMessage
		if json.Unmarshal(trimmed, &probe) == nil {
			if _, ok := probe["ciphertext"]; ok {
				return ErrEncrypted
			}
		}
	}
	if bytes.Contains(data, []byte("<!DOCTYPE NETSCAPE-Bookmark-file-1>")) {
		return ErrHTML
	}
	if !bytes.Contains(data, []byte(Header)) {
		return ErrNotXBEL
	}
	return nil
}

// Parse parses an XBEL upload. It returns ErrEncrypted/ErrHTML/ErrNotXBEL for
// unsupported content and *ParseError for malformed files or duplicate ids.
func Parse(data []byte) (*Doc, error) {
	if err := Detect(data); err != nil {
		return nil, err
	}
	doc := &Doc{}
	doc.HighestID, doc.HasHighestID = parseHighestID(data)

	clean := sanitize(data)
	dec := xml.NewDecoder(bytes.NewReader(clean))
	dec.Strict = false

	type frame struct {
		name      string
		item      *Item // nil for non-item elements
		container bool  // xbel or folder: children become items
		firstSeen bool  // a child element has been seen
		inTitle   bool
		title     *strings.Builder
		skip      bool // inside an ignored subtree
	}
	var stack []*frame
	itemDepth := func(stack []*frame) int {
		n := 0
		for _, f := range stack {
			if f.item != nil {
				n++
			}
		}
		return n
	}
	rootSeen := false
	var root frame
	for {
		tok, err := dec.RawToken()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, &ParseError{Msg: err.Error()}
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := rawName(t.Name)
			if len(stack) == 0 {
				if rootSeen {
					return nil, &ParseError{Msg: "多个根元素"}
				}
				rootSeen = true
				if name != "xbel" {
					return nil, ErrNotXBEL
				}
				root = frame{name: name, container: true}
				stack = append(stack, &root)
				continue
			}
			if len(stack) > MaxDepth*2 {
				return nil, &ParseError{Msg: fmt.Sprintf("嵌套超过 %d 层", MaxDepth)}
			}
			parent := stack[len(stack)-1]
			f := &frame{name: name}
			first := !parent.firstSeen
			parent.firstSeen = true
			switch {
			case parent.skip:
				f.skip = true
			case parent.item != nil && first && name == "title":
				f.inTitle = true
				f.title = &strings.Builder{}
			case parent.container && (name == "bookmark" || name == "folder"):
				it := &Item{Type: name}
				var idRaw string
				hasID := false
				for _, a := range t.Attr {
					if a.Name.Space != "" {
						continue
					}
					switch a.Name.Local {
					case "id":
						idRaw, hasID = jsTrim(a.Value), true
					case "href":
						if name == "bookmark" {
							it.URL, it.HasURL = jsTrim(a.Value), true
						}
					}
				}
				it.ID, it.Derived = 0, true
				if hasID {
					v, ok := jsParseInt(idRaw)
					if ok {
						if math.Abs(v) > 1<<53 {
							return nil, &ParseError{Msg: "id 超出范围：" + idRaw}
						}
						it.ID, it.Derived = int64(v), false
					}
				}
				doc.Count++
				if doc.Count > MaxItems {
					return nil, &ParseError{Msg: fmt.Sprintf("条目超过 %d 个", MaxItems)}
				}
				if parent.item != nil {
					parent.item.Children = append(parent.item.Children, it)
				} else {
					doc.Items = append(doc.Items, it)
				}
				f.item = it
				f.container = name == "folder"
				if itemDepth(stack) >= MaxDepth {
					return nil, &ParseError{Msg: fmt.Sprintf("嵌套超过 %d 层", MaxDepth)}
				}
			default:
				f.skip = true
			}
			stack = append(stack, f)
		case xml.EndElement:
			if len(stack) == 0 {
				return nil, &ParseError{Msg: "多余的结束标签 " + rawName(t.Name)}
			}
			f := stack[len(stack)-1]
			if f.name != rawName(t.Name) {
				return nil, &ParseError{Msg: fmt.Sprintf("标签不匹配：<%s> 与 </%s>", f.name, rawName(t.Name))}
			}
			stack = stack[:len(stack)-1]
			if f.inTitle && len(stack) > 0 {
				owner := stack[len(stack)-1]
				if owner.item != nil {
					owner.item.Title = jsTrim(f.title.String())
				}
			}
		case xml.CharData:
			if len(stack) > 0 {
				f := stack[len(stack)-1]
				if f.inTitle && !f.firstSeen {
					f.title.Write(t)
				} else if f.item != nil && jsTrim(string(t)) != "" {
					// fast-xml-parser keeps non-blank text as a child node,
					// so a title after it is no longer the first child
					f.firstSeen = true
				}
			}
		}
	}
	if !rootSeen {
		return nil, ErrNotXBEL
	}
	if len(stack) != 0 {
		return nil, &ParseError{Msg: "文件不完整：缺少结束标签"}
	}
	if err := assignDerivedIDs(doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func rawName(n xml.Name) string {
	if n.Space != "" {
		return n.Space + ":" + n.Local
	}
	return n.Local
}

// assignDerivedIDs follows DerivedIds.ts: explicit ids are collected first,
// then id-less items get -cyrb53(key + "\0" + occurrence), walking pre-order.
func assignDerivedIDs(doc *Doc) error {
	used := map[int64]bool{0: true}
	var collect func([]*Item) error
	collect = func(items []*Item) error {
		for _, it := range items {
			if !it.Derived {
				if it.ID == 0 {
					return &ParseError{Msg: "id 不能为 0（0 是根）"}
				}
				if used[it.ID] {
					return &ParseError{Msg: fmt.Sprintf("id %d 重复", it.ID)}
				}
				used[it.ID] = true
				doc.Explicit++
			}
			if err := collect(it.Children); err != nil {
				return err
			}
		}
		return nil
	}
	if err := collect(doc.Items); err != nil {
		return err
	}
	occurrences := map[string]int{}
	var assign func(parentID int64, items []*Item)
	assign = func(parentID int64, items []*Item) {
		for _, it := range items {
			if it.Derived {
				var key string
				if it.Type == TypeBookmark {
					u := "undefined"
					if it.HasURL {
						u = it.URL
					}
					key = "bookmark\x00" + u
				} else {
					key = "folder\x00" + strconv.FormatInt(parentID, 10) + "\x00" + it.Title
				}
				occ := occurrences[key]
				occurrences[key] = occ + 1
				id := -int64(Hash(key + "\x00" + strconv.Itoa(occ)))
				for used[id] {
					if id == -(1<<53 - 1) {
						id = -1
					} else {
						id--
					}
				}
				used[id] = true
				it.ID = id
				doc.DerivedCount++
			}
			if it.Type == TypeFolder {
				assign(it.ID, it.Children)
			}
		}
	}
	assign(0, doc.Items)
	return nil
}

// Hash is cyrb53 over UTF-16 code units, as in DerivedIds.ts. Never returns 0.
func Hash(s string) uint64 {
	h1 := uint32(0xdeadbeef)
	h2 := uint32(0x41c6ce57)
	for _, r := range s {
		var units []uint16
		if r >= 0x10000 {
			a, b := utf16.EncodeRune(r)
			units = []uint16{uint16(a), uint16(b)}
		} else {
			units = []uint16{uint16(r)}
		}
		for _, ch := range units {
			h1 = (h1 ^ uint32(ch)) * 2654435761
			h2 = (h2 ^ uint32(ch)) * 1597334677
		}
	}
	h1 = (h1 ^ (h1 >> 16)) * 2246822507
	h1 ^= (h2 ^ (h2 >> 13)) * 3266489909
	h2 = (h2 ^ (h2 >> 16)) * 2246822507
	h2 ^= (h1 ^ (h1 >> 13)) * 3266489909
	result := 4294967296*uint64(2097151&h2) + uint64(h1)
	if result == 0 {
		return 1
	}
	return result
}

// parseHighestID mirrors WebDav.ts: the first line containing the marker,
// parseInt of the text between the first and the last ':'.
func parseHighestID(data []byte) (int64, bool) {
	marker := []byte("<!--- highestId :")
	for _, line := range bytes.Split(data, []byte("\n")) {
		if !bytes.Contains(line, marker) {
			continue
		}
		s := string(line)
		start := strings.IndexByte(s, ':') + 1
		end := strings.LastIndexByte(s, ':')
		if end < start {
			return 0, false
		}
		v, ok := jsParseInt(s[start:end])
		if !ok || math.Abs(v) > 1<<53 {
			return 0, false
		}
		return int64(v), true
	}
	return 0, false
}

// jsParseInt implements JavaScript parseInt(s) without a radix.
func jsParseInt(s string) (float64, bool) {
	s = jsTrim(s)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	base := 10.0
	if len(s) >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X') {
		base = 16
		s = s[2:]
	}
	var v float64
	n := 0
	for _, c := range s {
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case base == 16 && c >= 'a' && c <= 'f':
			d = int(c-'a') + 10
		case base == 16 && c >= 'A' && c <= 'F':
			d = int(c-'A') + 10
		default:
			d = -1
		}
		if d < 0 {
			break
		}
		v = v*base + float64(d)
		n++
	}
	if n == 0 {
		return 0, false
	}
	if neg {
		v = -v
	}
	return v, true
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

func isXMLChar(r rune) bool {
	return r == 0x09 || r == 0x0A || r == 0x0D ||
		(r >= 0x20 && r <= 0xD7FF) || (r >= 0xE000 && r <= 0xFFFD) || (r >= 0x10000 && r <= 0x10FFFF)
}

// Clean removes characters that cannot appear in XML (and invalid UTF-8).
func Clean(s string) string {
	if utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool { return !isXMLChar(r) }) < 0 {
		return s
	}
	var b strings.Builder
	for _, r := range strings.ToValidUTF8(s, "") {
		if isXMLChar(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func sanitize(data []byte) []byte {
	s := string(data)
	c := Clean(s)
	if len(c) == len(s) {
		return data
	}
	return []byte(c)
}
