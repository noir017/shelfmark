package tree

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"sort"
)

// SnapItem is one entry of the canonical snapshot JSON (design 6.1).
type SnapItem struct {
	ID       int64    `json:"id"`
	ParentID int64    `json:"parentId"`
	Position int      `json:"position"`
	Type     string   `json:"type"`
	Title    string   `json:"title"`
	URL      *string  `json:"url"`
	Notes    *string  `json:"notes"`
	Tags     []string `json:"tags"`
}

// Snapshot is the canonical JSON tree stored with every revision.
type Snapshot struct {
	HighestID int64      `json:"highestId"`
	Items     []SnapItem `json:"items"`
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Snapshot captures the tree in canonical form.
func (t *Tree) Snapshot() *Snapshot {
	s := &Snapshot{HighestID: t.HighestID, Items: make([]SnapItem, 0, len(t.items))}
	for _, it := range t.Items() {
		si := SnapItem{ID: it.ID, ParentID: it.ParentID, Position: it.Position, Type: it.Type, Title: it.Title,
			Notes: strPtr(it.Notes), Tags: SortedTags(it.Tags)}
		if it.Type == Bookmark {
			u := it.URL
			si.URL = &u
		}
		s.Items = append(s.Items, si)
	}
	sort.SliceStable(s.Items, func(i, j int) bool {
		if s.Items[i].ParentID != s.Items[j].ParentID {
			return s.Items[i].ParentID < s.Items[j].ParentID
		}
		return s.Items[i].Position < s.Items[j].Position
	})
	return s
}

// Encode returns the canonical JSON and its sha256 (hex).
func (s *Snapshot) Encode() ([]byte, string) {
	raw, _ := json.Marshal(s)
	sum := sha256.Sum256(raw)
	return raw, hex.EncodeToString(sum[:])
}

// Tree rebuilds a tree from a snapshot.
func (s *Snapshot) Tree() *Tree {
	items := make([]Item, len(s.Items))
	for i, si := range s.Items {
		it := Item{ID: si.ID, ParentID: si.ParentID, Position: si.Position, Type: si.Type, Title: si.Title,
			Tags: append([]string(nil), si.Tags...)}
		if si.URL != nil {
			it.URL = *si.URL
		}
		if si.Notes != nil {
			it.Notes = *si.Notes
		}
		items[i] = it
	}
	return Build(items, s.HighestID)
}

// Gzip compresses data.
func Gzip(data []byte) []byte {
	var b bytes.Buffer
	w, _ := gzip.NewWriterLevel(&b, gzip.BestSpeed)
	w.Write(data)
	w.Close()
	return b.Bytes()
}

// DecodeSnapshot decompresses and parses a stored snapshot.
func DecodeSnapshot(blob []byte) (*Snapshot, error) {
	r, err := gzip.NewReader(bytes.NewReader(blob))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	s := &Snapshot{}
	if err := json.Unmarshal(raw, s); err != nil {
		return nil, err
	}
	return s, nil
}
