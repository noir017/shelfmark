package urlnorm

import "testing"

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"HTTPS://Example.COM:443/a/?utm_source=x&b=2&a=1#frag": "https://example.com/a?a=1&b=2",
		"http://example.com:80":                               "http://example.com/",
		"https://example.com/":                                "https://example.com/",
		"https://example.com/path/":                           "https://example.com/path",
		"https://example.com:8443/x?fbclid=1&gclid=2&spm=3":   "https://example.com:8443/x",
		"  https://example.com/x?mc_eid=1&q=中文  ":             "https://example.com/x?q=中文",
		"javascript:alert(1)":                                 "javascript:alert(1)",
		"not a url":                                           "not a url",
		"":                                                    "",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHostAndHTTP(t *testing.T) {
	if Host("https://Sub.Example.com:8080/x") != "sub.example.com" {
		t.Fatal("host")
	}
	if !IsHTTP("http://example.com") || IsHTTP("ftp://example.com") || IsHTTP("/relative") {
		t.Fatal("IsHTTP")
	}
}
