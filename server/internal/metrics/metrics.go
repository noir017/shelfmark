// Package metrics is a minimal Prometheus text-format registry.
package metrics

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
)

type series struct {
	labels []string
	value  float64
	// histogram
	buckets []float64
	counts  []uint64
	sum     float64
	count   uint64
}

type family struct {
	name, help, kind string
	labelNames       []string
	buckets          []float64
	mu               sync.Mutex
	series           map[string]*series
}

func (f *family) get(labels []string) *series {
	key := strings.Join(labels, "\xff")
	s := f.series[key]
	if s == nil {
		s = &series{labels: append([]string(nil), labels...)}
		if f.kind == "histogram" {
			s.buckets = f.buckets
			s.counts = make([]uint64, len(f.buckets))
		}
		f.series[key] = s
	}
	return s
}

// Registry holds metric families and scrape-time collectors.
type Registry struct {
	mu         sync.Mutex
	families   []*family
	collectors []func(w io.Writer)
}

func New() *Registry { return &Registry{} }

func (r *Registry) add(f *family) *family {
	f.series = map[string]*series{}
	r.mu.Lock()
	r.families = append(r.families, f)
	r.mu.Unlock()
	return f
}

type Counter struct{ f *family }

func (r *Registry) Counter(name, help string, labels ...string) *Counter {
	return &Counter{r.add(&family{name: name, help: help, kind: "counter", labelNames: labels})}
}

func (c *Counter) Inc(labels ...string) { c.Add(1, labels...) }

func (c *Counter) Add(v float64, labels ...string) {
	if c == nil {
		return
	}
	c.f.mu.Lock()
	c.f.get(labels).value += v
	c.f.mu.Unlock()
}

type Gauge struct{ f *family }

func (r *Registry) Gauge(name, help string, labels ...string) *Gauge {
	return &Gauge{r.add(&family{name: name, help: help, kind: "gauge", labelNames: labels})}
}

func (g *Gauge) Set(v float64, labels ...string) {
	if g == nil {
		return
	}
	g.f.mu.Lock()
	g.f.get(labels).value = v
	g.f.mu.Unlock()
}

type Histogram struct{ f *family }

var DefBuckets = []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}

func (r *Registry) Histogram(name, help string, buckets []float64, labels ...string) *Histogram {
	return &Histogram{r.add(&family{name: name, help: help, kind: "histogram", labelNames: labels, buckets: buckets})}
}

func (h *Histogram) Observe(v float64, labels ...string) {
	if h == nil {
		return
	}
	h.f.mu.Lock()
	s := h.f.get(labels)
	for i, b := range s.buckets {
		if v <= b {
			s.counts[i]++
		}
	}
	s.sum += v
	s.count++
	h.f.mu.Unlock()
}

// Collect registers a function that writes extra metrics at scrape time.
func (r *Registry) Collect(fn func(w io.Writer)) {
	r.mu.Lock()
	r.collectors = append(r.collectors, fn)
	r.mu.Unlock()
}

func labelStr(names, values []string, extra ...string) string {
	var parts []string
	for i, n := range names {
		v := ""
		if i < len(values) {
			v = values[i]
		}
		parts = append(parts, fmt.Sprintf("%s=%q", n, v))
	}
	for i := 0; i+1 < len(extra); i += 2 {
		parts = append(parts, fmt.Sprintf("%s=%q", extra[i], extra[i+1]))
	}
	if len(parts) == 0 {
		return ""
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func fmtFloat(v float64) string {
	if math.IsInf(v, 1) {
		return "+Inf"
	}
	return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%f", v), "0"), ".")
}

// WriteText writes all metrics in Prometheus text format.
func (r *Registry) WriteText(w io.Writer) {
	r.mu.Lock()
	fams := append([]*family(nil), r.families...)
	cols := append([]func(io.Writer){}, r.collectors...)
	r.mu.Unlock()
	for _, f := range fams {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", f.name, f.help, f.name, f.kind)
		f.mu.Lock()
		keys := make([]string, 0, len(f.series))
		for k := range f.series {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			s := f.series[k]
			if f.kind != "histogram" {
				fmt.Fprintf(w, "%s%s %s\n", f.name, labelStr(f.labelNames, s.labels), fmtFloat(s.value))
				continue
			}
			for i, b := range s.buckets {
				fmt.Fprintf(w, "%s_bucket%s %d\n", f.name, labelStr(f.labelNames, s.labels, "le", fmtFloat(b)), s.counts[i])
			}
			fmt.Fprintf(w, "%s_bucket%s %d\n", f.name, labelStr(f.labelNames, s.labels, "le", "+Inf"), s.count)
			fmt.Fprintf(w, "%s_sum%s %s\n", f.name, labelStr(f.labelNames, s.labels), fmtFloat(s.sum))
			fmt.Fprintf(w, "%s_count%s %d\n", f.name, labelStr(f.labelNames, s.labels), s.count)
		}
		f.mu.Unlock()
	}
	for _, c := range cols {
		c(w)
	}
}

// Set is the application's metrics.
type Set struct {
	Registry     *Registry
	DAVRequests  *Counter
	Uploads      *Counter
	Guarded      *Counter
	HTTPDuration *Histogram
	JobRuns      *Counter
	JobDuration  *Histogram
}

func NewSet() *Set {
	r := New()
	return &Set{
		Registry:     r,
		DAVRequests:  r.Counter("shelfmark_dav_requests_total", "WebDAV requests by method and status", "method", "status"),
		Uploads:      r.Counter("shelfmark_uploads_total", "Applied WebDAV uploads by result", "result"),
		Guarded:      r.Counter("shelfmark_guarded_uploads_total", "Uploads intercepted by the deletion guard"),
		HTTPDuration: r.Histogram("shelfmark_http_request_duration_seconds", "HTTP request latency", DefBuckets, "area", "method"),
		JobRuns:      r.Counter("shelfmark_job_runs_total", "Background job runs by result", "job", "result"),
		JobDuration:  r.Histogram("shelfmark_job_duration_seconds", "Background job duration", []float64{.1, 1, 10, 60, 300, 1800, 7200}, "job"),
	}
}
