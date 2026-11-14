// Package server wires configuration, storage and HTTP handlers together.
package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"shelfmark/internal/ai"
	"shelfmark/internal/api"
	"shelfmark/internal/auth"
	"shelfmark/internal/config"
	"shelfmark/internal/core"
	"shelfmark/internal/dav"
	"shelfmark/internal/jobs"
	"shelfmark/internal/metrics"
	"shelfmark/internal/store"
	"shelfmark/internal/webui"
)

type Server struct {
	Cfg     *config.Config
	Log     *slog.Logger
	DB      *store.DB
	Core    *core.Service
	Auth    *auth.Authenticator
	Jobs    *jobs.Manager
	API     *api.API
	Metrics *metrics.Set
	Handler http.Handler
}

// NewLogger builds the slog logger from config.
func NewLogger(cfg *config.Config, w io.Writer) *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(cfg.LogLevel) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	opts := &slog.HandlerOptions{Level: level}
	if strings.ToLower(cfg.LogFormat) == "json" {
		return slog.New(slog.NewJSONHandler(w, opts))
	}
	return slog.New(slog.NewTextHandler(w, opts))
}

// OpenDB opens data/shelfmark.db, creating the data directory.
func OpenDB(cfg *config.Config) (*store.DB, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
		return nil, err
	}
	return store.Open(filepath.Join(cfg.DataDir, "shelfmark.db"))
}

// New builds a server with the embedded web UI.
func New(cfg *config.Config, log *slog.Logger) (*Server, error) {
	db, err := OpenDB(cfg)
	if err != nil {
		return nil, err
	}
	return NewWithDB(cfg, log, db, webui.FS())
}

// NewWithDB builds a server on an open database (tests use it directly).
func NewWithDB(cfg *config.Config, log *slog.Logger, db *store.DB, static fs.FS) (*Server, error) {
	s := &Server{Cfg: cfg, Log: log, DB: db, Metrics: metrics.NewSet()}
	s.Core = core.New(db, cfg, log)
	s.Auth = auth.NewAuthenticator(db, cfg)
	s.Jobs = jobs.New(db, s.Core, cfg, log, s.Metrics)
	s.Core.Hooks.NewBookmarks = s.Jobs.EnqueueMetadata
	s.Core.Hooks.Upload = func(result string) {
		s.Metrics.Uploads.Inc(result)
		if result == "guarded" {
			s.Metrics.Guarded.Inc()
		}
	}
	var aiClient *ai.Client
	if cfg.AIEnabled() {
		aiClient = ai.New(cfg.AIBaseURL, cfg.AIAPIKey, cfg.AIModel)
	}
	s.API = &api.API{Core: s.Core, Auth: s.Auth, Cfg: cfg, DB: db, Jobs: s.Jobs, Meta: s.Jobs.Client, AI: aiClient, Log: log}
	if err := s.bootstrapAdmin(context.Background()); err != nil {
		return nil, err
	}
	s.Metrics.Registry.Collect(s.collect)
	if cfg.AccessEnabled() && len(cfg.CFAccessAUD) == 0 {
		log.Warn("SHELFMARK_CF_ACCESS_TEAM_DOMAIN 已设置但没有 SHELFMARK_CF_ACCESS_AUD：经 Cloudflare 的密码类请求都会被拒绝")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, "ok %s", config.Version)
	})
	mux.HandleFunc("/metrics", s.serveMetrics)
	davHandler := &dav.Handler{Core: s.Core, Auth: s.Auth, Cfg: cfg, Metrics: s.Metrics, Log: log}
	mux.Handle("/dav/", davHandler)
	mux.Handle("/dav", davHandler)
	s.API.Register(mux)
	mux.Handle("/", webui.Handler(static))
	s.Handler = s.middleware(mux)
	return s, nil
}

func (s *Server) bootstrapAdmin(ctx context.Context) error {
	if s.Cfg.AdminUser == "" || s.Cfg.AdminPassword == "" {
		return nil
	}
	n, err := store.CountUsers(ctx, s.DB)
	if err != nil || n > 0 {
		return err
	}
	if err := auth.CheckPassword(s.Cfg.AdminPassword); err != nil {
		return fmt.Errorf("SHELFMARK_ADMIN_PASSWORD: %w", err)
	}
	hash, err := auth.HashPassword(s.Cfg.AdminPassword)
	if err != nil {
		return err
	}
	_, err = s.Core.CreateUser(ctx, s.Cfg.AdminUser, hash, true)
	if err == nil {
		s.Log.Info("created admin user", "username", s.Cfg.AdminUser)
	}
	return err
}

func (s *Server) collect(w io.Writer) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	fmt.Fprintln(w, "# HELP shelfmark_library_bookmarks Bookmarks per library\n# TYPE shelfmark_library_bookmarks gauge")
	if rows, err := store.AllBookmarkCounts(ctx, s.DB); err == nil {
		for _, r := range rows {
			fmt.Fprintf(w, "shelfmark_library_bookmarks{user=%q,library=%q} %d\n", r[0], r[1], r[2])
		}
	}
	fmt.Fprintln(w, "# HELP shelfmark_revisions Stored revisions\n# TYPE shelfmark_revisions gauge")
	if n, err := store.CountRevisions(ctx, s.DB); err == nil {
		fmt.Fprintf(w, "shelfmark_revisions %d\n", n)
	}
}

func (s *Server) serveMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.Cfg.Metrics {
		http.NotFound(w, r)
		return
	}
	if tok := s.Cfg.MetricsToken; tok != "" {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(tok)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	s.Metrics.Registry.WriteText(w)
}

type recorder struct {
	http.ResponseWriter
	status int
}

func (r *recorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = 200
	}
	return r.ResponseWriter.Write(b)
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func area(p string) string {
	switch {
	case strings.HasPrefix(p, "/api/"):
		return "api"
	case p == "/dav" || strings.HasPrefix(p, "/dav/"):
		return "dav"
	case p == "/healthz" || p == "/metrics":
		return "ops"
	}
	return "static"
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		rec := &recorder{ResponseWriter: w}
		defer func() {
			if v := recover(); v != nil {
				s.Log.Error("panic", "path", r.URL.Path, "panic", v)
				if rec.status == 0 {
					http.Error(rec, "internal error", http.StatusInternalServerError)
				}
			}
			a := area(r.URL.Path)
			s.Metrics.HTTPDuration.Observe(time.Since(start).Seconds(), a, r.Method)
			s.Log.Debug("http", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ip", auth.ClientIP(r, s.Cfg.TrustedProxies), "dur", time.Since(start))
		}()
		next.ServeHTTP(rec, r)
	})
}

// Run serves HTTP until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.Cfg.Listen)
	if err != nil {
		return err
	}
	return s.Serve(ctx, ln)
}

// Serve serves on ln until ctx is cancelled.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	jobCtx, cancelJobs := context.WithCancel(ctx)
	defer cancelJobs()
	s.Jobs.Start(jobCtx)
	srv := &http.Server{Handler: s.Handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	s.Log.Info("listening", "addr", ln.Addr().String(), "version", config.Version)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := srv.Shutdown(shutdownCtx)
	cancelJobs()
	s.Jobs.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

// Close releases the database.
func (s *Server) Close() error { return s.DB.Close() }
