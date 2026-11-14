// Package urlnorm normalizes bookmark URLs for duplicate detection and lookup.
package urlnorm

import (
	"net/url"
	"sort"
	"strings"
)

var trackingParams = map[string]bool{
	"fbclid": true, "gclid": true, "dclid": true, "msclkid": true, "yclid": true,
	"mc_eid": true, "mc_cid": true, "spm": true, "igshid": true, "_hsenc": true, "_hsmi": true,
}

func isTracking(key string) bool {
	k := strings.ToLower(key)
	return strings.HasPrefix(k, "utm_") || trackingParams[k]
}

// Normalize lowercases scheme and host, drops default ports, fragments and
// tracking parameters, sorts the query and strips a single trailing slash
// (except for the root path). Non-hierarchical URLs are returned trimmed.
func Normalize(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" {
		return s
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Opaque != "" || u.Host == "" {
		u.Fragment = ""
		u.RawFragment = ""
		return u.String()
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	u.Host = host
	u.Fragment = ""
	u.RawFragment = ""
	if u.RawQuery != "" {
		parts := strings.Split(u.RawQuery, "&")
		kept := parts[:0]
		for _, p := range parts {
			if p == "" {
				continue
			}
			key := p
			if i := strings.IndexByte(p, '='); i >= 0 {
				key = p[:i]
			}
			if k, err := url.QueryUnescape(key); err == nil {
				key = k
			}
			if isTracking(key) {
				continue
			}
			kept = append(kept, p)
		}
		sort.Strings(kept)
		u.RawQuery = strings.Join(kept, "&")
		u.ForceQuery = false
	}
	if u.Path == "" {
		u.Path = "/"
		u.RawPath = ""
	} else if len(u.Path) > 1 && strings.HasSuffix(u.Path, "/") {
		u.Path = strings.TrimSuffix(u.Path, "/")
		u.RawPath = strings.TrimSuffix(u.RawPath, "/")
	}
	return u.String()
}

// Host returns the lowercased host name without port, or "" if the URL has none.
func Host(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// IsHTTP reports whether raw is an absolute http(s) URL with a host.
func IsHTTP(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}
