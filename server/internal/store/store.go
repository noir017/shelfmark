// Package store is the SQLite data layer.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

var ErrNotFound = errors.New("not found")

// Q is satisfied by *sql.DB, *sql.Tx and *DB.
type Q interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// DB wraps the write pool (BEGIN IMMEDIATE) and a read pool whose
// transactions are deferred, for consistent multi-query reads.
type DB struct {
	*sql.DB
	R    *sql.DB
	Path string
}

// Open opens (and migrates) the database at path.
func Open(path string) (*DB, error) {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")
	dsn := "file:" + path + "?" + q.Encode()
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(4)
	sqlDB.SetMaxIdleConns(2)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	db := &DB{DB: sqlDB, Path: path}
	if err := db.migrate(context.Background()); err != nil {
		sqlDB.Close()
		return nil, err
	}
	q.Del("_txlock")
	rdb, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		sqlDB.Close()
		return nil, err
	}
	rdb.SetMaxOpenConns(8)
	rdb.SetMaxIdleConns(4)
	rdb.SetConnMaxIdleTime(5 * time.Minute)
	db.R = rdb
	return db, nil
}

// Close closes both pools.
func (db *DB) Close() error {
	db.R.Close()
	return db.DB.Close()
}

// ReadTx runs fn in a deferred (read) transaction on the read pool.
func (db *DB) ReadTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := db.R.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	return fn(tx)
}

func (db *DB) migrate(ctx context.Context) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		return err
	}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, e := range entries {
		num, _, _ := strings.Cut(e.Name(), "_")
		version, err := strconv.Atoi(num)
		if err != nil {
			return fmt.Errorf("bad migration name %s", e.Name())
		}
		var n int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", e.Name(), err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`, version, TS(time.Now())); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Tx runs fn in a write transaction (BEGIN IMMEDIATE).
func (db *DB) Tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Backup writes a consistent copy of the database to dst.
func (db *DB) Backup(ctx context.Context, dst string) error {
	_, err := db.ExecContext(ctx, `VACUUM INTO ?`, dst)
	return err
}

const tsLayout = "2006-01-02T15:04:05.000Z"

// TS formats a time as UTC RFC3339 with milliseconds.
func TS(t time.Time) string { return t.UTC().Format(tsLayout) }

// ParseTS parses a stored timestamp (zero time on error).
func ParseTS(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

func nullTS(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return TS(*t)
}

func tsPtr(ns sql.NullString) *time.Time {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	t := ParseTS(ns.String)
	return &t
}

func strPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	s := ns.String
	return &s
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}
