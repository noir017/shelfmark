// Package ai talks to an OpenAI-compatible /chat/completions endpoint.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	APIKey  string
	Model   string
	HTTP    *http.Client
}

func New(baseURL, apiKey, model string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey, Model: model, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

var ErrUpstream = errors.New("AI 服务不可用")

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatJSON sends a prompt asking for a JSON object and decodes the answer into out.
func (c *Client) ChatJSON(ctx context.Context, system, user string, out any) error {
	body, _ := json.Marshal(map[string]any{
		"model":           c.Model,
		"messages":        []message{{"system", system}, {"user", user}},
		"response_format": map[string]string{"type": "json_object"},
		"temperature":     0.2,
	})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: HTTP %d", ErrUpstream, resp.StatusCode)
	}
	var r struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &r); err != nil || len(r.Choices) == 0 {
		return fmt.Errorf("%w: 响应格式不对", ErrUpstream)
	}
	content := strings.TrimSpace(r.Choices[0].Message.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(strings.TrimSpace(content), "```")
	if err := json.Unmarshal([]byte(content), out); err != nil {
		return fmt.Errorf("%w: 输出不是 JSON", ErrUpstream)
	}
	return nil
}

// Folder is a candidate folder with its full path (including itself).
type Folder struct {
	ID   int64
	Path []string
}

func (f Folder) label() string {
	if len(f.Path) == 0 {
		return "（根目录）"
	}
	return strings.Join(f.Path, " / ")
}

func folderList(folders []Folder) string {
	var b strings.Builder
	for _, f := range folders {
		fmt.Fprintf(&b, "%d: %s\n", f.ID, f.label())
	}
	return b.String()
}

// FolderScore is a suggested folder.
type FolderScore struct {
	ID    int64
	Score float64
}

// Suggestion for saving one page.
type Suggestion struct {
	Title   string
	Folders []FolderScore
	Tags    []string
}

const suggestSystem = `You organize bookmarks. Answer with a JSON object only:
{"title": "<cleaned page title>", "folders": [{"id": <folder id>, "score": <0..1>}], "tags": ["tag", ...]}
Pick up to 3 folders from the given list (ids only from the list), best first. Give 3 to 5 short tags without spaces or commas, in the page's language. The title drops site-name suffixes and noise.`

// Suggest proposes folders, tags and a cleaned title for a page.
func (c *Client) Suggest(ctx context.Context, url, title, description string, folders []Folder) (*Suggestion, error) {
	user := fmt.Sprintf("URL: %s\nTitle: %s\nDescription: %s\n\nFolders (id: path):\n%s", url, title, description, folderList(folders))
	var out struct {
		Title   string `json:"title"`
		Folders []struct {
			ID    json.Number `json:"id"`
			Score float64     `json:"score"`
		} `json:"folders"`
		Tags []string `json:"tags"`
	}
	if err := c.ChatJSON(ctx, suggestSystem, user, &out); err != nil {
		return nil, err
	}
	valid := map[int64]bool{}
	for _, f := range folders {
		valid[f.ID] = true
	}
	s := &Suggestion{Title: strings.TrimSpace(out.Title), Folders: []FolderScore{}, Tags: CleanTags(out.Tags, 5)}
	seen := map[int64]bool{}
	for _, f := range out.Folders {
		id, err := f.ID.Int64()
		if err != nil || !valid[id] || seen[id] {
			continue
		}
		seen[id] = true
		score := f.Score
		if score < 0 {
			score = 0
		}
		if score > 1 {
			score = 1
		}
		s.Folders = append(s.Folders, FolderScore{ID: id, Score: score})
		if len(s.Folders) == 3 {
			break
		}
	}
	sort.SliceStable(s.Folders, func(i, j int) bool { return s.Folders[i].Score > s.Folders[j].Score })
	return s, nil
}

// Item is a bookmark to organize.
type Item struct {
	ID    int64
	Title string
	URL   string
}

// Placement is a suggestion for one bookmark.
type Placement struct {
	ItemID   int64
	FolderID int64
	Tags     []string
}

const organizeSystem = `You organize bookmarks. For each bookmark choose the best folder from the list (ids only from the list) and 1 to 5 short tags without spaces or commas.
Answer with a JSON object only: {"suggestions": [{"itemId": <id>, "folderId": <id>, "tags": ["tag", ...]}]}`

// Organize proposes a folder and tags for each bookmark.
func (c *Client) Organize(ctx context.Context, items []Item, folders []Folder) ([]Placement, error) {
	var b strings.Builder
	b.WriteString("Bookmarks (id: title | url):\n")
	for _, it := range items {
		fmt.Fprintf(&b, "%d: %s | %s\n", it.ID, it.Title, it.URL)
	}
	b.WriteString("\nFolders (id: path):\n")
	b.WriteString(folderList(folders))
	var out struct {
		Suggestions []struct {
			ItemID   json.Number `json:"itemId"`
			FolderID json.Number `json:"folderId"`
			Tags     []string    `json:"tags"`
		} `json:"suggestions"`
	}
	if err := c.ChatJSON(ctx, organizeSystem, b.String(), &out); err != nil {
		return nil, err
	}
	validItem, validFolder := map[int64]bool{}, map[int64]bool{}
	for _, it := range items {
		validItem[it.ID] = true
	}
	for _, f := range folders {
		validFolder[f.ID] = true
	}
	res := []Placement{}
	seen := map[int64]bool{}
	for _, s := range out.Suggestions {
		iid, err1 := s.ItemID.Int64()
		fid, err2 := s.FolderID.Int64()
		if err1 != nil || err2 != nil || !validItem[iid] || !validFolder[fid] || seen[iid] {
			continue
		}
		seen[iid] = true
		res = append(res, Placement{ItemID: iid, FolderID: fid, Tags: CleanTags(s.Tags, 5)})
	}
	return res, nil
}

// CleanTags trims tags, removes whitespace/commas and duplicates.
func CleanTags(tags []string, limit int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.TrimPrefix(strings.TrimSpace(t), "#")
		t = strings.Join(strings.FieldsFunc(t, func(r rune) bool { return r == ',' || r == '，' || r == ' ' || r == '\t' || r == '\n' }), "-")
		if t == "" || len([]rune(t)) > 64 || seen[strings.ToLower(t)] {
			continue
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
		if len(out) == limit {
			break
		}
	}
	return out
}
