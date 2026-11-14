# shelfmark

自托管书签服务。一个 Go 程序同时提供：

- 给 [Floccus](https://floccus.org) 用的 WebDAV（XBEL），浏览器书签照常用 Floccus 同步；
- 网页 / PWA：管理、搜索、起始页、历史与恢复、失效检测，手机上可分享收藏；
- REST API 和配套浏览器插件（Chrome / Edge / Brave / Firefox）：一键收藏、已收藏提示、新标签页。

数据存在一个 SQLite 文件里，每次改动都有修订，可回滚；Floccus 大批量删除会先被拦下等你确认。

> **安全前提**：shelfmark 没有登录页，身份由网络位置决定 —— 内网请求直接是默认用户，经 Cloudflare 的请求必须带有效的 Access 身份。**只能部署在 Cloudflare Access 后面或可信内网里**，绝不要把端口直接暴露到公网。

## 快速开始（Docker Compose）

```sh
git clone <仓库地址> shelfmark && cd shelfmark
docker build -t shelfmark:latest .

mkdir -p ~/shelfmark && cp deploy/compose.example.yml ~/shelfmark/compose.yml && cd ~/shelfmark
mkdir -p data && sudo chown 65532:65532 data   # 容器以 uid 65532 运行
# 改 compose.yml 里的 SHELFMARK_BASE_URL 等占位值
docker compose up -d
```

端口只绑 `127.0.0.1:8080`，前面接反代（Caddy、Nginx、Cloudflare Tunnel 等）提供 HTTPS。首次启动会自动建管理员 `admin`（也可以用 `SHELFMARK_DEFAULT_USER` 指定名字），打开网页直接就是它，没有登录页。需要多用户时：

```sh
docker compose exec -T shelfmark shelfmark user add alice --admin
```

## 配置 Floccus

最省事：网页“设置 → 设备与令牌 → 添加 Floccus 设备”，选库，生成配置后照着填，或下载配置文件在 Floccus 里导入（导入后 Floccus 会让你选本地书签文件夹）。

手动填写时，Floccus 新建账户选 **WebDAV / XBEL**：

| Floccus 字段 | 填什么 |
|---|---|
| 服务器地址 | `https://bm.example.com/dav/` |
| 书签文件 | `<库>.xbel`，如 `bookmarks.xbel`（库不存在会自动创建） |
| 用户名 | shelfmark 用户名，如 `alice` |
| 密码 | `dav` 令牌（网页“设置 → 设备与令牌”生成） |

- **不要开 Floccus 的加密**（passphrase）：服务端要能读懂 XBEL。
- 一个 Floccus 账户同步一个库；每台设备一个令牌，丢了单独吊销。
- 某次同步要删掉大量书签时会被拦下（返回 412），到网页“被拦截的上传”里允许或丢弃。丢弃后在那台设备的 Floccus 里执行一次“拉取一次”（Pull down once）。

## 浏览器插件

网页“设置 → 插件与集成”下载，或直接取 `https://bm.example.com/downloads/shelfmark-chrome.zip` / `shelfmark-firefox.zip`。

- Chrome / Edge / Brave：解压，打开 `chrome://extensions`，开“开发者模式”，“加载已解压的扩展程序”选解压目录。
- Firefox（≥ 140）：zip 未签名，`about:debugging` → “此 Firefox” → “临时载入附加组件”选 zip；长期使用需自行签名，或用允许未签名扩展的 Developer Edition / ESR。

插件设置页填服务器地址，粘贴令牌（网页“设置 → 设备与令牌 → 添加插件/脚本令牌”生成，权限选 REST API）。内网和公网都用这一种方式。

## 手机：PWA 与分享收藏

- 用手机浏览器打开网页，菜单里“安装应用 / 添加到主屏幕”。
- Android（Chrome 系）：装成 PWA 后，在其它应用里“分享”选 shelfmark 即可收藏，可改标题、标签、文件夹。
- iOS 不支持 PWA 分享目标：用网页“设置 → 插件与集成”里的书签小工具，或把链接粘贴到网页的“收藏”页。
- 手机书签同步用 Floccus 的手机 App，配置同上。

## 反代与 Cloudflare Access

- 设好 `SHELFMARK_BASE_URL`（主地址，用于生成 Floccus 配置）和 `SHELFMARK_ALLOWED_ORIGINS`（网页可能从哪些地址打开，内网、公网域名都列上）。
- `SHELFMARK_TRUSTED_PROXIES` 填反代所在网段，只有它们转发的 `X-Forwarded-*`、`CF-Connecting-IP` 才被采信（限流、日志用真实 IP）。
- WebDAV 的 `MOVE` 只看 `Destination` 的路径，多层反代改了主机名也没关系。

公网走 Cloudflare Tunnel + Access 时：

- Access 应用对这些路径设 **Bypass**，由 shelfmark 自己认证：`/dav/`、`/api/`、`/manifest.webmanifest`、`/icons/`。其余（网页页面、静态资源、`/downloads/`）放在 Access 后面。
- 设 `SHELFMARK_CF_ACCESS_TEAM_DOMAIN` 和 `SHELFMARK_CF_ACCESS_AUD` 后，凡是带 `Cf-Ray` 头的请求（即经过 Cloudflare）都必须带有效的 Access JWT，否则 403。网页是过了 Access 才打开的，同域 Cookie 里有 `CF_Authorization`，直接就是对应身份；插件和脚本在公网只能用令牌。
- 身份映射：`SHELFMARK_CF_ACCESS_USERS=alice=alice@example.com` 把 Access 邮箱对到用户；没有映射时（单用户实例）落到默认用户。
- 插件不需要 Access 服务令牌。插件设置里的服务令牌（Client ID / Secret）是可选项，只在把 `/api/` 也放在 Access 后面的部署里才用：给该服务令牌加一条 Service Auth 策略。
- 其它统一登录网关同理：`/dav/` 必须放行；`/api/` 不放行时，插件要能带上网关认可的凭据。

## 配置项

环境变量，或 `shelfmark --config <file>` 读 YAML（键名去掉前缀转小写，如 `listen`、`data_dir`），环境变量优先。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SHELFMARK_LISTEN` | `:8080` | 监听地址 |
| `SHELFMARK_DATA_DIR` | `./data`（容器内 `/data`） | 数据库和备份目录 |
| `SHELFMARK_BASE_URL` | 空 | 对外主地址，如 `https://bm.example.com` |
| `SHELFMARK_ALLOWED_ORIGINS` | 空 | 允许的网页来源，逗号分隔；空则用 BASE_URL 和请求 Host |
| `SHELFMARK_TRUSTED_PROXIES` | 空 | 可信反代 CIDR，逗号分隔 |
| `SHELFMARK_CF_ACCESS_TEAM_DOMAIN` | 空 | Access 团队域，如 `example.cloudflareaccess.com`；空则不启用 Access 相关逻辑 |
| `SHELFMARK_CF_ACCESS_AUD` | 空 | Access 应用 AUD，逗号分隔可多个 |
| `SHELFMARK_CF_ACCESS_USERS` | 空 | Access 邮箱到用户的映射 `用户名=邮箱`，逗号分隔 |
| `SHELFMARK_DEFAULT_USER` | 空 | 内网请求用的用户，空则取最早创建的用户；首次启动没有用户时用它建管理员（默认 `admin`） |
| `SHELFMARK_DAV_AUTO_CREATE` | `true` | Floccus 上传到不存在的库文件时自动建库 |
| `SHELFMARK_GUARD_RATIO` / `SHELFMARK_GUARD_MIN_ITEMS` | `0.5` / `20` | 防误删阈值，比例为 0 关闭 |
| `SHELFMARK_REVISION_KEEP_DAYS` / `SHELFMARK_REVISION_KEEP_DAILY_DAYS` | `30` / `365` | 修订全保留天数 / 每日保留一份的天数 |
| `SHELFMARK_BACKUP_KEEP` | `14` | 每日自动备份保留份数，0 关闭 |
| `SHELFMARK_LINKCHECK_INTERVAL` | `168h` | 失效检测周期，0 关闭 |
| `SHELFMARK_FETCH_METADATA` | `true` | 抓图标和标题 |
| `SHELFMARK_FETCH_ALLOW_PRIVATE` | `true` | 是否允许抓内网地址 |
| `SHELFMARK_FETCH_USER_AGENT` | `shelfmark/<版本>` | 抓取用的 UA |
| `SHELFMARK_AI_BASE_URL` / `SHELFMARK_AI_API_KEY` / `SHELFMARK_AI_MODEL` | 空 | AI 建议（OpenAI 兼容接口），不设则关闭 |
| `SHELFMARK_METRICS` / `SHELFMARK_METRICS_TOKEN` | `false` / 空 | 开启 `/metrics`；设了令牌则需 Bearer |
| `SHELFMARK_LOG_LEVEL` / `SHELFMARK_LOG_FORMAT` | `info` / `text` | 日志级别和格式（`text` / `json`） |

## 备份与恢复

- 自动：每天一次，写到 `data/backups/shelfmark-YYYYMMDD-HHMMSS.db`，保留 `SHELFMARK_BACKUP_KEEP` 份。
- 手动：`docker compose exec shelfmark shelfmark backup`（写进 `data/backups/`），或 `shelfmark backup -o <文件>`。运行中可直接做。
- 导出某个库：`shelfmark export alice bookmarks --format html -o bookmarks.html`（也支持 `xbel`、`json`）；网页“设置 → 导入导出”同样可以。
- 恢复整个实例：

  ```sh
  docker compose stop
  cp data/backups/shelfmark-20260101-030000.db data/shelfmark.db
  rm -f data/shelfmark.db-wal data/shelfmark.db-shm
  docker compose start
  ```

- 只想撤回某次改动：网页“历史记录”里回滚到某个修订，或从“最近删除”恢复条目，不用动备份。

## 开发

需要 Go（见 `server/go.mod`）、Node 24。

```sh
make all          # 构建网页、插件，嵌入后编出 server/bin/shelfmark
make web | extension | server
make clean

cd server && go vet ./... && go test ./...
server/scripts/smoke.sh                          # 起临时实例走一遍主流程；SHELFMARK_BIN=... 指定已编好的二进制
cd web && npm run dev                            # 带内存假后端
cd web && npm run check && npm run test:unit
cd extension && npm run build && npm run test:unit
cd extension && npm run fake-server              # 插件用的假服务端
cd web && npm run test:real                      # make all 之后：网页关键流程对真实二进制跑
cd extension && npm run test:real                # make all 之后：插件冒烟对真实二进制跑
npm run gen:api                                  # 在 web/ 或 extension/ 下，按 api/openapi.yaml 重新生成类型

docker buildx build --platform linux/amd64,linux/arm64 -t shelfmark:latest .
```

设计见 `docs/design.md`，接口契约见 `api/openapi.yaml`（改接口先改契约）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
