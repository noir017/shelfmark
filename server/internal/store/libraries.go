package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type Library struct {
	ID            int64
	UserID        int64
	Slug          string
	Name          string
	HighestID     int64
	Revision      int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
	LastSyncAt    *time.Time
	LastSyncActor *string
}

const libCols = `id, user_id, slug, name, highest_id, revision, created_at, updated_at, last_sync_at, last_sync_actor`

func scanLibrary(row interface{ Scan(...any) error }) (*Library, error) {
	var l Library
	var created, updated string
	var syncAt, syncActor sql.NullString
	if err := row.Scan(&l.ID, &l.UserID, &l.Slug, &l.Name, &l.HighestID, &l.Revision, &created, &updated, &syncAt, &syncActor); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	l.CreatedAt, l.UpdatedAt = ParseTS(created), ParseTS(updated)
	l.LastSyncAt, l.LastSyncActor = tsPtr(syncAt), strPtr(syncActor)
	return &l, nil
}

func CreateLibrary(ctx context.Context, q Q, userID int64, slug, name string, now time.Time) (*Library, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO libraries(user_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		userID, slug, name, TS(now), TS(now))
	if isUnique(err) {
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return GetLibraryByID(ctx, q, id)
}

func GetLibraryByID(ctx context.Context, q Q, id int64) (*Library, error) {
	return scanLibrary(q.QueryRowContext(ctx, `SELECT `+libCols+` FROM libraries WHERE id = ?`, id))
}

func GetLibrary(ctx context.Context, q Q, userID int64, slug string) (*Library, error) {
	return scanLibrary(q.QueryRowContext(ctx, `SELECT `+libCols+` FROM libraries WHERE user_id = ? AND slug = ?`, userID, slug))
}

func ListLibraries(ctx context.Context, q Q, userID int64) ([]*Library, error) {
	return queryLibraries(ctx, q, `SELECT `+libCols+` FROM libraries WHERE user_id = ? ORDER BY id`, userID)
}

func ListAllLibraries(ctx context.Context, q Q) ([]*Library, error) {
	return queryLibraries(ctx, q, `SELECT `+libCols+` FROM libraries ORDER BY id`)
}

func queryLibraries(ctx context.Context, q Q, query string, args ...any) ([]*Library, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Library{}
	for rows.Next() {
		l, err := scanLibrary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func UpdateLibraryMeta(ctx context.Context, q Q, id int64, slug, name string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE libraries SET slug = ?, name = ?, updated_at = ? WHERE id = ?`, slug, name, TS(now), id)
	if isUnique(err) {
		return ErrConflict
	}
	return err
}

// SetLibraryState stores revision/highest id after a write.
func SetLibraryState(ctx context.Context, q Q, id, revision, highestID int64, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE libraries SET revision = ?, highest_id = ?, updated_at = ? WHERE id = ?`, revision, highestID, TS(now), id)
	return err
}

func SetLibrarySync(ctx context.Context, q Q, id int64, actor string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE libraries SET last_sync_at = ?, last_sync_actor = ? WHERE id = ?`, TS(now), actor, id)
	return err
}

func DeleteLibrary(ctx context.Context, q Q, id int64) error {
	_, err := q.ExecContext(ctx, `DELETE FROM libraries WHERE id = ?`, id)
	return err
}

// LibraryCounts returns bookmark and folder counts per library of a user.
func LibraryCounts(ctx context.Context, q Q, userID int64) (map[int64][2]int, error) {
	rows, err := q.QueryContext(ctx, `SELECT i.library_id, SUM(i.type = 'bookmark'), SUM(i.type = 'folder') FROM items i
		JOIN libraries l ON l.id = i.library_id WHERE l.user_id = ? GROUP BY i.library_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][2]int{}
	for rows.Next() {
		var id int64
		var b, f int
		if err := rows.Scan(&id, &b, &f); err != nil {
			return nil, err
		}
		out[id] = [2]int{b, f}
	}
	return out, rows.Err()
}

// AllBookmarkCounts returns (username, slug, bookmarks) for metrics.
func AllBookmarkCounts(ctx context.Context, q Q) ([][3]any, error) {
	rows, err := q.QueryContext(ctx, `SELECT u.username, l.slug, (SELECT COUNT(*) FROM items i WHERE i.library_id = l.id AND i.type = 'bookmark')
		FROM libraries l JOIN users u ON u.id = l.user_id ORDER BY l.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][3]any
	for rows.Next() {
		var u, s string
		var n int
		if err := rows.Scan(&u, &s, &n); err != nil {
			return nil, err
		}
		out = append(out, [3]any{u, s, n})
	}
	return out, rows.Err()
}

func PendingCounts(ctx context.Context, q Q, userID int64) (map[int64]int, error) {
	rows, err := q.QueryContext(ctx, `SELECT p.library_id, COUNT(*) FROM pending_uploads p JOIN libraries l ON l.id = p.library_id
		WHERE l.user_id = ? GROUP BY p.library_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var id int64
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// ---- dav files ----

type DavFile struct {
	UserID      int64
	Name        string
	Data        []byte
	Size        int64
	ContentType string
	CreatedAt   time.Time
	ModifiedAt  time.Time
	TokenID     *int64
}

func scanDavFile(row interface{ Scan(...any) error }, withData bool) (*DavFile, error) {
	var f DavFile
	var created, modified string
	var tok sql.NullInt64
	dest := []any{&f.UserID, &f.Name, &f.Size, &f.ContentType, &created, &modified, &tok}
	if withData {
		dest = append(dest, &f.Data)
	}
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	f.CreatedAt, f.ModifiedAt = ParseTS(created), ParseTS(modified)
	if tok.Valid {
		f.TokenID = &tok.Int64
	}
	return &f, nil
}

const davCols = `user_id, name, length(data), content_type, created_at, modified_at, token_id`

func GetDavFile(ctx context.Context, q Q, userID int64, name string) (*DavFile, error) {
	return scanDavFile(q.QueryRowContext(ctx, `SELECT `+davCols+`, data FROM dav_files WHERE user_id = ? AND name = ?`, userID, name), true)
}

func StatDavFile(ctx context.Context, q Q, userID int64, name string) (*DavFile, error) {
	return scanDavFile(q.QueryRowContext(ctx, `SELECT `+davCols+` FROM dav_files WHERE user_id = ? AND name = ?`, userID, name), false)
}

func ListDavFiles(ctx context.Context, q Q, userID int64) ([]*DavFile, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+davCols+` FROM dav_files WHERE user_id = ? ORDER BY name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*DavFile
	for rows.Next() {
		f, err := scanDavFile(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// PutDavFile creates or replaces a file; created reports whether it was new.
// keepCreated preserves created_at of an existing file.
func PutDavFile(ctx context.Context, q Q, f *DavFile, keepCreated bool) (created bool, err error) {
	existing, err := StatDavFile(ctx, q, f.UserID, f.Name)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return false, err
	}
	createdAt := f.ModifiedAt
	if existing != nil && keepCreated {
		createdAt = existing.CreatedAt
	}
	var tok any
	if f.TokenID != nil {
		tok = *f.TokenID
	}
	_, err = q.ExecContext(ctx, `INSERT INTO dav_files(user_id, name, data, content_type, created_at, modified_at, token_id) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, name) DO UPDATE SET data = excluded.data, content_type = excluded.content_type,
		created_at = excluded.created_at, modified_at = excluded.modified_at, token_id = excluded.token_id`,
		f.UserID, f.Name, f.Data, f.ContentType, TS(createdAt), TS(f.ModifiedAt), tok)
	return existing == nil, err
}

func DeleteDavFile(ctx context.Context, q Q, userID int64, name string) (bool, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM dav_files WHERE user_id = ? AND name = ?`, userID, name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func RenameDavFile(ctx context.Context, q Q, userID int64, from, to string, now time.Time) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM dav_files WHERE user_id = ? AND name = ?`, userID, to); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE dav_files SET name = ?, modified_at = ? WHERE user_id = ? AND name = ?`, to, TS(now), userID, from)
	return err
}

func DeleteOldTempFiles(ctx context.Context, q Q, before time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM dav_files WHERE name LIKE '%.temp' AND modified_at < ?`, TS(before))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---- revisions ----

type Revision struct {
	LibraryID      int64
	Rev            int64
	CreatedAt      time.Time
	Source         string
	Actor          string
	Added          int
	Removed        int
	Changed        int
	Moved          int
	TotalBookmarks int
	SnapshotHash   string
	Snapshot       []byte
}

const revCols = `library_id, rev, created_at, source, actor, added, removed, changed, moved, total_bookmarks, snapshot_hash`

func scanRevision(row interface{ Scan(...any) error }, withSnap bool) (*Revision, error) {
	var r Revision
	var created string
	dest := []any{&r.LibraryID, &r.Rev, &created, &r.Source, &r.Actor, &r.Added, &r.Removed, &r.Changed, &r.Moved, &r.TotalBookmarks, &r.SnapshotHash}
	if withSnap {
		dest = append(dest, &r.Snapshot)
	}
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	r.CreatedAt = ParseTS(created)
	return &r, nil
}

func InsertRevision(ctx context.Context, q Q, r *Revision) error {
	_, err := q.ExecContext(ctx, `INSERT INTO revisions(library_id, rev, created_at, source, actor, added, removed, changed, moved, total_bookmarks, snapshot, snapshot_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.LibraryID, r.Rev, TS(r.CreatedAt), r.Source, r.Actor, r.Added, r.Removed, r.Changed, r.Moved, r.TotalBookmarks, r.Snapshot, r.SnapshotHash)
	return err
}

func DeleteRevision(ctx context.Context, q Q, libID, rev int64) error {
	_, err := q.ExecContext(ctx, `DELETE FROM revisions WHERE library_id = ? AND rev = ?`, libID, rev)
	return err
}

// LatestRevision returns the newest revision (without snapshot data).
func LatestRevision(ctx context.Context, q Q, libID int64) (*Revision, error) {
	return scanRevision(q.QueryRowContext(ctx, `SELECT `+revCols+` FROM revisions WHERE library_id = ? ORDER BY rev DESC LIMIT 1`, libID), false)
}

func GetRevision(ctx context.Context, q Q, libID, rev int64, withSnap bool) (*Revision, error) {
	cols := revCols
	if withSnap {
		cols += ", snapshot"
	}
	return scanRevision(q.QueryRowContext(ctx, `SELECT `+cols+` FROM revisions WHERE library_id = ? AND rev = ?`, libID, rev), withSnap)
}

// PrevRevision returns the newest revision older than rev.
func PrevRevision(ctx context.Context, q Q, libID, rev int64, withSnap bool) (*Revision, error) {
	cols := revCols
	if withSnap {
		cols += ", snapshot"
	}
	return scanRevision(q.QueryRowContext(ctx, `SELECT `+cols+` FROM revisions WHERE library_id = ? AND rev < ? ORDER BY rev DESC LIMIT 1`, libID, rev), withSnap)
}

func ListRevisions(ctx context.Context, q Q, libID, before int64, limit int) ([]*Revision, error) {
	if before <= 0 {
		before = 1 << 62
	}
	return queryRevisions(ctx, q, `SELECT `+revCols+` FROM revisions WHERE library_id = ? AND rev < ? ORDER BY rev DESC LIMIT ?`, libID, before, limit)
}

// RevisionsWithRemovals lists revisions since a time that removed something.
func RevisionsWithRemovals(ctx context.Context, q Q, libID int64, since time.Time) ([]*Revision, error) {
	return queryRevisions(ctx, q, `SELECT `+revCols+` FROM revisions WHERE library_id = ? AND removed > 0 AND created_at >= ? ORDER BY rev DESC`, libID, TS(since))
}

// AllRevisionsMeta lists every revision of a library, oldest first (no snapshots).
func AllRevisionsMeta(ctx context.Context, q Q, libID int64) ([]*Revision, error) {
	return queryRevisions(ctx, q, `SELECT `+revCols+` FROM revisions WHERE library_id = ? ORDER BY rev`, libID)
}

func queryRevisions(ctx context.Context, q Q, query string, args ...any) ([]*Revision, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Revision{}
	for rows.Next() {
		r, err := scanRevision(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func CountRevisions(ctx context.Context, q Q) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM revisions`).Scan(&n)
	return n, err
}

// ---- pending uploads ----

type Pending struct {
	ID           int64
	LibraryID    int64
	LibrarySlug  string
	CreatedAt    time.Time
	Actor        string
	TokenID      *int64
	BaseRevision int64
	XBEL         []byte // gzip
	Added        int
	Removed      int
	Changed      int
	Moved        int
	TotalBefore  int
	Reason       string
}

const pendingCols = `p.id, p.library_id, l.slug, p.created_at, p.actor, p.token_id, p.base_revision, p.added, p.removed, p.changed, p.moved, p.total_before, p.reason`

func scanPending(row interface{ Scan(...any) error }, withData bool) (*Pending, error) {
	var p Pending
	var created string
	var tok sql.NullInt64
	dest := []any{&p.ID, &p.LibraryID, &p.LibrarySlug, &created, &p.Actor, &tok, &p.BaseRevision, &p.Added, &p.Removed, &p.Changed, &p.Moved, &p.TotalBefore, &p.Reason}
	if withData {
		dest = append(dest, &p.XBEL)
	}
	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	p.CreatedAt = ParseTS(created)
	if tok.Valid {
		p.TokenID = &tok.Int64
	}
	return &p, nil
}

// UpsertPending stores a guarded upload, replacing an older one from the same actor.
func UpsertPending(ctx context.Context, q Q, p *Pending) (int64, error) {
	if _, err := q.ExecContext(ctx, `DELETE FROM pending_uploads WHERE library_id = ? AND actor = ?`, p.LibraryID, p.Actor); err != nil {
		return 0, err
	}
	var tok any
	if p.TokenID != nil {
		tok = *p.TokenID
	}
	res, err := q.ExecContext(ctx, `INSERT INTO pending_uploads(library_id, created_at, actor, token_id, base_revision, xbel, added, removed, changed, moved, total_before, reason)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.LibraryID, TS(p.CreatedAt), p.Actor, tok, p.BaseRevision, p.XBEL, p.Added, p.Removed, p.Changed, p.Moved, p.TotalBefore, p.Reason)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func ListPending(ctx context.Context, q Q, userID int64) ([]*Pending, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+pendingCols+` FROM pending_uploads p JOIN libraries l ON l.id = p.library_id WHERE l.user_id = ? ORDER BY p.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Pending{}
	for rows.Next() {
		p, err := scanPending(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func GetPending(ctx context.Context, q Q, libID, id int64) (*Pending, error) {
	return scanPending(q.QueryRowContext(ctx, `SELECT `+pendingCols+`, p.xbel FROM pending_uploads p JOIN libraries l ON l.id = p.library_id WHERE p.library_id = ? AND p.id = ?`, libID, id), true)
}

func DeletePending(ctx context.Context, q Q, libID, id int64) (bool, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM pending_uploads WHERE library_id = ? AND id = ?`, libID, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ---- job runs ----

type JobRun struct {
	ID         int64
	Name       string
	StartedAt  time.Time
	FinishedAt *time.Time
	OK         *bool
	Summary    *string
}

func StartJobRun(ctx context.Context, q Q, name string, now time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO job_runs(name, started_at) VALUES (?, ?)`, name, TS(now))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func FinishJobRun(ctx context.Context, q Q, id int64, ok bool, summary string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE job_runs SET finished_at = ?, ok = ?, summary = ? WHERE id = ?`, TS(now), ok, summary, id)
	return err
}

func LastJobRun(ctx context.Context, q Q, name string) (*JobRun, error) {
	var r JobRun
	var started string
	var finished, summary sql.NullString
	var ok sql.NullBool
	err := q.QueryRowContext(ctx, `SELECT id, name, started_at, finished_at, ok, summary FROM job_runs WHERE name = ? ORDER BY id DESC LIMIT 1`, name).
		Scan(&r.ID, &r.Name, &started, &finished, &ok, &summary)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	r.StartedAt = ParseTS(started)
	r.FinishedAt = tsPtr(finished)
	if ok.Valid {
		r.OK = &ok.Bool
	}
	r.Summary = strPtr(summary)
	return &r, nil
}

func PruneJobRuns(ctx context.Context, q Q, keep int) error {
	_, err := q.ExecContext(ctx, `DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs j2 WHERE j2.name = job_runs.name ORDER BY id DESC LIMIT ?)`, keep)
	return err
}
