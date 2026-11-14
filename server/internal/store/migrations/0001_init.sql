CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'session'
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  last_used_ip TEXT,
  revoked_at TEXT
);
CREATE INDEX tokens_user ON tokens(user_id);

CREATE TABLE libraries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  highest_id INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_actor TEXT,
  UNIQUE(user_id, slug)
);

CREATE TABLE items (
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  id INTEGER NOT NULL,
  parent_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('folder', 'bookmark')),
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (library_id, id)
);
CREATE INDEX items_parent ON items(library_id, parent_id, position);

CREATE TABLE item_meta (
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  notes TEXT,
  normalized_url TEXT,
  favicon_id TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  last_visited_at TEXT,
  health_status TEXT,
  health_http_status INTEGER,
  health_final_url TEXT,
  health_checked_at TEXT,
  health_error TEXT,
  meta_fetched_at TEXT,
  PRIMARY KEY (library_id, item_id)
);
CREATE INDEX item_meta_url ON item_meta(library_id, normalized_url);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE(user_id, name)
);

CREATE TABLE item_tags (
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (library_id, item_id, tag_id)
);
CREATE INDEX item_tags_tag ON item_tags(tag_id);

CREATE TABLE favicons (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  source_url TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE favicon_hosts (
  host TEXT PRIMARY KEY,
  favicon_id TEXT,
  fetched_at TEXT,
  failed_at TEXT
);

CREATE TABLE revisions (
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  moved INTEGER NOT NULL DEFAULT 0,
  total_bookmarks INTEGER NOT NULL DEFAULT 0,
  snapshot BLOB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  PRIMARY KEY (library_id, rev)
);

CREATE TABLE pending_uploads (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  token_id INTEGER,
  base_revision INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL DEFAULT 0,
  xbel BLOB NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  moved INTEGER NOT NULL DEFAULT 0,
  total_before INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX pending_library ON pending_uploads(library_id);

CREATE TABLE dav_files (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data BLOB NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  token_id INTEGER,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  summary TEXT
);
CREATE INDEX job_runs_name ON job_runs(name, started_at);

CREATE VIRTUAL TABLE items_fts USING fts5(title, url, notes, tags, path, tokenize = 'trigram');

CREATE TABLE items_fts_map (
  rowid INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL,
  UNIQUE (library_id, item_id)
);

CREATE TRIGGER items_fts_map_ad AFTER DELETE ON items_fts_map BEGIN
  DELETE FROM items_fts WHERE rowid = old.rowid;
END;
