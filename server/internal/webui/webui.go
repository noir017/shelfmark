// Package webui serves the embedded web app with SPA fallback.
package webui

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// dist is filled by the build (web/dist plus downloads/); the repo only keeps .gitkeep.
//
//go:embed all:dist
var dist embed.FS

// placeholder is served as index.html when the web app was not built in.
//
//go:embed placeholder.html
var placeholder []byte

// Go's built-in MIME table lacks .webmanifest, and distroless has no /etc/mime.types.
func init() { _ = mime.AddExtensionType(".webmanifest", "application/manifest+json") }

// FS is the embedded dist directory.
func FS() fs.FS {
	sub, _ := fs.Sub(dist, "dist")
	return sub
}

// Handler serves static files; unknown paths get index.html (SPA routing),
// except under /downloads/, which is served as-is.
func Handler(files fs.FS) http.Handler {
	fileServer := http.FileServerFS(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name != "" {
			if st, err := fs.Stat(files, name); err == nil && !st.IsDir() {
				if name == "index.html" || name == "sw.js" || name == "manifest.webmanifest" {
					w.Header().Set("Cache-Control", "no-cache")
				} else if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		if strings.HasPrefix(name, "downloads/") || name == "downloads" {
			http.NotFound(w, r)
			return
		}
		index, err := fs.ReadFile(files, "index.html")
		if err != nil {
			index = placeholder
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			w.Write(index)
		}
	})
}
