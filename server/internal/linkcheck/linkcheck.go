// Package linkcheck checks bookmark URLs.
package linkcheck

import (
	"context"
	"net/http"
	"sync"
	"time"

	"shelfmark/internal/meta"
	"shelfmark/internal/urlnorm"
)

const (
	StatusOK          = "ok"
	StatusRedirect    = "redirect"
	StatusBroken      = "broken"
	StatusUnreachable = "unreachable"
	StatusSkipped     = "skipped"
)

// Result of one check.
type Result struct {
	Status   string
	HTTP     int
	FinalURL string
	Error    string
}

type Checker struct {
	Client      *meta.Client
	Concurrency int
	PerHost     time.Duration

	mu   sync.Mutex
	next map[string]time.Time
}

func New(client *meta.Client) *Checker {
	return &Checker{Client: client, Concurrency: 4, PerHost: time.Second, next: map[string]time.Time{}}
}

// wait enforces at most one request per host per PerHost.
func (c *Checker) wait(ctx context.Context, host string) error {
	c.mu.Lock()
	now := time.Now()
	at := c.next[host]
	if at.Before(now) {
		at = now
	}
	c.next[host] = at.Add(c.PerHost)
	c.mu.Unlock()
	if d := time.Until(at); d > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
	return nil
}

// Check probes one URL: HEAD, falling back to GET on failure or 405.
func (c *Checker) Check(ctx context.Context, raw string) Result {
	if !urlnorm.IsHTTP(raw) {
		return Result{Status: StatusSkipped}
	}
	host := urlnorm.Host(raw)
	if err := c.wait(ctx, host); err != nil {
		return Result{Status: StatusUnreachable, Error: err.Error()}
	}
	resp, err := c.Client.Do(ctx, http.MethodHead, raw, false)
	if err != nil || resp.Status >= 400 {
		if err := c.wait(ctx, host); err != nil {
			return Result{Status: StatusUnreachable, Error: err.Error()}
		}
		resp, err = c.Client.Do(ctx, http.MethodGet, raw, false)
	}
	if err != nil {
		return Result{Status: StatusUnreachable, Error: trim(err.Error())}
	}
	r := Result{HTTP: resp.Status, FinalURL: resp.FinalURL}
	switch {
	case resp.Status >= 400:
		r.Status = StatusBroken
	case urlnorm.Normalize(resp.FinalURL) != urlnorm.Normalize(raw):
		r.Status = StatusRedirect
	default:
		r.Status = StatusOK
	}
	return r
}

func trim(s string) string {
	if len(s) > 300 {
		return s[:300]
	}
	return s
}

// Job is a URL to check with an opaque key.
type Job[K any] struct {
	Key K
	URL string
}

// Run checks all jobs with bounded concurrency and calls done for each.
func Run[K any](ctx context.Context, c *Checker, jobs []Job[K], done func(K, Result)) {
	n := c.Concurrency
	if n <= 0 {
		n = 4
	}
	ch := make(chan Job[K])
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range ch {
				done(j.Key, c.Check(ctx, j.URL))
			}
		}()
	}
	for _, j := range jobs {
		select {
		case ch <- j:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(ch)
	wg.Wait()
}
