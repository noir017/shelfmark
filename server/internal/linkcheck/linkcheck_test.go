package linkcheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"shelfmark/internal/meta"
)

func TestCheck(t *testing.T) {
	var mu sync.Mutex
	heads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			w.WriteHeader(200)
		case "/nohead":
			if r.Method == http.MethodHead {
				mu.Lock()
				heads++
				mu.Unlock()
				w.WriteHeader(405)
				return
			}
			w.WriteHeader(200)
		case "/moved":
			http.Redirect(w, r, "/ok", http.StatusMovedPermanently)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(meta.NewClient("test", true))
	c.PerHost = 0
	ctx := context.Background()
	cases := map[string]string{
		srv.URL + "/ok":       StatusOK,
		srv.URL + "/nohead":   StatusOK,
		srv.URL + "/moved":    StatusRedirect,
		srv.URL + "/gone":     StatusBroken,
		srv.URL + "/loop":     StatusUnreachable,
		"javascript:void(0)":  StatusSkipped,
		"http://127.0.0.1:1/": StatusUnreachable,
	}
	for u, want := range cases {
		if got := c.Check(ctx, u); got.Status != want {
			t.Errorf("%s: %+v, want %s", u, got, want)
		}
	}
	if heads != 1 {
		t.Fatalf("HEAD tried %d times", heads)
	}
	if r := c.Check(ctx, srv.URL+"/moved"); r.FinalURL != srv.URL+"/ok" || r.HTTP != 200 {
		t.Fatalf("redirect result %+v", r)
	}
}

func TestPrivateBlocked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	c := New(meta.NewClient("test", false))
	c.PerHost = 0
	if r := c.Check(context.Background(), srv.URL); r.Status != StatusUnreachable {
		t.Fatalf("loopback should be blocked: %+v", r)
	}
}

func TestPerHostRate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	c := New(meta.NewClient("test", true))
	c.PerHost = 100 * time.Millisecond
	jobs := []Job[int]{{1, srv.URL + "/a"}, {2, srv.URL + "/b"}, {3, srv.URL + "/c"}}
	start := time.Now()
	n := 0
	var mu sync.Mutex
	Run(context.Background(), c, jobs, func(int, Result) { mu.Lock(); n++; mu.Unlock() })
	if n != 3 || time.Since(start) < 200*time.Millisecond {
		t.Fatalf("n=%d elapsed=%v", n, time.Since(start))
	}
}
