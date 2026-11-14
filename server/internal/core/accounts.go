package core

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"

	"shelfmark/internal/store"
)

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

func ValidUsername(s string) bool { return usernameRe.MatchString(s) }

// CreateUser creates a user with the default library "bookmarks".
func (s *Service) CreateUser(ctx context.Context, username string, admin bool) (*store.User, error) {
	if !ValidUsername(username) {
		return nil, Invalid("username", "用户名只能包含字母、数字和 . _ -，最长 64 位")
	}
	var u *store.User
	err := s.DB.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		u, err = store.CreateUser(ctx, tx, username, admin, s.Now())
		if err != nil {
			return err
		}
		_, err = store.CreateLibrary(ctx, tx, u.ID, DefaultSlug, DefaultSlug, s.Now())
		return err
	})
	if errors.Is(err, store.ErrConflict) {
		return nil, &ConflictError{Msg: "用户名已存在"}
	}
	return u, err
}

// CreateLibrary validates and creates a library.
func (s *Service) CreateLibrary(ctx context.Context, userID int64, slug, name string) (*store.Library, error) {
	if !ValidSlug(slug) {
		return nil, Invalid("slug", "slug 只能包含字母、数字和 . _ -，最长 64 位")
	}
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 100 {
		return nil, Invalid("name", "名称不能为空，最长 100 字")
	}
	lib, err := store.CreateLibrary(ctx, s.DB, userID, slug, name, s.Now())
	if errors.Is(err, store.ErrConflict) {
		return nil, &ConflictError{Msg: "已有同名库 " + slug}
	}
	return lib, err
}

// UpdateLibrary renames a library and/or changes its slug.
func (s *Service) UpdateLibrary(ctx context.Context, lib *store.Library, name, slug *string) (*store.Library, error) {
	newName, newSlug := lib.Name, lib.Slug
	if name != nil {
		newName = strings.TrimSpace(*name)
		if newName == "" || len([]rune(newName)) > 100 {
			return nil, Invalid("name", "名称不能为空，最长 100 字")
		}
	}
	if slug != nil {
		if !ValidSlug(*slug) {
			return nil, Invalid("slug", "slug 只能包含字母、数字和 . _ -，最长 64 位")
		}
		newSlug = *slug
	}
	unlock := s.LockLibrary(lib.UserID, lib.Slug)
	defer unlock()
	if newSlug != lib.Slug {
		unlock2 := s.LockLibrary(lib.UserID, newSlug)
		defer unlock2()
	}
	err := s.DB.Tx(ctx, func(tx *sql.Tx) error {
		if err := store.UpdateLibraryMeta(ctx, tx, lib.ID, newSlug, newName, s.Now()); err != nil {
			return err
		}
		if newSlug != lib.Slug {
			for _, suffix := range []string{".xbel.lock", ".xbel.temp"} {
				if _, err := store.DeleteDavFile(ctx, tx, lib.UserID, lib.Slug+suffix); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if errors.Is(err, store.ErrConflict) {
		return nil, &ConflictError{Msg: "已有同名库 " + newSlug}
	}
	if err != nil {
		return nil, err
	}
	return store.GetLibraryByID(ctx, s.DB, lib.ID)
}

// DeleteLibrary removes a library with all items and revisions.
func (s *Service) DeleteLibrary(ctx context.Context, lib *store.Library) error {
	unlock := s.LockLibrary(lib.UserID, lib.Slug)
	defer unlock()
	err := s.DB.Tx(ctx, func(tx *sql.Tx) error {
		if err := store.DeleteLibrary(ctx, tx, lib.ID); err != nil {
			return err
		}
		for _, suffix := range []string{".xbel.lock", ".xbel.temp"} {
			if _, err := store.DeleteDavFile(ctx, tx, lib.UserID, lib.Slug+suffix); err != nil {
				return err
			}
		}
		return nil
	})
	s.mu.Lock()
	delete(s.xbel, lib.ID)
	s.mu.Unlock()
	return err
}

// ReleaseLock removes the Floccus lock file of a library.
func (s *Service) ReleaseLock(ctx context.Context, lib *store.Library) error {
	unlock := s.LockLibrary(lib.UserID, lib.Slug)
	defer unlock()
	_, err := store.DeleteDavFile(ctx, s.DB, lib.UserID, LockFileName(lib.Slug))
	return err
}
