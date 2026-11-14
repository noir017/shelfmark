// Package config loads settings from SHELFMARK_* environment variables and an
// optional YAML file (keys are the variable names without prefix, lowercased).
package config

import (
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Listen         string
	DataDir        string
	BaseURL        string
	TrustedProxies []netip.Prefix
	AllowedOrigins []string

	CFAccessTeamDomain string
	CFAccessAUD        []string
	CFAccessUsers      map[string]string // username -> email (lowercase)

	// DefaultUser is the identity of requests that carry no credentials and
	// did not come through Cloudflare. Empty means the first user created.
	DefaultUser string

	DAVAutoCreate bool
	GuardRatio    float64
	GuardMinItems int

	RevisionKeepDays      int
	RevisionKeepDailyDays int
	BackupKeep            int
	LinkcheckInterval     time.Duration

	FetchMetadata     bool
	FetchAllowPrivate bool
	FetchUserAgent    string

	AIBaseURL string
	AIAPIKey  string
	AIModel   string

	Metrics      bool
	MetricsToken string

	LogLevel  string
	LogFormat string
}

// Version is set at build time with -ldflags "-X shelfmark/internal/config.Version=...".
var (
	Version = "0.1.0-dev"
	Commit  = "unknown"
)

var keys = []string{
	"listen", "data_dir", "base_url", "trusted_proxies", "allowed_origins",
	"cf_access_team_domain", "cf_access_aud", "cf_access_users", "default_user",
	"dav_auto_create", "guard_ratio", "guard_min_items",
	"revision_keep_days", "revision_keep_daily_days", "backup_keep", "linkcheck_interval",
	"fetch_metadata", "fetch_allow_private", "fetch_user_agent",
	"ai_base_url", "ai_api_key", "ai_model", "metrics", "metrics_token", "log_level", "log_format",
}

// Default returns the documented defaults.
func Default() *Config {
	return &Config{
		Listen:                ":8080",
		DataDir:               "./data",
		CFAccessUsers:         map[string]string{},
		DAVAutoCreate:         true,
		GuardRatio:            0.5,
		GuardMinItems:         20,
		RevisionKeepDays:      30,
		RevisionKeepDailyDays: 365,
		BackupKeep:            14,
		LinkcheckInterval:     168 * time.Hour,
		FetchMetadata:         true,
		FetchAllowPrivate:     true,
		FetchUserAgent:        "shelfmark/" + Version,
		LogLevel:              "info",
		LogFormat:             "text",
	}
}

// Load reads the optional YAML file, then environment variables (which win).
func Load(file string, getenv func(string) string) (*Config, error) {
	values := map[string]string{}
	if file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("读取配置文件: %w", err)
		}
		var m map[string]any
		if err := yaml.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("解析配置文件: %w", err)
		}
		for k, v := range m {
			k = strings.ToLower(k)
			switch vv := v.(type) {
			case []any:
				parts := make([]string, len(vv))
				for i, p := range vv {
					parts[i] = fmt.Sprint(p)
				}
				values[k] = strings.Join(parts, ",")
			case map[string]any:
				parts := []string{}
				for mk, mv := range vv {
					parts = append(parts, mk+"="+fmt.Sprint(mv))
				}
				values[k] = strings.Join(parts, ",")
			case nil:
				values[k] = ""
			default:
				values[k] = fmt.Sprint(vv)
			}
		}
	}
	for _, k := range keys {
		if v, ok := lookup(getenv, "SHELFMARK_"+strings.ToUpper(k)); ok {
			values[k] = v
		}
	}
	c := Default()
	if err := c.apply(values); err != nil {
		return nil, err
	}
	return c, nil
}

func lookup(getenv func(string) string, key string) (string, bool) {
	if getenv == nil {
		v, ok := os.LookupEnv(key)
		return v, ok
	}
	v := getenv(key)
	return v, v != ""
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (c *Config) apply(v map[string]string) error {
	var err error
	str := func(k string, dst *string) {
		if s, ok := v[k]; ok {
			*dst = strings.TrimSpace(s)
		}
	}
	boolean := func(k string, dst *bool) {
		if s, ok := v[k]; ok && err == nil && strings.TrimSpace(s) != "" {
			b, e := strconv.ParseBool(strings.TrimSpace(s))
			if e != nil {
				err = fmt.Errorf("%s: %w", k, e)
			}
			*dst = b
		}
	}
	integer := func(k string, dst *int) {
		if s, ok := v[k]; ok && err == nil && strings.TrimSpace(s) != "" {
			n, e := strconv.Atoi(strings.TrimSpace(s))
			if e != nil {
				err = fmt.Errorf("%s: %w", k, e)
			}
			*dst = n
		}
	}
	str("listen", &c.Listen)
	str("data_dir", &c.DataDir)
	str("base_url", &c.BaseURL)
	c.BaseURL = strings.TrimRight(c.BaseURL, "/")
	str("cf_access_team_domain", &c.CFAccessTeamDomain)
	c.CFAccessTeamDomain = strings.TrimRight(strings.TrimPrefix(strings.TrimPrefix(c.CFAccessTeamDomain, "https://"), "http://"), "/")
	str("default_user", &c.DefaultUser)
	str("fetch_user_agent", &c.FetchUserAgent)
	str("ai_base_url", &c.AIBaseURL)
	c.AIBaseURL = strings.TrimRight(c.AIBaseURL, "/")
	str("ai_api_key", &c.AIAPIKey)
	str("ai_model", &c.AIModel)
	str("metrics_token", &c.MetricsToken)
	str("log_level", &c.LogLevel)
	str("log_format", &c.LogFormat)
	boolean("dav_auto_create", &c.DAVAutoCreate)
	boolean("fetch_metadata", &c.FetchMetadata)
	boolean("fetch_allow_private", &c.FetchAllowPrivate)
	boolean("metrics", &c.Metrics)
	integer("guard_min_items", &c.GuardMinItems)
	integer("revision_keep_days", &c.RevisionKeepDays)
	integer("revision_keep_daily_days", &c.RevisionKeepDailyDays)
	integer("backup_keep", &c.BackupKeep)
	if err != nil {
		return err
	}
	if s, ok := v["guard_ratio"]; ok && strings.TrimSpace(s) != "" {
		f, e := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if e != nil || f < 0 {
			return fmt.Errorf("guard_ratio: 无效的比例 %q", s)
		}
		c.GuardRatio = f
	}
	if s, ok := v["linkcheck_interval"]; ok && strings.TrimSpace(s) != "" {
		s = strings.TrimSpace(s)
		if s == "0" {
			c.LinkcheckInterval = 0
		} else {
			d, e := time.ParseDuration(s)
			if e != nil {
				return fmt.Errorf("linkcheck_interval: %w", e)
			}
			c.LinkcheckInterval = d
		}
	}
	if s, ok := v["trusted_proxies"]; ok {
		c.TrustedProxies = nil
		for _, p := range splitList(s) {
			if !strings.Contains(p, "/") {
				addr, e := netip.ParseAddr(p)
				if e != nil {
					return fmt.Errorf("trusted_proxies: %w", e)
				}
				p = netip.PrefixFrom(addr, addr.BitLen()).String()
			}
			pf, e := netip.ParsePrefix(p)
			if e != nil {
				return fmt.Errorf("trusted_proxies: %w", e)
			}
			c.TrustedProxies = append(c.TrustedProxies, pf.Masked())
		}
	}
	if s, ok := v["allowed_origins"]; ok {
		c.AllowedOrigins = nil
		for _, o := range splitList(s) {
			u, e := url.Parse(o)
			if e != nil || u.Scheme == "" || u.Host == "" {
				return fmt.Errorf("allowed_origins: 无效的来源 %q", o)
			}
			c.AllowedOrigins = append(c.AllowedOrigins, strings.ToLower(u.Scheme+"://"+u.Host))
		}
	}
	if s, ok := v["cf_access_aud"]; ok {
		c.CFAccessAUD = splitList(s)
	}
	if s, ok := v["cf_access_users"]; ok {
		c.CFAccessUsers = map[string]string{}
		for _, pair := range splitList(s) {
			name, email, found := strings.Cut(pair, "=")
			name, email = strings.TrimSpace(name), strings.ToLower(strings.TrimSpace(email))
			if !found || name == "" || email == "" {
				return fmt.Errorf("cf_access_users: 应为 用户名=邮箱，得到 %q", pair)
			}
			c.CFAccessUsers[name] = email
		}
	}
	if c.BaseURL != "" {
		u, e := url.Parse(c.BaseURL)
		if e != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("base_url: 无效的地址 %q", c.BaseURL)
		}
	}
	return nil
}

// AIEnabled reports whether AI suggestions are configured.
func (c *Config) AIEnabled() bool { return c.AIBaseURL != "" && c.AIModel != "" }

// AccessEnabled reports whether Cloudflare Access JWT checks are configured.
func (c *Config) AccessEnabled() bool { return c.CFAccessTeamDomain != "" }

// BaseOrigin is scheme://host of BaseURL, or "".
func (c *Config) BaseOrigin() string {
	if c.BaseURL == "" {
		return ""
	}
	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}
