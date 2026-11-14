// Package search implements the query syntax of design section 9 on top of FTS5.
package search

import (
	"context"
	"html"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"shelfmark/internal/store"
	"shelfmark/internal/urlnorm"
)

// Query is a parsed search string.
type Query struct {
	Terms     []string // words and phrases, all must match
	Excludes  []string
	Tags      []string
	Sites     []string
	Ins       []string
	Libs      []string
	Broken    bool
	Duplicate bool
}

// tokenize splits on spaces, keeping "quoted phrases" (also after a prefix like in:"a b").
func tokenize(s string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	for _, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
			cur.WriteRune(r)
		case !inQuote && (r == ' ' || r == '\t' || r == '\n' || r == '　'):
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func unquote(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, `"`, ""))
}

// Parse parses the query syntax.
func Parse(s string) Query {
	var q Query
	for _, tok := range tokenize(s) {
		neg := false
		if strings.HasPrefix(tok, "-") && len(tok) > 1 {
			neg = true
			tok = tok[1:]
		}
		lower := strings.ToLower(tok)
		switch {
		case strings.HasPrefix(tok, "#") && len(tok) > 1 && !neg:
			q.Tags = append(q.Tags, unquote(tok[1:]))
		case strings.HasPrefix(lower, "site:") && len(tok) > 5 && !neg:
			q.Sites = append(q.Sites, strings.ToLower(strings.TrimPrefix(unquote(tok[5:]), "www.")))
		case strings.HasPrefix(lower, "in:") && len(tok) > 3 && !neg:
			q.Ins = append(q.Ins, unquote(tok[3:]))
		case strings.HasPrefix(lower, "lib:") && len(tok) > 4 && !neg:
			q.Libs = append(q.Libs, unquote(tok[4:]))
		case lower == "is:broken" && !neg:
			q.Broken = true
		case lower == "is:duplicate" && !neg:
			q.Duplicate = true
		default:
			t := unquote(tok)
			if t == "" {
				continue
			}
			if neg {
				q.Excludes = append(q.Excludes, t)
			} else {
				q.Terms = append(q.Terms, t)
			}
		}
	}
	return q
}

// Empty reports whether the query has no condition at all.
func (q Query) Empty() bool {
	return len(q.Terms) == 0 && len(q.Excludes) == 0 && len(q.Tags) == 0 && len(q.Sites) == 0 && len(q.Ins) == 0 &&
		len(q.Libs) == 0 && !q.Broken && !q.Duplicate
}

// Hit is one result.
type Hit struct {
	LibraryID  int64
	Slug       string
	ItemID     int64
	Score      float64
	Highlights map[string]string
}

func ftsQuote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

func likeArg(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}

const likeAny = `(f.title LIKE ? ESCAPE '\' OR f.url LIKE ? ESCAPE '\' OR f.notes LIKE ? ESCAPE '\' OR f.tags LIKE ? ESCAPE '\' OR f.path LIKE ? ESCAPE '\')`

type candidate struct {
	libID, itemID       int64
	slug                string
	title, url, notes   string
	tags, path          string
	bm25                float64
	visits              int
	health, normalized  string
}

// Run executes a query for a user; library restricts to one slug ("" = all).
func Run(ctx context.Context, db store.Q, userID int64, q Query, library string, limit, offset int) (int, []Hit, error) {
	var where []string
	var args []any
	args = append(args, userID)
	libs := append([]string(nil), q.Libs...)
	if library != "" {
		libs = append(libs, library)
	}
	if len(libs) > 0 {
		where = append(where, "l.slug IN ("+strings.Repeat("?,", len(libs)-1)+"?)")
		for _, l := range libs {
			args = append(args, l)
		}
	}
	var match []string
	for _, t := range q.Terms {
		if utf8.RuneCountInString(t) >= 3 {
			match = append(match, ftsQuote(t))
		} else {
			where = append(where, likeAny)
			for i := 0; i < 5; i++ {
				args = append(args, likeArg(t))
			}
		}
	}
	for _, t := range q.Excludes {
		if utf8.RuneCountInString(t) >= 3 {
			where = append(where, "f.rowid NOT IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)")
			args = append(args, ftsQuote(t))
		} else {
			where = append(where, "NOT "+likeAny)
			for i := 0; i < 5; i++ {
				args = append(args, likeArg(t))
			}
		}
	}
	rank := "0"
	if len(match) > 0 {
		where = append(where, "items_fts MATCH ?")
		args = append(args, strings.Join(match, " AND "))
		rank = "bm25(items_fts, 10.0, 3.0, 2.0, 4.0, 1.0)"
	}
	query := `SELECT m.library_id, m.item_id, l.slug, f.title, f.url, f.notes, f.tags, f.path, ` + rank + `,
			COALESCE(im.visit_count, 0), COALESCE(im.health_status, ''), COALESCE(im.normalized_url, '')
		FROM items_fts f JOIN items_fts_map m ON m.rowid = f.rowid
		JOIN libraries l ON l.id = m.library_id
		LEFT JOIN item_meta im ON im.library_id = m.library_id AND im.item_id = m.item_id
		WHERE l.user_id = ?`
	if len(where) > 0 {
		query += " AND " + strings.Join(where, " AND ")
	}
	rows, err := db.QueryContext(ctx, query+" LIMIT 20000", args...)
	if err != nil {
		return 0, nil, err
	}
	var cands []*candidate
	for rows.Next() {
		c := &candidate{}
		if err := rows.Scan(&c.libID, &c.itemID, &c.slug, &c.title, &c.url, &c.notes, &c.tags, &c.path, &c.bm25, &c.visits, &c.health, &c.normalized); err != nil {
			rows.Close()
			return 0, nil, err
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	var dupCount map[string]int
	if q.Duplicate {
		dupCount, err = duplicateCounts(ctx, db, userID, libs)
		if err != nil {
			return 0, nil, err
		}
	}
	termRe := highlighter(q.Terms)
	var hits []Hit
	for _, c := range cands {
		if !c.matches(q, dupCount) {
			continue
		}
		score := -c.bm25 + 2*math.Log1p(float64(c.visits))
		if termRe != nil {
			n := len(termRe.FindAllStringIndex(c.title, -1))
			if n > 0 {
				score += 5
			}
			allInTitle := true
			lt := strings.ToLower(c.title)
			for _, t := range q.Terms {
				if !strings.Contains(lt, strings.ToLower(t)) {
					allInTitle = false
				}
			}
			if allInTitle {
				score += 3
			}
		}
		hits = append(hits, Hit{LibraryID: c.libID, Slug: c.slug, ItemID: c.itemID, Score: score, Highlights: highlights(termRe, c)})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if hits[i].LibraryID != hits[j].LibraryID {
			return hits[i].LibraryID < hits[j].LibraryID
		}
		return hits[i].ItemID < hits[j].ItemID
	})
	total := len(hits)
	if offset >= len(hits) {
		return total, []Hit{}, nil
	}
	hits = hits[offset:]
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return total, hits, nil
}

func (c *candidate) matches(q Query, dup map[string]int) bool {
	if len(q.Sites) > 0 {
		host := strings.TrimPrefix(urlnorm.Host(c.url), "www.")
		ok := false
		for _, s := range q.Sites {
			if host == s || strings.HasSuffix(host, "."+s) {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	if len(q.Tags) > 0 {
		have := map[string]bool{}
		for _, t := range strings.Fields(c.tags) {
			have[strings.ToLower(t)] = true
		}
		for _, t := range q.Tags {
			if !have[strings.ToLower(t)] {
				return false
			}
		}
	}
	for _, in := range q.Ins {
		ok := false
		for _, seg := range strings.Split(c.path, " / ") {
			if strings.Contains(strings.ToLower(seg), strings.ToLower(in)) {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	if q.Broken && c.health != "broken" && c.health != "unreachable" {
		return false
	}
	if q.Duplicate && (c.normalized == "" || dup[c.normalized] < 2) {
		return false
	}
	return true
}

func duplicateCounts(ctx context.Context, db store.Q, userID int64, libs []string) (map[string]int, error) {
	query := `SELECT im.normalized_url, COUNT(*) FROM item_meta im JOIN items i ON i.library_id = im.library_id AND i.id = im.item_id
		JOIN libraries l ON l.id = im.library_id WHERE l.user_id = ? AND i.type = 'bookmark' AND im.normalized_url IS NOT NULL`
	args := []any{userID}
	if len(libs) > 0 {
		query += " AND l.slug IN (" + strings.Repeat("?,", len(libs)-1) + "?)"
		for _, l := range libs {
			args = append(args, l)
		}
	}
	rows, err := db.QueryContext(ctx, query+" GROUP BY im.normalized_url HAVING COUNT(*) > 1", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var u string
		var n int
		if err := rows.Scan(&u, &n); err != nil {
			return nil, err
		}
		out[u] = n
	}
	return out, rows.Err()
}

func highlighter(terms []string) *regexp.Regexp {
	if len(terms) == 0 {
		return nil
	}
	parts := make([]string, 0, len(terms))
	sorted := append([]string(nil), terms...)
	sort.Slice(sorted, func(i, j int) bool { return len(sorted[i]) > len(sorted[j]) })
	for _, t := range sorted {
		parts = append(parts, regexp.QuoteMeta(t))
	}
	return regexp.MustCompile("(?i)" + strings.Join(parts, "|"))
}

// Mark HTML-escapes s and wraps matches in <mark>.
func Mark(re *regexp.Regexp, s string) string {
	if re == nil {
		return html.EscapeString(s)
	}
	var b strings.Builder
	last := 0
	for _, m := range re.FindAllStringIndex(s, -1) {
		b.WriteString(html.EscapeString(s[last:m[0]]))
		b.WriteString("<mark>" + html.EscapeString(s[m[0]:m[1]]) + "</mark>")
		last = m[1]
	}
	b.WriteString(html.EscapeString(s[last:]))
	return b.String()
}

func snippet(re *regexp.Regexp, s string, width int) string {
	loc := re.FindStringIndex(s)
	if loc == nil {
		return ""
	}
	start, end := loc[0], loc[1]
	runesBefore := []rune(s[:start])
	from := 0
	prefix := ""
	if len(runesBefore) > width {
		from = len(string(runesBefore[:len(runesBefore)-width]))
		prefix = "…"
	}
	after := []rune(s[end:])
	to := len(s)
	suffix := ""
	if len(after) > width {
		to = end + len(string(after[:width]))
		suffix = "…"
	}
	return prefix + Mark(re, s[from:to]) + suffix
}

func highlights(re *regexp.Regexp, c *candidate) map[string]string {
	h := map[string]string{"title": Mark(re, c.title)}
	if re == nil {
		return h
	}
	if re.MatchString(c.url) {
		h["url"] = Mark(re, c.url)
	}
	if s := snippet(re, c.notes, 40); s != "" {
		h["notes"] = s
	}
	return h
}
