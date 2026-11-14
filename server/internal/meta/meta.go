// Package meta fetches page titles, descriptions and favicons over a
// restricted HTTP client (also used by the link checker).
package meta

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

const (
	MaxBody      = 2 << 20
	MaxRedirects = 5
	Timeout      = 15 * time.Second
)

var ErrBlockedAddress = errors.New("不允许访问内网地址")

// Client is an HTTP client limited to http(s), 5 redirects, 2 MiB bodies,
// and optionally public addresses only (checked after DNS resolution).
type Client struct {
	HTTP *http.Client
	UA   string
}

func blockedIP(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsUnspecified() || a.IsMulticast() || a.IsInterfaceLocalMulticast() ||
		netip.MustParsePrefix("100.64.0.0/10").Contains(a) || netip.MustParsePrefix("fc00::/7").Contains(a)
}

// NewClient builds the restricted client.
func NewClient(ua string, allowPrivate bool) *Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	if !allowPrivate {
		// The check runs on the resolved address right before connecting,
		// so DNS rebinding cannot slip a private address through.
		dialer.Control = func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			a, err := netip.ParseAddr(host)
			if err != nil || blockedIP(a) {
				return ErrBlockedAddress
			}
			return nil
		}
	}
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: Timeout,
		MaxIdleConns:          20,
		IdleConnTimeout:       30 * time.Second,
	}
	c := &http.Client{
		Transport: tr,
		Timeout:   Timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > MaxRedirects {
				return fmt.Errorf("跳转超过 %d 次", MaxRedirects)
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("不支持的跳转目标 %s", req.URL.Scheme)
			}
			return nil
		},
	}
	return &Client{HTTP: c, UA: ua}
}

// Response is a fetched resource.
type Response struct {
	Status   int
	FinalURL string
	Header   http.Header
	Body     []byte
}

// Do performs a request; the body (at most 2 MiB) is read when readBody is set.
func (c *Client) Do(ctx context.Context, method, rawURL string, readBody bool) (*Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("只支持 http/https 地址")
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.UA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out := &Response{Status: resp.StatusCode, FinalURL: resp.Request.URL.String(), Header: resp.Header}
	if readBody {
		out.Body, err = io.ReadAll(io.LimitReader(resp.Body, MaxBody))
		if err != nil {
			return nil, err
		}
	} else {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	}
	return out, nil
}

// Page is what a page says about itself.
type Page struct {
	FinalURL    string
	Title       string
	Description string
	Icons       []string // absolute URLs, preferred first
}

// FetchPage loads a page and extracts title, description and icon links.
func (c *Client) FetchPage(ctx context.Context, rawURL string) (*Page, error) {
	resp, err := c.Do(ctx, http.MethodGet, rawURL, true)
	if err != nil {
		return nil, err
	}
	if resp.Status >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.Status)
	}
	p := ParseHTML(resp.Body, resp.Header.Get("Content-Type"), resp.FinalURL)
	p.FinalURL = resp.FinalURL
	return p, nil
}

// ParseHTML extracts metadata from an HTML document.
func ParseHTML(body []byte, contentType, base string) *Page {
	p := &Page{}
	r, err := charset.NewReader(bytes.NewReader(body), contentType)
	if err != nil {
		r = bytes.NewReader(body)
	}
	baseURL, _ := url.Parse(base)
	z := html.NewTokenizer(r)
	var ogTitle, ogDesc string
	var icons, touch []string
	inTitle := false
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			tag := string(name)
			attrs := map[string]string{}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				attrs[strings.ToLower(string(k))] = string(v)
			}
			switch tag {
			case "title":
				inTitle = p.Title == ""
			case "meta":
				key := strings.ToLower(attrs["name"] + attrs["property"])
				content := strings.TrimSpace(attrs["content"])
				switch key {
				case "description":
					if p.Description == "" {
						p.Description = content
					}
				case "og:description":
					ogDesc = content
				case "og:title":
					ogTitle = content
				}
			case "base":
				if h := attrs["href"]; h != "" && baseURL != nil {
					if b, err := baseURL.Parse(h); err == nil {
						baseURL = b
					}
				}
			case "link":
				rel := strings.ToLower(attrs["rel"])
				href := strings.TrimSpace(attrs["href"])
				if href == "" || baseURL == nil {
					continue
				}
				abs, err := baseURL.Parse(href)
				if err != nil || (abs.Scheme != "http" && abs.Scheme != "https") {
					continue
				}
				for _, part := range strings.Fields(rel) {
					if part == "icon" {
						icons = append(icons, abs.String())
						break
					}
					if part == "apple-touch-icon" || part == "apple-touch-icon-precomposed" {
						touch = append(touch, abs.String())
						break
					}
				}
			case "body":
				// metadata lives in <head>; stop early on large pages
				if p.Title != "" {
					goto done
				}
			}
		case html.TextToken:
			if inTitle {
				p.Title += string(z.Text())
			}
		case html.EndTagToken:
			if name, _ := z.TagName(); string(name) == "title" {
				inTitle = false
			}
		}
	}
done:
	p.Title = collapse(p.Title)
	if p.Title == "" {
		p.Title = collapse(ogTitle)
	}
	if p.Description == "" {
		p.Description = ogDesc
	}
	p.Description = collapse(p.Description)
	p.Icons = append(icons, touch...)
	if baseURL != nil {
		if fav, err := baseURL.Parse("/favicon.ico"); err == nil {
			p.Icons = append(p.Icons, fav.String())
		}
	}
	return p
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

// Icon is a fetched favicon.
type Icon struct {
	ID     string
	Mime   string
	Data   []byte
	Source string
}

// FetchIcon tries candidate URLs in order and returns the first image.
func (c *Client) FetchIcon(ctx context.Context, candidates []string) (*Icon, error) {
	var lastErr error = errors.New("没有可用的图标")
	seen := map[string]bool{}
	for _, u := range candidates {
		if seen[u] {
			continue
		}
		seen[u] = true
		resp, err := c.Do(ctx, http.MethodGet, u, true)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.Status != http.StatusOK || len(resp.Body) == 0 || len(resp.Body) > 1<<20 {
			lastErr = fmt.Errorf("图标 HTTP %d", resp.Status)
			continue
		}
		mime := iconMime(resp.Body, resp.Header.Get("Content-Type"), u)
		if mime == "" {
			lastErr = errors.New("不是图片")
			continue
		}
		sum := sha256.Sum256(resp.Body)
		return &Icon{ID: hex.EncodeToString(sum[:])[:32], Mime: mime, Data: resp.Body, Source: u}, nil
	}
	return nil, lastErr
}

func iconMime(data []byte, header, u string) string {
	sniff := http.DetectContentType(data)
	if strings.HasPrefix(sniff, "image/") {
		return sniff
	}
	h := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	if h == "image/svg+xml" || (strings.HasSuffix(strings.ToLower(u), ".svg") && bytes.Contains(data[:min(len(data), 512)], []byte("<svg"))) {
		return "image/svg+xml"
	}
	if strings.HasPrefix(h, "image/") && h != "image/svg+xml" && !strings.HasPrefix(sniff, "text/") {
		return h
	}
	return ""
}
