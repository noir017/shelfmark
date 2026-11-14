// Package jobs runs background work: metadata fetching, link checks,
// revision retention, cleanup and backups.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"shelfmark/internal/config"
	"shelfmark/internal/core"
	"shelfmark/internal/linkcheck"
	"shelfmark/internal/meta"
	"shelfmark/internal/metrics"
	"shelfmark/internal/store"
	"shelfmark/internal/tree"
	"shelfmark/internal/urlnorm"
)

const (
	Linkcheck = "linkcheck"
	Metadata  = "metadata"
	Retention = "retention"
	Cleanup   = "cleanup"
	Backup    = "backup"
)

var Names = []string{Linkcheck, Metadata, Retention, Cleanup, Backup}

var (
	ErrRunning   = errors.New("任务正在运行")
	ErrUnknown   = errors.New("没有这个任务")
	ErrForbidden = errors.New("只有管理员能运行这个任务")
)

type job struct {
	name      string
	interval  time.Duration
	enabled   bool
	adminOnly bool
	run       func(ctx context.Context, userID int64) (string, error)

	running bool
	next    time.Time
}

// Status of a job for the API.
type Status struct {
	Name           string
	Enabled        bool
	Running        bool
	LastStartedAt  *time.Time
	LastFinishedAt *time.Time
	LastOK         *bool
	LastSummary    *string
	NextRunAt      *time.Time
}

type metaTask struct {
	userID, libID, itemID int64
	fillTitle             bool
}

type Manager struct {
	DB      *store.DB
	Core    *core.Service
	Cfg     *config.Config
	Log     *slog.Logger
	Client  *meta.Client
	Checker *linkcheck.Checker
	Metrics *metrics.Set
	Now     func() time.Time
	// StartDelay postpones the first scheduled runs after startup.
	StartDelay time.Duration

	mu    sync.Mutex
	jobs  map[string]*job
	queue chan metaTask
	wg    sync.WaitGroup
}

func New(db *store.DB, svc *core.Service, cfg *config.Config, log *slog.Logger, ms *metrics.Set) *Manager {
	client := meta.NewClient(cfg.FetchUserAgent, cfg.FetchAllowPrivate)
	m := &Manager{DB: db, Core: svc, Cfg: cfg, Log: log, Client: client, Checker: linkcheck.New(client), Metrics: ms,
		Now: func() time.Time { return time.Now().UTC() }, StartDelay: time.Minute, queue: make(chan metaTask, 10000)}
	m.jobs = map[string]*job{
		Linkcheck: {name: Linkcheck, interval: cfg.LinkcheckInterval, enabled: cfg.LinkcheckInterval > 0, run: m.runLinkcheck},
		Metadata:  {name: Metadata, interval: 6 * time.Hour, enabled: cfg.FetchMetadata, run: m.runMetadata},
		Retention: {name: Retention, interval: 24 * time.Hour, enabled: true, adminOnly: true, run: m.runRetention},
		Cleanup:   {name: Cleanup, interval: time.Hour, enabled: true, adminOnly: true, run: m.runCleanup},
		Backup:    {name: Backup, interval: 24 * time.Hour, enabled: cfg.BackupKeep > 0, adminOnly: true, run: m.runBackup},
	}
	return m
}

// Start launches the scheduler and metadata workers until ctx ends.
func (m *Manager) Start(ctx context.Context) {
	now := m.Now()
	for _, j := range m.jobs {
		j.next = now.Add(m.StartDelay)
		if last, err := store.LastJobRun(ctx, m.DB, j.name); err == nil {
			if n := last.StartedAt.Add(j.interval); n.After(j.next) {
				j.next = n
			}
		}
	}
	if m.Cfg.FetchMetadata {
		for i := 0; i < 2; i++ {
			m.wg.Add(1)
			go func() {
				defer m.wg.Done()
				for {
					select {
					case <-ctx.Done():
						return
					case t := <-m.queue:
						m.processMeta(ctx, t)
					}
				}
			}()
		}
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			m.runDue(ctx)
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
}

// Wait blocks until background goroutines stop.
func (m *Manager) Wait() { m.wg.Wait() }

func (m *Manager) runDue(ctx context.Context) {
	now := m.Now()
	m.mu.Lock()
	var due []*job
	for _, name := range Names {
		j := m.jobs[name]
		if j.enabled && !j.running && !now.Before(j.next) {
			due = append(due, j)
		}
	}
	m.mu.Unlock()
	for _, j := range due {
		m.start(ctx, j, 0)
	}
}

func (m *Manager) start(ctx context.Context, j *job, userID int64) bool {
	m.mu.Lock()
	if j.running {
		m.mu.Unlock()
		return false
	}
	j.running = true
	m.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		started := m.Now()
		id, _ := store.StartJobRun(ctx, m.DB, j.name, started)
		summary, err := j.run(ctx, userID)
		ok := err == nil
		if err != nil {
			summary = err.Error()
			m.Log.Warn("job failed", "job", j.name, "err", err)
		}
		if id > 0 {
			store.FinishJobRun(context.WithoutCancel(ctx), m.DB, id, ok, summary, m.Now())
		}
		result := "ok"
		if !ok {
			result = "error"
		}
		if m.Metrics != nil {
			m.Metrics.JobRuns.Inc(j.name, result)
			m.Metrics.JobDuration.Observe(m.Now().Sub(started).Seconds(), j.name)
		}
		m.mu.Lock()
		j.running = false
		j.next = started.Add(j.interval)
		m.mu.Unlock()
	}()
	return true
}

// Trigger runs a job now. userID scopes linkcheck/metadata to one user.
func (m *Manager) Trigger(ctx context.Context, name string, userID int64, admin bool) error {
	j := m.jobs[name]
	if j == nil {
		return ErrUnknown
	}
	if j.adminOnly && !admin {
		return ErrForbidden
	}
	if !m.start(context.WithoutCancel(ctx), j, userID) {
		return ErrRunning
	}
	return nil
}

// List reports job states.
func (m *Manager) List(ctx context.Context) []Status {
	var out []Status
	for _, name := range Names {
		m.mu.Lock()
		j := m.jobs[name]
		st := Status{Name: name, Enabled: j.enabled, Running: j.running}
		if j.enabled {
			n := j.next
			st.NextRunAt = &n
		}
		m.mu.Unlock()
		if last, err := store.LastJobRun(ctx, m.DB, name); err == nil {
			s := last.StartedAt
			st.LastStartedAt, st.LastFinishedAt, st.LastOK, st.LastSummary = &s, last.FinishedAt, last.OK, last.Summary
		}
		out = append(out, st)
	}
	return out
}

// ---- metadata ----

// EnqueueMetadata queues new bookmarks for icon (and optionally title) fetching.
func (m *Manager) EnqueueMetadata(userID, libID int64, ids []int64, fill map[int64]bool) {
	if !m.Cfg.FetchMetadata {
		return
	}
	for _, id := range ids {
		select {
		case m.queue <- metaTask{userID: userID, libID: libID, itemID: id, fillTitle: fill[id]}:
		default:
			// queue full: the periodic sweep picks these up later
		}
	}
}

func (m *Manager) runMetadata(ctx context.Context, userID int64) (string, error) {
	refs, err := store.ListBookmarks(ctx, m.DB, userID, "m.meta_fetched_at IS NULL")
	if err != nil {
		return "", err
	}
	var wg sync.WaitGroup
	ch := make(chan store.BookmarkRef)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range ch {
				m.processMeta(ctx, metaTask{userID: r.UserID, libID: r.LibraryID, itemID: r.ItemID})
			}
		}()
	}
	for _, r := range refs {
		if ctx.Err() != nil {
			break
		}
		ch <- r
	}
	close(ch)
	wg.Wait()
	return fmt.Sprintf("处理 %d 个书签", len(refs)), nil
}

func (m *Manager) processMeta(ctx context.Context, t metaTask) {
	lib, err := store.GetLibraryByID(ctx, m.DB, t.libID)
	if err != nil {
		return
	}
	var url string
	if err := m.DB.QueryRowContext(ctx, `SELECT COALESCE(url, '') FROM items WHERE library_id = ? AND id = ? AND type = 'bookmark'`, t.libID, t.itemID).Scan(&url); err != nil {
		return
	}
	now := m.Now()
	if !urlnorm.IsHTTP(url) {
		store.SetItemFavicon(ctx, m.DB, t.libID, t.itemID, "", now)
		return
	}
	host := urlnorm.Host(url)
	var page *meta.Page
	faviconID := ""
	fh, _ := store.GetFaviconHost(ctx, m.DB, host)
	switch {
	case fh != nil && fh.FaviconID != nil && fh.FetchedAt != nil && now.Sub(*fh.FetchedAt) < 30*24*time.Hour:
		faviconID = *fh.FaviconID
	case fh != nil && fh.FailedAt != nil && now.Sub(*fh.FailedAt) < 24*time.Hour:
	default:
		page, _ = m.Client.FetchPage(ctx, url)
		candidates := []string{}
		if page != nil {
			candidates = page.Icons
		} else if u := originFavicon(url); u != "" {
			candidates = append(candidates, u)
		}
		if icon, err := m.Client.FetchIcon(ctx, candidates); err == nil {
			if err := store.PutFavicon(ctx, m.DB, &store.Favicon{ID: icon.ID, Mime: icon.Mime, Data: icon.Data}, icon.Source, now); err == nil {
				faviconID = icon.ID
				store.SetFaviconHost(ctx, m.DB, host, icon.ID, false, now)
			}
		} else {
			store.SetFaviconHost(ctx, m.DB, host, "", true, now)
		}
	}
	store.SetItemFavicon(ctx, m.DB, t.libID, t.itemID, faviconID, now)
	if !t.fillTitle {
		return
	}
	if page == nil {
		page, _ = m.Client.FetchPage(ctx, url)
	}
	if page == nil || (page.Title == "" && page.Description == "") {
		return
	}
	_, err = m.Core.Write(ctx, lib, core.Actor{UserID: lib.UserID, Name: "system", Source: core.SourceSystem}, core.WriteOpts{NoMerge: true}, func(w *core.WriteCtx) error {
		it := w.Tree.Get(t.itemID)
		if it == nil || it.Type != tree.Bookmark {
			return nil
		}
		if (it.Title == "" || it.Title == it.URL) && page.Title != "" {
			it.Title = core.SanitizeText(page.Title)
		}
		if it.Notes == "" && page.Description != "" {
			it.Notes = page.Description
		}
		return nil
	})
	if err != nil {
		m.Log.Info("fill title failed", "err", err)
	}
}

func originFavicon(raw string) string {
	i := strings.Index(raw, "://")
	if i < 0 {
		return ""
	}
	rest := raw[i+3:]
	if j := strings.IndexAny(rest, "/?#"); j >= 0 {
		rest = rest[:j]
	}
	return raw[:i+3] + rest + "/favicon.ico"
}

// ---- link checks ----

type linkKey struct{ libID, itemID int64 }

func (m *Manager) checkRefs(ctx context.Context, refs []store.BookmarkRef) string {
	jobs := make([]linkcheck.Job[linkKey], 0, len(refs))
	for _, r := range refs {
		jobs = append(jobs, linkcheck.Job[linkKey]{Key: linkKey{r.LibraryID, r.ItemID}, URL: r.URL})
	}
	var mu sync.Mutex
	counts := map[string]int{}
	linkcheck.Run(ctx, m.Checker, jobs, func(k linkKey, r linkcheck.Result) {
		store.SetHealth(context.WithoutCancel(ctx), m.DB, k.libID, k.itemID, store.Health{Status: r.Status, HTTP: r.HTTP, FinalURL: r.FinalURL, CheckedAt: m.Now(), Error: r.Error})
		mu.Lock()
		counts[r.Status]++
		mu.Unlock()
	})
	return fmt.Sprintf("检测 %d 个：正常 %d，跳转 %d，失效 %d，无法访问 %d，跳过 %d", len(refs),
		counts[linkcheck.StatusOK], counts[linkcheck.StatusRedirect], counts[linkcheck.StatusBroken], counts[linkcheck.StatusUnreachable], counts[linkcheck.StatusSkipped])
}

func (m *Manager) runLinkcheck(ctx context.Context, userID int64) (string, error) {
	refs, err := store.ListBookmarks(ctx, m.DB, userID, "")
	if err != nil {
		return "", err
	}
	return m.checkRefs(ctx, refs), nil
}

// Recheck checks specific bookmarks in the background.
func (m *Manager) Recheck(ctx context.Context, userID, libID int64, ids []int64) {
	if len(ids) == 0 {
		return
	}
	args := []any{libID}
	ph := make([]string, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args = append(args, id)
	}
	refs, err := store.ListBookmarks(ctx, m.DB, userID, "i.library_id = ? AND i.id IN ("+strings.Join(ph, ",")+")", args...)
	if err != nil || len(refs) == 0 {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.checkRefs(context.WithoutCancel(ctx), refs)
	}()
}

// ---- maintenance ----

func (m *Manager) runRetention(ctx context.Context, _ int64) (string, error) {
	n, err := m.Core.Retention(ctx)
	return fmt.Sprintf("清理 %d 个修订", n), err
}

func (m *Manager) runCleanup(ctx context.Context, _ int64) (string, error) {
	now := m.Now()
	temps, err := store.DeleteOldTempFiles(ctx, m.DB, now.Add(-24*time.Hour))
	if err != nil {
		return "", err
	}
	sessions, err := store.DeleteExpiredSessions(ctx, m.DB, now)
	if err != nil {
		return "", err
	}
	if err := store.PruneJobRuns(ctx, m.DB, 50); err != nil {
		return "", err
	}
	return fmt.Sprintf("删除临时文件 %d 个、过期会话 %d 个", temps, sessions), nil
}

func (m *Manager) runBackup(ctx context.Context, _ int64) (string, error) {
	dir := filepath.Join(m.Cfg.DataDir, "backups")
	path, err := BackupTo(ctx, m.DB, dir, m.Now())
	if err != nil {
		return "", err
	}
	removed, err := PruneBackups(dir, m.Cfg.BackupKeep)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("已备份到 %s，清理旧备份 %d 份", filepath.Base(path), removed), nil
}

// BackupTo writes data/backups/shelfmark-YYYYMMDD-HHMMSS.db.
func BackupTo(ctx context.Context, db *store.DB, dir string, now time.Time) (string, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "shelfmark-"+now.Format("20060102-150405")+".db")
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("备份文件已存在: %s", path)
	}
	return path, db.Backup(ctx, path)
}

// PruneBackups keeps the newest keep backups.
func PruneBackups(dir string, keep int) (int, error) {
	files, err := filepath.Glob(filepath.Join(dir, "shelfmark-*.db"))
	if err != nil {
		return 0, err
	}
	sort.Strings(files)
	removed := 0
	for len(files) > keep {
		if err := os.Remove(files[0]); err != nil {
			return removed, err
		}
		files = files[1:]
		removed++
	}
	return removed, nil
}
