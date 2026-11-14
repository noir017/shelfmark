# 构建：make all（web → extension → server），产物 server/bin/shelfmark。
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
LDFLAGS := -s -w -X shelfmark/internal/config.Version=$(VERSION) -X shelfmark/internal/config.Commit=$(COMMIT)
EMBED   := server/internal/webui/dist
BIN     := server/bin/shelfmark
ZIPS    := extension/dist/shelfmark-chrome.zip extension/dist/shelfmark-firefox.zip

.PHONY: all web extension server clean clean-embed

all: web extension
	$(MAKE) server

web:
	cd web && npm ci && npm run build

extension:
	cd extension && npm ci && npm run build && npm run package

# 只打包已有产物，不重建 web / extension
server: clean-embed
	@test -f web/dist/index.html || { echo "缺 web/dist，先 make web"; exit 1; }
	@for f in $(ZIPS); do test -f $$f || { echo "缺 $$f，先 make extension"; exit 1; }; done
	cp -R web/dist/. $(EMBED)/
	mkdir -p $(EMBED)/downloads
	cp $(ZIPS) $(EMBED)/downloads/
	cd server && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/shelfmark ./cmd/shelfmark
	@ls -l $(BIN)

clean-embed:
	find $(EMBED) -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +

clean: clean-embed
	rm -rf web/dist extension/dist server/bin
