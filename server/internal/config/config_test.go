package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadFileAndEnv(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "c.yaml")
	os.WriteFile(file, []byte("listen: ':9000'\nguard_ratio: 0.3\ntrusted_proxies: [10.0.0.0/8, 127.0.0.1]\nallowed_origins: https://bm.example.com/,https://bm.lan.example.com\n"), 0o600)
	env := map[string]string{
		"SHELFMARK_LISTEN":                ":9100",
		"SHELFMARK_LINKCHECK_INTERVAL":    "0",
		"SHELFMARK_CF_ACCESS_USERS":       "alice=Alice@Example.com, bob=bob@example.org",
		"SHELFMARK_CF_ACCESS_AUD":         "aud1,aud2",
		"SHELFMARK_CF_ACCESS_TEAM_DOMAIN": "https://team.example.com/",
	}
	c, err := Load(file, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != ":9100" || c.GuardRatio != 0.3 || c.LinkcheckInterval != 0 || len(c.TrustedProxies) != 2 {
		t.Fatalf("%+v", c)
	}
	if c.AllowedOrigins[0] != "https://bm.example.com" || len(c.AllowedOrigins) != 2 {
		t.Fatalf("origins %v", c.AllowedOrigins)
	}
	if c.CFAccessUsers["alice"] != "alice@example.com" || c.CFAccessTeamDomain != "team.example.com" || !c.AccessSSO() {
		t.Fatalf("access %+v", c)
	}
	d, _ := Load("", func(string) string { return "" })
	if d.LinkcheckInterval != 168*time.Hour || !d.DAVAutoCreate || d.GuardMinItems != 20 {
		t.Fatalf("defaults %+v", d)
	}
	if _, err := Load("", func(k string) string {
		if k == "SHELFMARK_CF_ACCESS_USERS" {
			return "broken"
		}
		return ""
	}); err == nil {
		t.Fatal("expected error")
	}
}
