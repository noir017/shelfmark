package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"shelfmark/internal/tree"
	"shelfmark/internal/urlnorm"
)

// LoadTree loads the items of a library with notes and tags.
func LoadTree(ctx context.Context, q Q, libID, highestID int64) (*tree.Tree, error) {
	rows, err := q.QueryContext(ctx, `SELECT i.id, i.parent_id, i.position, i.type, i.title, i.url, i.created_at, i.updated_at, m.notes
		FROM items i LEFT JOIN item_meta m ON m.library_id = i.library_id AND m.item_id = i.id WHERE i.library_id = ?`, libID)
	if err != nil {
		return nil, err
	}
	var items []tree.Item
	idx := map[int64]int{}
	for rows.Next() {
		var it tree.Item
		var u, notes sql.NullString
		var created, updated string
		if err := rows.Scan(&it.ID, &it.ParentID, &it.Position, &it.Type, &it.Title, &u, &created, &updated, &notes); err != nil {
			rows.Close()
			return nil, err
		}
		it.URL, it.Notes = u.String, notes.String
		it.CreatedAt, it.UpdatedAt = ParseTS(created), ParseTS(updated)
		idx[it.ID] = len(items)
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	trows, err := q.QueryContext(ctx, `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.library_id = ? ORDER BY t.name COLLATE NOCASE`, libID)
	if err != nil {
		return nil, err
	}
	defer trows.Close()
	for trows.Next() {
		var id int64
		var name string
		if err := trows.Scan(&id, &name); err != nil {
			return nil, err
		}
		if i, ok := idx[id]; ok {
			items[i].Tags = append(items[i].Tags, name)
		}
	}
	if err := trows.Err(); err != nil {
		return nil, err
	}
	return tree.Build(items, highestID), nil
}

// Meta is the non-tree metadata of an item.
type Meta struct {
	NormalizedURL   string
	FaviconID       *string
	VisitCount      int
	LastVisitedAt   *time.Time
	HealthStatus    *string
	HealthHTTP      *int
	HealthFinalURL  *string
	HealthCheckedAt *time.Time
	HealthError     *string
	MetaFetchedAt   *time.Time
}

const metaCols = `item_id, normalized_url, favicon_id, visit_count, last_visited_at, health_status, health_http_status, health_final_url, health_checked_at, health_error, meta_fetched_at`

func scanMeta(row interface{ Scan(...any) error }) (int64, *Meta, error) {
	var id int64
	var m Meta
	var nurl, fav, visited, hs, hfinal, hchecked, herr, fetched sql.NullString
	var hhttp sql.NullInt64
	if err := row.Scan(&id, &nurl, &fav, &m.VisitCount, &visited, &hs, &hhttp, &hfinal, &hchecked, &herr, &fetched); err != nil {
		return 0, nil, err
	}
	m.NormalizedURL = nurl.String
	m.FaviconID, m.LastVisitedAt = strPtr(fav), tsPtr(visited)
	m.HealthStatus, m.HealthFinalURL, m.HealthCheckedAt, m.HealthError = strPtr(hs), strPtr(hfinal), tsPtr(hchecked), strPtr(herr)
	if hhttp.Valid {
		v := int(hhttp.Int64)
		m.HealthHTTP = &v
	}
	m.MetaFetchedAt = tsPtr(fetched)
	return id, &m, nil
}

func LoadMeta(ctx context.Context, q Q, libID int64) (map[int64]*Meta, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+metaCols+` FROM item_meta WHERE library_id = ?`, libID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*Meta{}
	for rows.Next() {
		id, m, err := scanMeta(rows)
		if err != nil {
			return nil, err
		}
		out[id] = m
	}
	return out, rows.Err()
}

func GetMeta(ctx context.Context, q Q, libID, itemID int64) (*Meta, error) {
	_, m, err := scanMeta(q.QueryRowContext(ctx, `SELECT `+metaCols+` FROM item_meta WHERE library_id = ? AND item_id = ?`, libID, itemID))
	if errors.Is(err, sql.ErrNoRows) {
		return &Meta{}, nil
	}
	return m, err
}

type ftsDoc struct{ title, url, notes, tags, path string }

func ftsDocs(t *tree.Tree) map[int64]ftsDoc {
	out := map[int64]ftsDoc{}
	var path []string
	var rec func(parent int64)
	rec = func(parent int64) {
		for _, id := range t.Children(parent) {
			it := t.Get(id)
			if it.Type == tree.Folder {
				path = append(path, it.Title)
				rec(id)
				path = path[:len(path)-1]
				continue
			}
			out[id] = ftsDoc{title: it.Title, url: it.URL, notes: it.Notes, tags: strings.Join(it.Tags, " "), path: strings.Join(path, " / ")}
		}
	}
	rec(0)
	return out
}

type tagCache struct {
	userID int64
	ids    map[string]int64
}

func (c *tagCache) id(ctx context.Context, q Q, name string) (int64, error) {
	k := strings.ToLower(name)
	if id, ok := c.ids[k]; ok {
		return id, nil
	}
	if _, err := q.ExecContext(ctx, `INSERT INTO tags(user_id, name) VALUES (?, ?) ON CONFLICT(user_id, name) DO NOTHING`, c.userID, name); err != nil {
		return 0, err
	}
	var id int64
	if err := q.QueryRowContext(ctx, `SELECT id FROM tags WHERE user_id = ? AND name = ?`, c.userID, name).Scan(&id); err != nil {
		return 0, err
	}
	c.ids[k] = id
	return id, nil
}

func setTags(ctx context.Context, q Q, tc *tagCache, libID, itemID int64, tags []string) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM item_tags WHERE library_id = ? AND item_id = ?`, libID, itemID); err != nil {
		return err
	}
	for _, name := range tags {
		id, err := tc.id(ctx, q, name)
		if err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, `INSERT OR IGNORE INTO item_tags(library_id, item_id, tag_id) VALUES (?, ?, ?)`, libID, itemID, id); err != nil {
			return err
		}
	}
	return nil
}

func nullURL(it *tree.Item) any {
	if it.Type != tree.Bookmark {
		return nil
	}
	return it.URL
}

// PersistTree writes the difference between old and nw. metaMoves maps
// removed ids to added ids whose metadata (icon, visits, health) they inherit.
func PersistTree(ctx context.Context, q Q, userID, libID int64, old, nw *tree.Tree, now time.Time, metaMoves map[int64]int64) error {
	tc := &tagCache{userID: userID, ids: map[string]int64{}}
	nowS := TS(now)
	tagsTouched := false
	// removed items first (their ids may be reused by nothing, but meta may move)
	for _, it := range old.Items() {
		if nw.Get(it.ID) != nil {
			continue
		}
		if _, err := q.ExecContext(ctx, `DELETE FROM items WHERE library_id = ? AND id = ?`, libID, it.ID); err != nil {
			return err
		}
		if to, ok := metaMoves[it.ID]; ok {
			if _, err := q.ExecContext(ctx, `DELETE FROM item_meta WHERE library_id = ? AND item_id = ?`, libID, to); err != nil {
				return err
			}
			if _, err := q.ExecContext(ctx, `UPDATE item_meta SET item_id = ? WHERE library_id = ? AND item_id = ?`, to, libID, it.ID); err != nil {
				return err
			}
		} else if _, err := q.ExecContext(ctx, `DELETE FROM item_meta WHERE library_id = ? AND item_id = ?`, libID, it.ID); err != nil {
			return err
		}
		if len(it.Tags) > 0 {
			tagsTouched = true
		}
		if _, err := q.ExecContext(ctx, `DELETE FROM item_tags WHERE library_id = ? AND item_id = ?`, libID, it.ID); err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, `DELETE FROM items_fts_map WHERE library_id = ? AND item_id = ?`, libID, it.ID); err != nil {
			return err
		}
	}
	for _, it := range nw.Items() {
		o := old.Get(it.ID)
		if o == nil {
			created := it.CreatedAt
			if created.IsZero() {
				created = now
			}
			if _, err := q.ExecContext(ctx, `INSERT INTO items(library_id, id, parent_id, position, type, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				libID, it.ID, it.ParentID, it.Position, it.Type, it.Title, nullURL(it), TS(created), nowS); err != nil {
				return err
			}
			if _, err := q.ExecContext(ctx, `INSERT INTO item_meta(library_id, item_id, notes, normalized_url) VALUES (?, ?, ?, ?)
				ON CONFLICT(library_id, item_id) DO UPDATE SET notes = excluded.notes, normalized_url = excluded.normalized_url`,
				libID, it.ID, nullStr(it.Notes), nullStr(normURL(it))); err != nil {
				return err
			}
			if len(it.Tags) > 0 {
				tagsTouched = true
				if err := setTags(ctx, q, tc, libID, it.ID, it.Tags); err != nil {
					return err
				}
			}
			continue
		}
		if o.ParentID != it.ParentID || o.Position != it.Position || o.Title != it.Title || o.URL != it.URL || o.Type != it.Type {
			if _, err := q.ExecContext(ctx, `UPDATE items SET parent_id = ?, position = ?, type = ?, title = ?, url = ?, updated_at = ? WHERE library_id = ? AND id = ?`,
				it.ParentID, it.Position, it.Type, it.Title, nullURL(it), nowS, libID, it.ID); err != nil {
				return err
			}
		}
		if o.URL != it.URL || o.Notes != it.Notes {
			if _, err := q.ExecContext(ctx, `INSERT INTO item_meta(library_id, item_id, notes, normalized_url) VALUES (?, ?, ?, ?)
				ON CONFLICT(library_id, item_id) DO UPDATE SET notes = excluded.notes, normalized_url = excluded.normalized_url`,
				libID, it.ID, nullStr(it.Notes), nullStr(normURL(it))); err != nil {
				return err
			}
		}
		if !tree.TagsEqual(o.Tags, it.Tags) || !sameCase(o.Tags, it.Tags) {
			tagsTouched = true
			if err := setTags(ctx, q, tc, libID, it.ID, it.Tags); err != nil {
				return err
			}
		}
	}
	if tagsTouched {
		if _, err := q.ExecContext(ctx, `DELETE FROM tags WHERE user_id = ? AND id NOT IN (SELECT tag_id FROM item_tags)`, userID); err != nil {
			return err
		}
	}
	return updateFTS(ctx, q, libID, old, nw)
}

func sameCase(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	sa, sb := tree.SortedTags(a), tree.SortedTags(b)
	for i := range sa {
		if sa[i] != sb[i] {
			return false
		}
	}
	return true
}

func normURL(it *tree.Item) string {
	if it.Type != tree.Bookmark {
		return ""
	}
	return urlnorm.Normalize(it.URL)
}

func updateFTS(ctx context.Context, q Q, libID int64, old, nw *tree.Tree) error {
	oldDocs := ftsDocs(old)
	for id, d := range ftsDocs(nw) {
		if od, ok := oldDocs[id]; ok && od == d {
			continue
		}
		var rowid int64
		err := q.QueryRowContext(ctx, `SELECT rowid FROM items_fts_map WHERE library_id = ? AND item_id = ?`, libID, id).Scan(&rowid)
		if errors.Is(err, sql.ErrNoRows) {
			res, err := q.ExecContext(ctx, `INSERT INTO items_fts_map(library_id, item_id) VALUES (?, ?)`, libID, id)
			if err != nil {
				return err
			}
			rowid, _ = res.LastInsertId()
			if _, err := q.ExecContext(ctx, `INSERT INTO items_fts(rowid, title, url, notes, tags, path) VALUES (?, ?, ?, ?, ?, ?)`,
				rowid, d.title, d.url, d.notes, d.tags, d.path); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, `UPDATE items_fts SET title = ?, url = ?, notes = ?, tags = ?, path = ? WHERE rowid = ?`,
			d.title, d.url, d.notes, d.tags, d.path, rowid); err != nil {
			return err
		}
	}
	// items that stopped being bookmarks (should not happen) or vanished
	for id := range oldDocs {
		if it := nw.Get(id); it == nil || it.Type != tree.Bookmark {
			if _, err := q.ExecContext(ctx, `DELETE FROM items_fts_map WHERE library_id = ? AND item_id = ?`, libID, id); err != nil {
				return err
			}
		}
	}
	return nil
}

// RebuildFTS reindexes one library from scratch.
func RebuildFTS(ctx context.Context, q Q, libID int64, t *tree.Tree) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM items_fts_map WHERE library_id = ?`, libID); err != nil {
		return err
	}
	return updateFTS(ctx, q, libID, tree.New(), t)
}

// ---- metadata updates (outside revisions) ----

func RecordVisit(ctx context.Context, q Q, libID, itemID int64, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE item_meta SET visit_count = visit_count + 1, last_visited_at = ? WHERE library_id = ? AND item_id = ?`, TS(now), libID, itemID)
	return err
}

func SetVisits(ctx context.Context, q Q, libID, itemID int64, count int, last *time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE item_meta SET visit_count = ?, last_visited_at = ? WHERE library_id = ? AND item_id = ?`, count, nullTS(last), libID, itemID)
	return err
}

func SetItemFavicon(ctx context.Context, q Q, libID, itemID int64, faviconID string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE item_meta SET favicon_id = ?, meta_fetched_at = ? WHERE library_id = ? AND item_id = ?`, nullStr(faviconID), TS(now), libID, itemID)
	return err
}

type Health struct {
	Status    string
	HTTP      int
	FinalURL  string
	CheckedAt time.Time
	Error     string
}

func SetHealth(ctx context.Context, q Q, libID, itemID int64, h Health) error {
	var httpStatus any
	if h.HTTP > 0 {
		httpStatus = h.HTTP
	}
	_, err := q.ExecContext(ctx, `UPDATE item_meta SET health_status = ?, health_http_status = ?, health_final_url = ?, health_checked_at = ?, health_error = ? WHERE library_id = ? AND item_id = ?`,
		h.Status, httpStatus, nullStr(h.FinalURL), TS(h.CheckedAt), nullStr(h.Error), libID, itemID)
	return err
}

// BookmarkRef identifies a bookmark for background work.
type BookmarkRef struct {
	UserID    int64
	LibraryID int64
	ItemID    int64
	URL       string
}

// ListBookmarks returns bookmarks (optionally of one user) matching a condition on item_meta m.
func ListBookmarks(ctx context.Context, q Q, userID int64, cond string, args ...any) ([]BookmarkRef, error) {
	query := `SELECT l.user_id, i.library_id, i.id, i.url FROM items i JOIN libraries l ON l.id = i.library_id
		LEFT JOIN item_meta m ON m.library_id = i.library_id AND m.item_id = i.id WHERE i.type = 'bookmark'`
	if userID > 0 {
		query += ` AND l.user_id = ?`
		args = append([]any{userID}, args...)
	}
	if cond != "" {
		query += ` AND (` + cond + `)`
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY i.library_id, i.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BookmarkRef
	for rows.Next() {
		var r BookmarkRef
		var u sql.NullString
		if err := rows.Scan(&r.UserID, &r.LibraryID, &r.ItemID, &u); err != nil {
			return nil, err
		}
		r.URL = u.String
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---- tags ----

type TagCount struct {
	Name  string
	Count int
}

func ListTagCounts(ctx context.Context, q Q, userID int64) ([]TagCount, error) {
	rows, err := q.QueryContext(ctx, `SELECT t.name, COUNT(it.tag_id) FROM tags t JOIN item_tags it ON it.tag_id = t.id
		WHERE t.user_id = ? GROUP BY t.id ORDER BY COUNT(it.tag_id) DESC, t.name COLLATE NOCASE`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagCount{}
	for rows.Next() {
		var tc TagCount
		if err := rows.Scan(&tc.Name, &tc.Count); err != nil {
			return nil, err
		}
		out = append(out, tc)
	}
	return out, rows.Err()
}

// LibrariesWithTag lists library ids that use a tag (case-insensitive).
func LibrariesWithTag(ctx context.Context, q Q, userID int64, name string) ([]int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT it.library_id FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE t.user_id = ? AND t.name = ?`, userID, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ---- favicons ----

type Favicon struct {
	ID   string
	Mime string
	Data []byte
}

func PutFavicon(ctx context.Context, q Q, f *Favicon, source string, now time.Time) error {
	_, err := q.ExecContext(ctx, `INSERT INTO favicons(id, mime, data, source_url, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
		f.ID, f.Mime, f.Data, source, TS(now))
	return err
}

func GetFavicon(ctx context.Context, q Q, id string) (*Favicon, error) {
	var f Favicon
	err := q.QueryRowContext(ctx, `SELECT id, mime, data FROM favicons WHERE id = ?`, id).Scan(&f.ID, &f.Mime, &f.Data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &f, err
}

type FaviconHost struct {
	FaviconID *string
	FetchedAt *time.Time
	FailedAt  *time.Time
}

func GetFaviconHost(ctx context.Context, q Q, host string) (*FaviconHost, error) {
	var fid, fetched, failed sql.NullString
	err := q.QueryRowContext(ctx, `SELECT favicon_id, fetched_at, failed_at FROM favicon_hosts WHERE host = ?`, host).Scan(&fid, &fetched, &failed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &FaviconHost{FaviconID: strPtr(fid), FetchedAt: tsPtr(fetched), FailedAt: tsPtr(failed)}, nil
}

func SetFaviconHost(ctx context.Context, q Q, host, faviconID string, failed bool, now time.Time) error {
	if failed {
		_, err := q.ExecContext(ctx, `INSERT INTO favicon_hosts(host, failed_at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET failed_at = excluded.failed_at`, host, TS(now))
		return err
	}
	_, err := q.ExecContext(ctx, `INSERT INTO favicon_hosts(host, favicon_id, fetched_at, failed_at) VALUES (?, ?, ?, NULL)
		ON CONFLICT(host) DO UPDATE SET favicon_id = excluded.favicon_id, fetched_at = excluded.fetched_at, failed_at = NULL`, host, faviconID, TS(now))
	return err
}

// CopyMeta writes non-tree metadata (icon, visits, health) onto an item.
func CopyMeta(ctx context.Context, q Q, libID, itemID int64, m *Meta) error {
	var httpStatus any
	if m.HealthHTTP != nil {
		httpStatus = *m.HealthHTTP
	}
	str := func(p *string) any {
		if p == nil {
			return nil
		}
		return *p
	}
	_, err := q.ExecContext(ctx, `UPDATE item_meta SET favicon_id = ?, visit_count = ?, last_visited_at = ?, health_status = ?, health_http_status = ?,
		health_final_url = ?, health_checked_at = ?, health_error = ?, meta_fetched_at = ? WHERE library_id = ? AND item_id = ?`,
		str(m.FaviconID), m.VisitCount, nullTS(m.LastVisitedAt), str(m.HealthStatus), httpStatus, str(m.HealthFinalURL),
		nullTS(m.HealthCheckedAt), str(m.HealthError), nullTS(m.MetaFetchedAt), libID, itemID)
	return err
}
