package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

type User struct {
	ID           int64
	Username     string
	PasswordHash string
	IsAdmin      bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const userCols = `id, username, password_hash, is_admin, created_at, updated_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	var created, updated string
	if err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.IsAdmin, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	u.CreatedAt, u.UpdatedAt = ParseTS(created), ParseTS(updated)
	return &u, nil
}

func CountUsers(ctx context.Context, q Q) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func CountAdmins(ctx context.Context, q Q) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_admin = 1`).Scan(&n)
	return n, err
}

// ErrConflict is returned on unique constraint violations.
var ErrConflict = errors.New("conflict")

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func CreateUser(ctx context.Context, q Q, username, hash string, admin bool, now time.Time) (*User, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO users(username, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		username, hash, admin, TS(now), TS(now))
	if isUnique(err) {
		return nil, ErrConflict
	}
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return GetUser(ctx, q, id)
}

func GetUser(ctx context.Context, q Q, id int64) (*User, error) {
	return scanUser(q.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

func GetUserByName(ctx context.Context, q Q, name string) (*User, error) {
	return scanUser(q.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE username = ?`, name))
}

func ListUsers(ctx context.Context, q Q) ([]*User, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+userCols+` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func SetUserPassword(ctx context.Context, q Q, id int64, hash string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, hash, TS(now), id)
	return err
}

func SetUserAdmin(ctx context.Context, q Q, id int64, admin bool, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?`, admin, TS(now), id)
	return err
}

func DeleteUser(ctx context.Context, q Q, id int64) error {
	_, err := q.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	return err
}

// ---- sessions ----

type Session struct {
	ID         string
	UserID     int64
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastSeenAt time.Time
	UserAgent  string
	IP         string
	Method     string
}

func CreateSession(ctx context.Context, q Q, s *Session) error {
	_, err := q.ExecContext(ctx, `INSERT INTO sessions(id, user_id, created_at, expires_at, last_seen_at, user_agent, ip, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.UserID, TS(s.CreatedAt), TS(s.ExpiresAt), TS(s.LastSeenAt), s.UserAgent, s.IP, s.Method)
	return err
}

func GetSession(ctx context.Context, q Q, id string) (*Session, error) {
	var s Session
	var created, expires, seen string
	err := q.QueryRowContext(ctx, `SELECT id, user_id, created_at, expires_at, last_seen_at, user_agent, ip, method FROM sessions WHERE id = ?`, id).
		Scan(&s.ID, &s.UserID, &created, &expires, &seen, &s.UserAgent, &s.IP, &s.Method)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	s.CreatedAt, s.ExpiresAt, s.LastSeenAt = ParseTS(created), ParseTS(expires), ParseTS(seen)
	return &s, nil
}

func TouchSession(ctx context.Context, q Q, id string, seen, expires time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, TS(seen), TS(expires), id)
	return err
}

func DeleteSession(ctx context.Context, q Q, id string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// DeleteUserSessions removes all sessions of a user except keep.
func DeleteUserSessions(ctx context.Context, q Q, userID int64, keep string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND id != ?`, userID, keep)
	return err
}

func DeleteExpiredSessions(ctx context.Context, q Q, now time.Time) (int64, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, TS(now))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---- tokens ----

type Token struct {
	ID         int64
	UserID     int64
	Name       string
	Scopes     []string
	Prefix     string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	LastUsedIP *string
	RevokedAt  *time.Time
}

func (t *Token) HasScope(s string) bool {
	for _, x := range t.Scopes {
		if x == s {
			return true
		}
	}
	return false
}

const tokenCols = `id, user_id, name, scopes, prefix, created_at, last_used_at, last_used_ip, revoked_at`

func scanToken(row interface{ Scan(...any) error }) (*Token, error) {
	var t Token
	var scopes, created string
	var used, ip, revoked sql.NullString
	if err := row.Scan(&t.ID, &t.UserID, &t.Name, &scopes, &t.Prefix, &created, &used, &ip, &revoked); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.Scopes = strings.Split(scopes, ",")
	t.CreatedAt = ParseTS(created)
	t.LastUsedAt, t.LastUsedIP, t.RevokedAt = tsPtr(used), strPtr(ip), tsPtr(revoked)
	return &t, nil
}

func CreateToken(ctx context.Context, q Q, userID int64, name string, scopes []string, hash, prefix string, now time.Time) (*Token, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO tokens(user_id, name, scopes, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		userID, name, strings.Join(scopes, ","), hash, prefix, TS(now))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return scanToken(q.QueryRowContext(ctx, `SELECT `+tokenCols+` FROM tokens WHERE id = ?`, id))
}

// GetActiveTokenByHash returns a non-revoked token.
func GetActiveTokenByHash(ctx context.Context, q Q, hash string) (*Token, error) {
	return scanToken(q.QueryRowContext(ctx, `SELECT `+tokenCols+` FROM tokens WHERE token_hash = ? AND revoked_at IS NULL`, hash))
}

func GetToken(ctx context.Context, q Q, id int64) (*Token, error) {
	return scanToken(q.QueryRowContext(ctx, `SELECT `+tokenCols+` FROM tokens WHERE id = ?`, id))
}

func ListTokens(ctx context.Context, q Q, userID int64) ([]*Token, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+tokenCols+` FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Token{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func RevokeToken(ctx context.Context, q Q, userID, id int64, now time.Time) (bool, error) {
	res, err := q.ExecContext(ctx, `UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, TS(now), id, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func TouchToken(ctx context.Context, q Q, id int64, ip string, now time.Time) error {
	_, err := q.ExecContext(ctx, `UPDATE tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?`, TS(now), ip, id)
	return err
}

// ---- settings ----

func GetSettingsJSON(ctx context.Context, q Q, userID int64) (string, error) {
	var s string
	err := q.QueryRowContext(ctx, `SELECT json FROM user_settings WHERE user_id = ?`, userID).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return s, err
}

func PutSettingsJSON(ctx context.Context, q Q, userID int64, js string) error {
	_, err := q.ExecContext(ctx, `INSERT INTO user_settings(user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json`, userID, js)
	return err
}
