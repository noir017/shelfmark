package auth

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// ClientIP resolves the real client address. Requests from trusted proxies
// may name it in CF-Connecting-IP (preferred) or X-Forwarded-For; for the
// latter, trusted hops are skipped from the right so that a client cannot
// inject an address by sending its own header.
func ClientIP(r *http.Request, trusted []netip.Prefix) string {
	remote := remoteAddr(r)
	if !isTrusted(remote, trusted) {
		return addrString(remote, r.RemoteAddr)
	}
	if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
		if a, err := netip.ParseAddr(cf); err == nil {
			return a.Unmap().String()
		}
	}
	var hops []netip.Addr
	for _, h := range r.Header.Values("X-Forwarded-For") {
		for _, p := range strings.Split(h, ",") {
			if a, err := netip.ParseAddr(strings.TrimSpace(p)); err == nil {
				hops = append(hops, a.Unmap())
			}
		}
	}
	for i := len(hops) - 1; i >= 0; i-- {
		if !isTrusted(hops[i], trusted) {
			return hops[i].String()
		}
	}
	if len(hops) > 0 {
		return hops[0].String()
	}
	return addrString(remote, r.RemoteAddr)
}

func remoteAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

func addrString(a netip.Addr, fallback string) string {
	if a.IsValid() {
		return a.String()
	}
	return fallback
}

func isTrusted(a netip.Addr, trusted []netip.Prefix) bool {
	if !a.IsValid() {
		return false
	}
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// FromTrustedProxy reports whether the direct peer is a trusted proxy.
func FromTrustedProxy(r *http.Request, trusted []netip.Prefix) bool {
	return isTrusted(remoteAddr(r), trusted)
}

// IsHTTPS reports whether the client used https (directly or via a trusted proxy).
func IsHTTPS(r *http.Request, trusted []netip.Prefix) bool {
	if r.TLS != nil {
		return true
	}
	return FromTrustedProxy(r, trusted) && strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
}

// Limiter counts failures per IP: Max failures within Window block for Block.
type Limiter struct {
	Max    int
	Window time.Duration
	Block  time.Duration
	Now    func() time.Time

	mu sync.Mutex
	m  map[string]*limitEntry
}

type limitEntry struct {
	fails   []time.Time
	blocked time.Time
}

func NewLimiter() *Limiter {
	return &Limiter{Max: 10, Window: 10 * time.Minute, Block: 15 * time.Minute, Now: time.Now, m: map[string]*limitEntry{}}
}

// Blocked reports whether ip is blocked and for how long.
func (l *Limiter) Blocked(ip string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.m[ip]
	if e == nil {
		return false, 0
	}
	if d := e.blocked.Sub(l.Now()); d > 0 {
		return true, d
	}
	return false, 0
}

// Fail records a failure; it returns true when the ip just got blocked.
func (l *Limiter) Fail(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	if len(l.m) > 10000 {
		for k, e := range l.m {
			if e.blocked.Before(now) && (len(e.fails) == 0 || now.Sub(e.fails[len(e.fails)-1]) > l.Window) {
				delete(l.m, k)
			}
		}
	}
	e := l.m[ip]
	if e == nil {
		e = &limitEntry{}
		l.m[ip] = e
	}
	kept := e.fails[:0]
	for _, t := range e.fails {
		if now.Sub(t) < l.Window {
			kept = append(kept, t)
		}
	}
	e.fails = append(kept, now)
	if len(e.fails) >= l.Max {
		e.blocked = now.Add(l.Block)
		e.fails = nil
		return true
	}
	return false
}
