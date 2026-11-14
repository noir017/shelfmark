package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeLLM is an OpenAI-compatible stub; no real model is called.
func fakeLLM(t *testing.T, reply string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" {
			w.WriteHeader(404)
			return
		}
		var req struct {
			Model          string            `json:"model"`
			ResponseFormat map[string]string `json:"response_format"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Model != "fake-model" || req.ResponseFormat["type"] != "json_object" {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": reply}}}})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSuggest(t *testing.T) {
	srv := fakeLLM(t, "```json\n"+`{"title":"Go 文档","folders":[{"id":7,"score":0.4},{"id":99,"score":1},{"id":3,"score":0.9}],"tags":["go","#编程","go","a b"]}`+"\n```", 200)
	c := New(srv.URL+"/v1", "test-key", "fake-model")
	s, err := c.Suggest(context.Background(), "https://example.com", "Go docs", "", []Folder{{3, []string{"开发"}}, {7, []string{"开发", "Go"}}})
	if err != nil {
		t.Fatal(err)
	}
	if s.Title != "Go 文档" || len(s.Folders) != 2 || s.Folders[0].ID != 3 || strings.Join(s.Tags, ",") != "go,编程,a-b" {
		t.Fatalf("%+v", s)
	}
}

func TestOrganizeAndErrors(t *testing.T) {
	srv := fakeLLM(t, `{"suggestions":[{"itemId":1,"folderId":3,"tags":["x"]},{"itemId":2,"folderId":42,"tags":[]},{"itemId":9,"folderId":3}]}`, 200)
	c := New(srv.URL+"/v1", "test-key", "fake-model")
	p, err := c.Organize(context.Background(), []Item{{1, "a", "u"}, {2, "b", "v"}}, []Folder{{3, []string{"x"}}})
	if err != nil || len(p) != 1 || p[0].ItemID != 1 {
		t.Fatalf("%+v %v", p, err)
	}
	bad := New(fakeLLM(t, "not json", 200).URL+"/v1", "test-key", "fake-model")
	if _, err := bad.Suggest(context.Background(), "u", "t", "", nil); !errors.Is(err, ErrUpstream) {
		t.Fatalf("bad json: %v", err)
	}
	down := New(fakeLLM(t, "{}", 500).URL+"/v1", "test-key", "fake-model")
	if _, err := down.Suggest(context.Background(), "u", "t", "", nil); !errors.Is(err, ErrUpstream) {
		t.Fatalf("500: %v", err)
	}
}
