#!/usr/bin/env bash
# Smoke test: build, start on a random port with a temp data dir, and walk
# through default identity -> bookmark -> WebDAV GET/PROPFIND -> PUT -> history -> restore.
# Needs: go, curl, python3. Usage: server/scripts/smoke.sh
# SHELFMARK_BIN=<path> tests an already built binary instead of building one.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
bin="${SHELFMARK_BIN:-$work/shelfmark}"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

[ -n "${SHELFMARK_BIN:-}" ] || (cd "$here" && CGO_ENABLED=0 go build -o "$bin" ./cmd/shelfmark)
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
base="http://127.0.0.1:$port"

SHELFMARK_LISTEN="127.0.0.1:$port" SHELFMARK_DATA_DIR="$work/data" SHELFMARK_FETCH_METADATA=false \
  SHELFMARK_LINKCHECK_INTERVAL=0 "$bin" serve >"$work/server.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -fsS "$base/healthz" >/dev/null 2>&1 && break; sleep 0.1; done

jar="$work/cookies"
pass=0
step() { echo "ok - $1"; pass=$((pass + 1)); }
fail() { echo "FAIL - $1" >&2; echo "--- server log" >&2; cat "$work/server.log" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d' + sys.argv[1]))" "$1"; }
api() { # method path [json]
  curl -sS -b "$jar" -c "$jar" -X "$1" -H 'X-Requested-With: shelfmark' -H 'Content-Type: application/json' \
    ${3:+--data "$3"} -w '\n%{http_code}' "$base$2"
}
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }

[ "$(curl -fsS "$base/healthz" | cut -c1-2)" = "ok" ] || fail healthz
step healthz

r="$(api GET /api/v1/auth/me)"
[ "$(code "$r")" = 200 ] || fail "me: $r"
[ "$(body "$r" | json "['authMethod']")" = lan ] || fail "authMethod: $r"
[ "$(body "$r" | json "['user']['username']")" = admin ] || fail "default user: $r"
step "内网直连（默认用户 admin）"

r="$(api POST /api/v1/libraries/bookmarks/items '{"type":"bookmark","title":"Example","url":"https://example.com/"}')"
[ "$(code "$r")" = 201 ] || fail "create bookmark: $r"
step "建书签"

r="$(api POST /api/v1/tokens '{"name":"smoke","scopes":["dav"]}')"
[ "$(code "$r")" = 201 ] || fail "token: $r"
tok="$(body "$r" | json "['token']")"
dav=(-sS -u "admin:$tok")

get="$(curl "${dav[@]}" "$base/dav/bookmarks.xbel")"
grep -q '<title>Example</title>' <<<"$get" || fail "dav get: $get"
len="$(printf '%s' "$get" | wc -c | tr -d ' ')"
prop="$(curl "${dav[@]}" -X PROPFIND -H 'Depth: 0' "$base/dav/bookmarks.xbel")"
plen="$(sed -n 's/.*<D:getcontentlength>\([0-9]*\)<.*/\1/p' <<<"$prop")"
[ "$len" = "$plen" ] || fail "GET $len bytes vs PROPFIND $plen"
step "DAV GET/PROPFIND 长度一致（$len 字节）"

cat >"$work/upload.xbel" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">
<xbel version="1.0">
<!--- highestId :3: for Floccus bookmark sync browser extension -->

<bookmark href="https://example.com/" id="1">
  <title>Example</title>
</bookmark>
<folder id="2">
  <title>工具</title>
  <bookmark href="https://example.org/" id="3">
    <title>Org</title>
  </bookmark>
</folder>
</xbel>
EOF
c="$(curl "${dav[@]}" -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$work/upload.xbel" "$base/dav/bookmarks.xbel.temp")"
[ "$c" = 201 ] || fail "PUT temp: $c"
c="$(curl "${dav[@]}" -o /dev/null -w '%{http_code}' -X MOVE -H "Destination: https://bm.example.com/dav/bookmarks.xbel" -H 'Overwrite: T' "$base/dav/bookmarks.xbel.temp")"
[ "$c" = 204 ] || fail "MOVE: $c"
step "PUT temp + MOVE 上传"

r="$(api GET /api/v1/libraries/bookmarks/tree)"
[ "$(body "$r" | json "['children'][1]['title']")" = "工具" ] || fail "tree: $r"
step "树已变化"

r="$(api GET /api/v1/libraries/bookmarks/revisions)"
n="$(body "$r" | json "['items'].__len__()")"
src="$(body "$r" | json "['items'][0]['source']")"
first="$(body "$r" | json "['items'][-1]['rev']")"
[ "$n" -ge 2 ] && [ "$src" = webdav ] || fail "history: $r"
step "历史有修订（$n 个，最新来源 $src）"

r="$(api POST "/api/v1/libraries/bookmarks/revisions/$first/restore")"
[ "$(code "$r")" = 200 ] || fail "restore: $r"
r="$(api GET /api/v1/libraries/bookmarks/tree)"
[ "$(body "$r" | json "['children'].__len__()")" = 1 ] || fail "after restore: $r"
get="$(curl "${dav[@]}" "$base/dav/bookmarks.xbel")"
grep -q '工具' <<<"$get" && fail "dav still has folder after restore"
step "回滚到修订 $first"

echo "smoke: $pass passed"
