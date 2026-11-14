# shelfmark 设计文档

## 0. 目标

一个 Go 程序、一个容器、一个数据目录，解决多设备、多浏览器的书签同步和访问：

- 电脑上各浏览器（Chrome、Edge、Firefox、Brave……）装 [Floccus](https://floccus.org)，通过本服务内置的 WebDAV 双向同步浏览器原生书签，文件夹和顺序都保留。
- 手机和任意浏览器打开网页使用；网页可安装为 PWA，能从系统分享菜单收藏，离线可读、离线收藏排队。
- 自带浏览器插件做快速收藏、地址栏搜索、新标签页书签页；插件不碰浏览器原生书签，同步只交给 Floccus。
- 服务端记录每一次变更，可查看差异、整库回滚、恢复误删；大批量删除自动拦截待确认。

非目标：网页全文存档、截图、多人协作共享、Safari 原生书签同步。

## 1. 总体结构

```
电脑浏览器 ── Floccus ── WebDAV /dav/<库>.xbel ──┐
电脑浏览器 ── shelfmark 插件 ── REST /api/v1 ────┤
手机 / 任意浏览器 ── 网页 + PWA ── REST /api/v1 ──┼── shelfmark（Go 单程序）── SQLite（data/shelfmark.db）
脚本 / Prometheus ── REST / /metrics ────────────┘
```

- 唯一数据源是 SQLite。WebDAV 上的 `<库>.xbel` 是按需从数据库生成的虚拟文件，Floccus 上传的 XBEL 被解析后写回数据库。
- 一个进程内完成所有事：HTTP 服务、WebDAV、后台任务（元数据抓取、失效检测、修订清理、自动备份、可选 AI）。
- 网页构建产物和插件压缩包都用 `go:embed` 打进二进制。

## 2. 概念

| 概念 | 说明 |
|---|---|
| 用户 user | 支持多用户，各自数据隔离。首个用户是管理员。没有公开注册。 |
| 库 library | 一棵书签树，对应 WebDAV 上一个文件 `<slug>.xbel`，Floccus 一个配置同步一个库。新用户自动建库 `bookmarks`（Floccus 默认文件名）。可按用途建多个库（如 `common`、`work`）。 |
| 条目 item | 文件夹 folder 或书签 bookmark。有序、可嵌套。 |
| 条目 ID | 每个库内一个整数 ID 空间，文件夹和书签共用。`0` 是虚拟根。Floccus 上传的 ID 原样保留；服务端新建条目用 `highest_id + 1`。`highest_id` 只增不减，删除的 ID 不复用。 |
| 修订 revision | 库的每次有效变更产生一个修订号（单调递增），保存变更后的整树快照。来源：webdav / web / api / extension / import / restore / system。 |
| 元数据 meta | 不进 XBEL 的附加信息：备注、标签、图标、访问次数、失效检测结果。Floccus 同步不会丢它们。 |
| 设备令牌 token | 每台设备一个，scope 为 `dav`（Floccus）或 `api`（插件、脚本），可单独吊销。修订记录用令牌名标识是哪台设备改的。 |

## 3. 数据模型（SQLite）

驱动用 `modernc.org/sqlite`（纯 Go，`CGO_ENABLED=0`，方便多架构）。WAL 模式，`busy_timeout=5000`，外键开启。迁移用内嵌 SQL 文件按序执行，记录在 `schema_migrations`。

```sql
users(id INTEGER PK, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, created_at, updated_at)

sessions(id TEXT PK /* 随机 32 字节 base64url 的 sha256 */, user_id, created_at, expires_at,
         last_seen_at, user_agent, ip)

tokens(id INTEGER PK, user_id, name TEXT NOT NULL, scopes TEXT NOT NULL /* "api" / "dav" / "api,dav" */,
       token_hash TEXT UNIQUE NOT NULL /* sha256 */, prefix TEXT NOT NULL /* 明文前 8 位，便于辨认 */,
       created_at, last_used_at, last_used_ip, revoked_at)

libraries(id INTEGER PK, user_id, slug TEXT NOT NULL, name TEXT NOT NULL,
          highest_id INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
          created_at, updated_at, last_sync_at, last_sync_actor,
          UNIQUE(user_id, slug))

items(library_id, id INTEGER, parent_id INTEGER NOT NULL /* 0 = 根 */, position INTEGER NOT NULL,
      type TEXT NOT NULL /* folder | bookmark */, title TEXT NOT NULL DEFAULT '', url TEXT,
      created_at, updated_at,
      PRIMARY KEY(library_id, id))
-- 索引：(library_id, parent_id, position)

item_meta(library_id, item_id, notes TEXT, normalized_url TEXT, favicon_id TEXT,
          visit_count INTEGER DEFAULT 0, last_visited_at,
          health_status TEXT /* ok|redirect|broken|unreachable|skipped|unknown */,
          health_http_status INTEGER, health_final_url TEXT, health_checked_at, health_error TEXT,
          meta_fetched_at,
          PRIMARY KEY(library_id, item_id))
-- 索引：(library_id, normalized_url)

tags(id INTEGER PK, user_id, name TEXT NOT NULL, UNIQUE(user_id, name))
item_tags(library_id, item_id, tag_id, PRIMARY KEY(library_id, item_id, tag_id))

favicons(id TEXT PK /* 内容 sha256 前 32 位 hex */, mime TEXT, data BLOB, source_url TEXT, fetched_at)
favicon_hosts(host TEXT PK, favicon_id, fetched_at, failed_at)   -- 按域名缓存，失败 24 小时内不重试

revisions(library_id, rev INTEGER, created_at, source TEXT, actor TEXT,
          added INTEGER, removed INTEGER, changed INTEGER, moved INTEGER, total_bookmarks INTEGER,
          snapshot BLOB /* gzip 的规范 JSON 树，见 6.1 */, snapshot_hash TEXT,
          PRIMARY KEY(library_id, rev))

pending_uploads(id INTEGER PK, library_id, created_at, actor, xbel BLOB /* gzip */,
                added, removed, changed, moved, total_before, reason TEXT)

dav_files(user_id, name TEXT /* 非库文件：*.lock、*.temp、其它 */, data BLOB, content_type,
          created_at, modified_at, token_id /* 写入它的设备 */, PRIMARY KEY(user_id, name))

user_settings(user_id PK, json TEXT NOT NULL)   -- 见 openapi 的 Settings

job_runs(name TEXT, started_at, finished_at, ok INTEGER, summary TEXT)

-- 全文搜索：FTS5，trigram 分词（中文子串可搜），external content 方式维护
items_fts(title, url, notes, tags, path)   -- rowid 映射到 (library_id, item_id) 的辅助表 items_fts_map
```

说明：

- `normalized_url`：小写 scheme/host，去默认端口、去 fragment、去 `utm_*`/`fbclid`/`gclid`/`mc_eid`/`spm` 等追踪参数、参数排序、去掉路径末尾单个 `/`（根路径除外）。用于查重、`lookup`、元数据迁移。
- 所有时间存 UTC RFC3339（毫秒），API 输出同格式。

## 4. Floccus WebDAV 兼容层

依据 Floccus 源码（仓库 `floccusaddon/floccus`，分支 `develop`）：`src/lib/adapters/WebDav.ts`、`src/lib/serializers/Xbel.ts`、`src/lib/serializers/DerivedIds.ts`。实现前务必读一遍这几个文件，以源码为准。

### 4.1 Floccus 的行为（浏览器插件端）

一次同步：

1. `GET <file>.lock`
   - 200 且 `Last-Modified` 在 15 分钟内 → 认为被锁，报错重试；200 但无 `Last-Modified` → 也认为被锁。
   - 404 → `PUT <file>.lock`（内容 `<html><body>I am a lock file</body></html>`）。PUT 返回 423/409 视为被锁。
2. `GET <file>` → 404 表示服务器上还没有，Floccus 会清缓存后整体上传；200 则解析。
   - 浏览器端紧接着 `PROPFIND <file>`（`Depth: 0`），从响应里正则取 `getcontentlength`，必须等于 GET 正文的 UTF-8 字节数，否则报 `FileSizeMismatch`。
   - 正文必须包含字面量 `<?xml version="1.0" encoding="UTF-8"?>`。
   - 从包含 `<!--- highestId :` 的那一行解析 `highestId`。
3. 同步期间每 2 分钟重新 `PUT <file>.lock` 续锁。
4. 树有变化（或需要持久化派生 ID）时上传：
   - 浏览器端：`PUT <file>.temp` → `PROPFIND <file>.temp` 校验大小 → `MOVE <file>.temp`，`Destination: <file 的完整 URL>`、`Overwrite: T` → `PROPFIND <file>` 校验大小。MOVE 返回 409 时它会先 `DELETE <file>` 再 MOVE 一次。失败会 `DELETE <file>.temp`。
   - 手机 App（原生）：直接 `PUT <file>`，再 `HEAD <file>` 用 `Content-Length` 校验。
5. `DELETE <file>.lock`，接受 200/204/404。

认证是 HTTP Basic。开了加密的话正文是 JSON `{"ciphertext":..., "salt":...}` 或纯密文。

### 4.2 服务端约定

- 根路径：`/dav/`，每个用户看到自己的命名空间。Floccus 里填：服务器地址 `https://<host>/dav/`，文件名 `<slug>.xbel`，用户名 = 用户名，密码 = `dav` 令牌。
- 只认扁平文件名，不支持子目录（文件名带 `/` 返回 404 并在正文说明）。
- 库文件：名字匹配 `^[A-Za-z0-9._-]{1,64}\.xbel$`，slug = 去掉 `.xbel`。
- 其它文件（`*.lock`、`*.temp`、任意名）存 `dav_files`，单文件上限 32 MiB；`*.temp` 超过 24 小时清理。

| 方法 | 库文件 `<slug>.xbel` | 其它文件 |
|---|---|---|
| `OPTIONS` | `DAV: 1`，`Allow` 列出支持的方法 | 同左 |
| `GET` / `HEAD` | 库存在 → 200，正文为生成的 XBEL，`Content-Type: application/xml; charset=utf-8`，`Content-Length`、`Last-Modified`（库最后修订时间）、`ETag: "r<revision>"`，`Cache-Control: no-store`；库不存在 → 404 | 存在 → 原样返回，`Last-Modified` = 最后写入时间；不存在 → 404 |
| `PROPFIND` Depth 0 | 207 multistatus：`getcontentlength`（与 GET 字节数一致）、`getlastmodified`、`getetag`、`getcontenttype`、空 `resourcetype` | 同左 |
| `PROPFIND /dav/` Depth 0/1 | 集合本身 + 所有库文件 + 其它文件 | |
| `PUT` | 解析并应用上传（见 4.4）。库不存在且开启 `SHELFMARK_DAV_AUTO_CREATE`（默认开）则自动建库，名字 = slug | 写入；`*.lock` 见 4.3 |
| `MOVE` | 源必须是 `dav_files` 里的文件。目标是库文件 → 把源内容当上传应用（见 4.4），成功后删源；`Overwrite: F` → 412 | 普通改名；目标已存在且 `Overwrite: F` → 412 |
| `DELETE` | 一律 403（库只能在网页里删，防止误删整库；Floccus 只在 MOVE 409 时才会删目标，我们不返回 409） | 删除，返回 204；不存在 404 |
| `COPY`/`MKCOL`/`LOCK`/`UNLOCK`/`PROPPATCH` | 405 | 405 |

### 4.3 锁

- `PUT <slug>.xbel.lock`：在该库的互斥锁内执行；锁已存在且 15 分钟内被别的令牌写过 → 423；同一令牌续锁 → 更新 `modified_at`，返回 201/204。记录写锁的令牌，网页上显示“被某设备锁定”。
- 锁新鲜度判断统一用 15 分钟（与 Floccus 的 `LOCK_TIMEOUT` 一致）。
- 网页 / API 写入时若锁新鲜：在服务端最多等 10 秒（每 250ms 检查），仍被锁则返回 423，`Retry-After: 5`，错误码 `locked`，带锁的设备名和时间。
- 网页提供“强制解锁”（`POST /api/v1/libraries/{slug}/lock/release`）。

### 4.4 应用一次上传

1. 读正文（上限 32 MiB）。识别加密：正文去空白后以 `{` 开头且能解析出 `ciphertext` → 415，错误说明“请在 Floccus 里关闭加密”。不含字面量 XML 头或根元素不是 `xbel` → 415。HTML 书签格式 → 415（只支持 XBEL）。
2. 解析 XBEL（`encoding/xml` 流式解析，禁止外部实体，深度上限 64，条目上限 200000）。规则对齐 Floccus 的 `Xbel.ts`：`bookmark` 取 `href`、`id`、子元素 `title`；`folder` 取 `id`、`title`、递归；缺 `id` 的条目按 Floccus `DerivedIds.ts` 的规则补派生 ID（实现前读源码对齐）。忽略 `desc`、`info`、`separator` 等其它元素。
3. 校验：ID 在本次文件内唯一；违反 → 400。
4. 与当前树按 ID 比较，算出 added / removed / changed（标题或 URL）/ moved（父或位置）。
5. 防误删保护：当前书签数 ≥ `SHELFMARK_GUARD_MIN_ITEMS`（默认 20），且本次删除的书签数 ≥ 当前书签数 × `SHELFMARK_GUARD_RATIO`（默认 0.5）→ 不应用，存入 `pending_uploads`，返回 412，正文为纯文本说明（“这次上传会删除 N 个书签，已拦截，请到网页确认”）。`SHELFMARK_GUARD_RATIO=0` 关闭。
6. 应用（单事务）：替换该库 `items`；元数据迁移：被删条目的 `normalized_url` 若与本次新增条目相同，把备注、标签、访问、图标、检测结果迁到新 ID（处理浏览器改 ID 的情况）；无主元数据删除。
7. `highest_id = max(原值, 文件里的 highestId, 文件最大 ID)`。
8. 生成修订（见第 6 节），`source=webdav`，`actor=令牌名`；更新 `last_sync_at`/`last_sync_actor`。
9. 新增书签进元数据抓取队列（只抓图标，不改浏览器带来的标题）。
10. 返回：PUT 201/204，MOVE 201/204。

### 4.5 生成 XBEL

字节级对齐 Floccus 的 `createXBEL` + `XbelSerializer.serialize`（fast-xml-parser `format: true`）输出，便于肉眼对比和测试：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">
<xbel version="1.0">
<!--- highestId :42: for Floccus bookmark sync browser extension -->
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
```

缩进、换行、属性顺序以 fast-xml-parser 实际输出为准：用 Floccus 源码生成几份样例文件放进 `server/internal/xbel/testdata/`，做往返测试（解析 → 生成 → 字节相同）。同一修订的输出缓存，保证 GET 和 PROPFIND 的长度一致。

## 5. 写入协调

- 每个库一把进程内互斥锁。DAV 的 PUT/MOVE/锁操作、API 写入、任务写入都先拿锁，再开事务。
- API 写入在拿锁后检查 Floccus 锁（4.3）。
- 读不拿锁（WAL 下读一致）。
- 位置 `position` 为兄弟间从 0 开始的连续整数；插入、移动、删除后重排受影响的兄弟。

## 6. 修订、历史与恢复

### 6.1 快照

规范 JSON：`{"highestId":N,"items":[{"id","parentId","position","type","title","url","notes","tags"}...]}`，按 (parentId, position) 排序，gzip 存储。`snapshot_hash` = 规范 JSON 的 sha256。新快照与上一个哈希相同则不生成修订（Floccus 常会上传未变的文件）。

### 6.2 合并

网页 / API / 插件的连续编辑：同一 actor、同一 source、距上一修订不到 120 秒 → 覆盖上一修订的快照和计数，不新增修订（避免历史太碎）。DAV 上传和恢复操作不合并。

### 6.3 差异

修订的差异按需计算：与前一修订的快照比较，给出 added / removed / changed / moved 列表，每项带所在路径（文件夹标题数组）。计数字段在写入时存好，列表页不必解压快照。

### 6.4 保留策略

最近 `SHELFMARK_REVISION_KEEP_DAYS`（默认 30）天全部保留；更早的每天只留最后一个，最多保留 `SHELFMARK_REVISION_KEEP_DAILY_DAYS`（默认 365）天。每天清理一次。

### 6.5 恢复

- 整库回滚到某修订：用该快照替换当前树（保留原 ID，`highest_id` 不回退），生成新修订 `source=restore`。Floccus 下次同步会把浏览器改成回滚后的样子。
- 恢复误删条目：“最近删除”列表由修订差异汇总（默认 30 天）。恢复时用新 ID 重建，放回原父文件夹（父不存在则放到根下“已恢复”文件夹），备注和标签一并恢复。
- 拦截的上传：网页显示差异，“允许”= 按 4.4 第 6 步起应用，`source=webdav`、actor 加“（已确认）”；“丢弃”= 删除记录，并提示用户在该设备的 Floccus 里执行一次“从服务器覆盖本地”（具体菜单名按 Floccus 当前版本写进页面提示）。

## 7. 认证与安全

- 密码：argon2id（`golang.org/x/crypto/argon2`，m=64MiB, t=1, p=2，参数编码进哈希串）。最短 8 位。
- 首个用户：环境变量 `SHELFMARK_ADMIN_USER` + `SHELFMARK_ADMIN_PASSWORD` 在数据库没有用户时创建；或命令行 `shelfmark user add --admin`。都没有时网页显示“首次设置”页面，只允许在没有任何用户时访问。
- 网页会话：Cookie `shelfmark_session`，HttpOnly、SameSite=Lax、`Secure`（`SHELFMARK_BASE_URL` 是 https 或请求经可信代理标记为 https 时），有效期 30 天、滑动续期。数据库只存会话 ID 的哈希。
- CSRF：Cookie 认证的写请求必须带请求头 `X-Requested-With: shelfmark`，且 `Origin`（有则）必须与 `SHELFMARK_BASE_URL` 或请求 Host 同源。服务端不开 CORS。
- API：`Authorization: Bearer <token>`，需要 scope `api`。
- WebDAV：Basic，密码必须是 scope 含 `dav` 的令牌（不接受账户密码）。失败返回 401 + `WWW-Authenticate: Basic realm="shelfmark"`。
- 令牌：32 字节随机，格式 `smk_<base62>`，只在创建时返回一次，库里存 sha256。记录最后使用时间和 IP（每分钟最多写一次）。
- 限流：登录和 Basic 认证失败按 IP 计数，10 次/10 分钟后锁 15 分钟，返回 429。
- 可信代理：`SHELFMARK_TRUSTED_PROXIES`（CIDR 列表）内的来源才采信 `X-Forwarded-For`/`X-Forwarded-Proto`。
- 安全响应头：`Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`。
- 外链抓取（元数据、失效检测）：超时 15 秒，响应最多读 2 MiB，最多 5 次跳转，只允许 http/https。`SHELFMARK_FETCH_ALLOW_PRIVATE`（默认 true，自托管时内网书签也要能抓图标）设为 false 时拒绝私有/回环/链路本地地址（解析后校验，防 DNS 重绑定）。
- 多用户隔离：所有查询带 `user_id`；库 slug 只在用户内唯一。

### 7.1 反代与 Cloudflare Access

部署形态：内网域名直连家里反代 → shelfmark；公网域名走 Cloudflare Tunnel，前面套 Cloudflare Access（交互式登录，浏览器用）。代码要同时适配两条路：

- **多个来源**：`SHELFMARK_ALLOWED_ORIGINS`（逗号分隔，如 `https://bm.example.com,https://bm.lan.example.com`）。CSRF 的 Origin 校验对其中任一通过即可；为空时退回 `SHELFMARK_BASE_URL` 加请求 Host。`SHELFMARK_BASE_URL` 仍是“主地址”，用于生成 Floccus 配置。
- **WebDAV 的 `Destination` 头**：只取路径部分判断是否在 `/dav/` 下，不要求主机名与请求 Host 相同（经多层反代后经常不同）。
- **真实客户端 IP**：来自可信代理的请求，若带 `CF-Connecting-IP` 优先用它，其次 `X-Forwarded-For` 最左一个非可信地址。限流和日志都用它。
- **Access 放行路径**：Floccus 和手机 Floccus App 做不了 Access 的交互登录，所以公网上 Access 对这些路径设为 bypass，靠 shelfmark 自己的令牌认证：`/dav/`、`/manifest.webmanifest`、`/icons/`（PWA 安装时浏览器取这两样不一定带 Cookie）。其余路径（网页、`/api/`）都在 Access 后面。
- **插件过 Access**：插件请求带不上 Access 的登录 Cookie，改用 Access 服务令牌。插件设置里可选填 `CF-Access-Client-Id` / `CF-Access-Client-Secret`，每个 API 请求都带上这两个头；Access 应用为该服务令牌加一条 Service Auth 策略。
- **密码类接口的二次把关**：请求带 `Cf-Ray` 头（说明经过了 Cloudflare，即来自公网）且配置了 Access 时，`/api/v1/setup`、`/api/v1/auth/login`、`/api/v1/auth/token`、`/api/v1/auth/password` 必须带有效的 Access JWT（请求头 `Cf-Access-Jwt-Assertion` 或 Cookie `CF_Authorization`），否则 403。用令牌认证的请求（Bearer、Basic）不受影响。内网直连的请求没有 `Cf-Ray`，照常用密码登录。
- **JWT 校验**：RS256，公钥从 `https://<team 域>/cdn-cgi/access/certs` 获取并缓存（1 小时刷新，遇到未知 `kid` 立即刷新），校验 `aud`（`SHELFMARK_CF_ACCESS_AUD`，可多个）、`iss`（`https://<team 域>`）、`exp`/`nbf`（允许 60 秒偏差）。
- **单点登录（可选）**：`SHELFMARK_CF_ACCESS_USERS=alice=alice@example.com,bob=bob@example.org` 把 Access 邮箱映射到 shelfmark 用户。网页登录页先调 `POST /api/v1/auth/access`：JWT 有效且邮箱有映射 → 直接建立会话，不用再输密码；否则显示密码登录。`SystemInfo.features.cfAccessSso` 表示是否启用。
- **网页适配 Access 会话过期**：Access 会话过期后，API 请求会被重定向到 Access 登录页（跨域，`fetch` 表现为网络错误或拿到 HTML）。网页要识别这种情况，提示“Cloudflare 登录已过期”，点一下整页刷新重新登录；Service Worker 不得把 Access 登录页当成应用页面缓存，导航请求只在真正断网时才回退到缓存。`<link rel="manifest">` 加 `crossorigin="use-credentials"`。
- **插件识别被 Access 拦截**：响应是跳转到 `*.cloudflareaccess.com`、或拿到 HTML、或 Access 的 403 → 提示“被 Cloudflare Access 拦截，请在设置里填服务令牌”。插件里的图标用带认证头的 `fetch` 取回再转成 blob URL，不能直接 `<img src>`。

## 8. REST API

完整定义见 `api/openapi.yaml`（OpenAPI 3.1），它是服务端、网页、插件之间的契约。要点：

- 前缀 `/api/v1`，JSON，错误统一 `{"error":{"code","message","details"}}`。错误码：`unauthorized`、`forbidden`、`not_found`、`conflict`、`locked`、`validation`、`payload_too_large`、`unsupported_media_type`、`rate_limited`、`guarded`、`internal`。
- 写操作响应里带最新 `revision`。树接口支持 `ETag: "r<revision>"` / `If-None-Match` → 304。
- 自定义动作用子路径动词（如 `items/batch`、`lock/release`、`pending/{id}/approve`），方便 Go 1.22 `ServeMux` 路由。
- 分组：auth、setup、users、tokens、floccus、libraries、tree/items、quick-save/lookup、search、tags、visits、favicons、meta、revisions、deleted、pending、reports、jobs、import/export、settings、ai、system。

## 9. 搜索

- FTS5 trigram，字段 title、url、notes、tags、path。查询词不足 3 个字符时退化为 `LIKE`。
- 语法：普通词（AND）、`"短语"`、`#标签`、`site:example.com`、`in:文件夹名`、`lib:slug`、`is:broken`、`is:duplicate`、`-排除词`。
- 排序：FTS bm25 + 访问次数加权 + 标题命中优先。返回所在路径和高亮片段。
- 条目写入、元数据变更、文件夹改名（影响子孙 path）时同步更新索引。

## 10. 后台任务

统一调度器（进程内），每个任务可在配置里关闭、可从 API 手动触发，状态写 `job_runs`。

| 任务 | 默认 | 内容 |
|---|---|---|
| 元数据抓取 | 队列，并发 2 | 新书签抓图标（`<link rel=icon/apple-touch-icon>`，回退 `/favicon.ico`），按域名缓存；网页/插件新建且无标题时补标题和描述（标题变更走 system 修订）。 |
| 失效检测 | 每 7 天 | HEAD，失败或 405 再 GET；跟随跳转；同域名每秒最多 1 个请求，全局并发 4；结果写 `item_meta`。非 http(s) 标为 skipped。只报告，不自动改。 |
| 修订清理 | 每天 | 按 6.4。 |
| 临时文件清理 | 每小时 | `*.temp` 超 24 小时、过期会话。 |
| 自动备份 | 每天 | `VACUUM INTO data/backups/shelfmark-YYYYMMDD-HHMMSS.db`，保留最近 `SHELFMARK_BACKUP_KEEP`（默认 14）份。 |
| AI 建议 | 按需 | 见 10.1，未配置时关闭。 |

### 10.1 AI（可选）

配置 `SHELFMARK_AI_BASE_URL`、`SHELFMARK_AI_API_KEY`、`SHELFMARK_AI_MODEL`（OpenAI 兼容 `/chat/completions`）后启用：

- 收藏建议：给定 URL、标题（服务端先抓页面标题和描述），从该库现有文件夹路径列表里推荐最合适的 3 个，外加 3–5 个标签和整理过的标题。快速收藏页和插件弹窗展示，用户点选。
- 整理文件夹：对指定文件夹里的书签（最多 100 个）批量给出“移到哪个文件夹 + 标签”的建议，网页逐条或全部接受。
- 请求用 JSON 输出格式，超时 30 秒，失败不影响主流程。测试一律用假服务。

## 11. 导入导出

- 导入：Netscape HTML（Chrome/Edge/Firefox 导出，保留文件夹层级、ADD_DATE、TAGS 属性转标签）、XBEL、shelfmark JSON。自动识别格式。模式：
  - `folder`（默认）：导入到新文件夹“导入 YYYY-MM-DD”。
  - `merge`：按路径合并文件夹，同一文件夹下已存在相同 `normalized_url` 的跳过。
  - `replace`：替换整库（会生成修订，可回滚）。
- 导出：HTML（各浏览器可导入）、XBEL（Floccus 格式）、JSON（含备注、标签、访问次数）。也可导出任一历史修订的快照。

## 12. 网页

### 12.1 技术

- Svelte 5 + Vite + TypeScript，不引入大型 UI 库。路由用 History API（服务端对非保留路径返回 `index.html`）。
- API 类型用 `openapi-typescript` 从 `api/openapi.yaml` 生成，请求用 `openapi-fetch`。
- 构建产物输出到 `web/dist/`，体积目标：首屏 JS gzip < 150 KB。
- i18n：`zh-CN`（默认）和 `en`，字典文件，跟随设置或浏览器语言。
- 主题：浅色 / 深色 / 跟随系统，CSS 变量。
- 响应式：≥ 900px 双栏（左侧文件夹树 + 右侧列表），窄屏单栏 + 底部导航。

### 12.2 页面

| 路径 | 内容 |
|---|---|
| `/setup` | 首次设置管理员（仅无用户时） |
| `/login` | 登录 |
| `/` | 书签页（起始页）：顶部搜索框（自动聚焦，回车搜索，直接输入网址则打开），下方按设置展示若干文件夹分组（网格卡片：图标 + 标题），可选“最近添加”“常用”。适合设为浏览器主页。 |
| `/lib/:slug`、`/lib/:slug/f/:folderId` | 管理器：文件夹树（展开折叠、拖放）、条目列表（图标、标题、域名、标签、失效标记），拖放排序和移动（鼠标与触屏都支持；窄屏另有“移动到…”对话框），多选批量移动/删除/打标签，行内编辑，新建书签（粘贴 URL 自动取标题）/文件夹，右键菜单。顶部显示库同步状态（最后同步设备和时间、被锁提示与强制解锁）。 |
| `/search?q=` | 搜索结果，支持第 9 节语法，结果显示路径、高亮。 |
| `/share`、`/add` | 快速收藏：参数 `url`、`title`、`text`（PWA 分享时 URL 可能在 `text` 里，需提取）。显示已收藏提示、选择库和文件夹（最近使用置顶、可搜索）、标题、标签、备注；AI 开启时显示推荐。离线时存入本地队列。 |
| `/history/:slug` | 修订时间线：时间、来源、设备、增删改移数量；点开看差异；下载快照；回滚到此。 |
| `/deleted/:slug` | 最近删除，勾选恢复。 |
| `/pending/:slug/:id` | 被拦截的上传：差异、允许、丢弃。全局顶部横幅提示有待确认项。 |
| `/reports/broken` | 失效链接：筛选状态，批量删除、改为跳转后的地址、重新检测。 |
| `/reports/duplicates` | 重复书签分组，选择保留哪个，其余删除。 |
| `/settings/account` | 修改密码、语言、主题、在新标签页打开、默认收藏位置。 |
| `/settings/devices` | 设备令牌列表（名称、scope、最后使用）、吊销；“添加 Floccus 设备”向导：选库 → 生成令牌 → 显示服务器地址/用户名/密码/文件名（一键复制），可下载 Floccus 配置文件（若服务端返回）；“添加插件/脚本令牌”。 |
| `/settings/libraries` | 库列表、新建、改名（提示需同步改 Floccus 文件名）、删除（二次确认，输入 slug）。 |
| `/settings/startpage` | 配置起始页分组（选库和文件夹、排序、布局）。 |
| `/settings/import-export` | 导入（选库、模式、文件）、导出（库、格式）。 |
| `/settings/integrations` | 插件下载（`/downloads/` 下的 zip 和安装说明）、书签小工具（bookmarklet，指向 `/add?url=...&title=...`）、AI 状态、任务状态与手动触发。 |
| `/settings/users` | 管理员：用户增删、重置密码。 |
| `/settings/about` | 版本、数据统计。 |

### 12.3 交互细节

- 键盘：`/` 聚焦搜索，`j`/`k` 上下，`Enter` 打开，`e` 编辑，`Delete` 删除（可撤销），`n` 新建，`Esc` 关闭。
- 删除后 8 秒内可撤销（撤销调用恢复接口或批量反向操作）。
- 点击书签用真实链接，同时 `navigator.sendBeacon` 调 `POST /api/v1/visits` 计数。
- API 返回 423 时提示“正在与 某设备 同步”，自动重试 3 次。
- 树数据带 ETag 缓存；窗口重新获得焦点时刷新。

### 12.4 PWA 与离线

- `manifest.webmanifest`：名称、图标（含 maskable）、`display: standalone`、`start_url: /`、`share_target`：`{"action":"/share","method":"GET","params":{"url":"url","title":"title","text":"text"}}`。
- Service Worker：缓存应用外壳；每次加载把各库树和设置存 IndexedDB；离线时只读浏览和搜索（前端本地搜索），顶部显示离线横幅。
- 离线收藏队列：快速收藏失败（网络错误）时存 IndexedDB，恢复联网或下次打开时按序提交，提交结果通知。

## 13. 浏览器插件

- Manifest V3，TypeScript + esbuild（或 Vite），无 UI 框架；产物 `extension/dist/chrome/`（Chrome/Edge/Brave）和 `extension/dist/firefox/`（`background.scripts`、`browser_specific_settings.gecko.id`），并打包 zip。
- 不申请 `bookmarks` 权限，不读写浏览器原生书签。
- 权限：`storage`、`contextMenus`、`activeTab`、`tabs`（读当前页 URL/标题）、`alarms`；`optional_host_permissions: ["http://*/*","https://*/*"]`，在设置服务器地址时只申请该源。
- 功能：
  - 设置页：服务器地址；可选的 Cloudflare Access 服务令牌（Client ID / Secret，见 7.1）；用户名 + 密码登录（调 `POST /api/v1/auth/token` 生成 `api` 令牌，名字形如“插件 · Chrome · Linux”）或直接粘贴令牌；测试连接；默认收藏位置；是否接管新标签页内容。
  - 弹窗：当前页是否已收藏（显示位置），收藏到库/文件夹（最近使用置顶、可搜索），编辑标题/标签/备注，删除；AI 开启时显示推荐。
  - 图标角标：当前页已收藏显示 ✓（`lookup` 结果按 URL 缓存 5 分钟）。
  - 右键菜单：“收藏此页”“收藏此链接”。
  - 快捷键：`Alt+Shift+S` 直接收藏到默认位置并提示。
  - 地址栏：关键词 `sm` + 空格搜索书签，候选列表回车打开。
  - 新标签页：显示书签页（用 API 数据自己渲染，带本地缓存，离线可用）；设置里关闭时显示只有搜索框的简洁页。
- API 类型同样从 `api/openapi.yaml` 生成。
- 服务端把插件 zip 放在 `/downloads/`，网页设置里可下载。

## 14. 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SHELFMARK_LISTEN` | `:8080` | 监听地址 |
| `SHELFMARK_DATA_DIR` | `./data`（容器内 `/data`） | 数据库、备份目录 |
| `SHELFMARK_BASE_URL` | 空 | 对外地址，用于生成 Floccus 配置、Cookie Secure 判断、Origin 校验 |
| `SHELFMARK_TRUSTED_PROXIES` | 空 | 可信反代 CIDR，逗号分隔 |
| `SHELFMARK_ALLOWED_ORIGINS` | 空 | 允许的网页来源，逗号分隔（内网域名、公网域名都列上） |
| `SHELFMARK_CF_ACCESS_TEAM_DOMAIN` | 空 | Access 团队域，如 `example.cloudflareaccess.com`；为空则不启用 7.1 的 Access 相关逻辑 |
| `SHELFMARK_CF_ACCESS_AUD` | 空 | Access 应用的 AUD 标签，逗号分隔可多个 |
| `SHELFMARK_CF_ACCESS_USERS` | 空 | 单点登录映射 `用户名=邮箱`，逗号分隔 |
| `SHELFMARK_ADMIN_USER` / `SHELFMARK_ADMIN_PASSWORD` | 空 | 首次启动建管理员 |
| `SHELFMARK_DAV_AUTO_CREATE` | `true` | Floccus 上传到不存在的库文件时自动建库 |
| `SHELFMARK_GUARD_RATIO` / `SHELFMARK_GUARD_MIN_ITEMS` | `0.5` / `20` | 防误删阈值，比例 0 关闭 |
| `SHELFMARK_REVISION_KEEP_DAYS` / `SHELFMARK_REVISION_KEEP_DAILY_DAYS` | `30` / `365` | 修订保留 |
| `SHELFMARK_BACKUP_KEEP` | `14` | 自动备份份数，0 关闭 |
| `SHELFMARK_LINKCHECK_INTERVAL` | `168h` | 失效检测周期，0 关闭 |
| `SHELFMARK_FETCH_METADATA` | `true` | 抓图标和标题 |
| `SHELFMARK_FETCH_ALLOW_PRIVATE` | `true` | 是否允许抓内网地址 |
| `SHELFMARK_FETCH_USER_AGENT` | `shelfmark/<版本>` | 抓取用的 UA |
| `SHELFMARK_AI_BASE_URL` / `SHELFMARK_AI_API_KEY` / `SHELFMARK_AI_MODEL` | 空 | AI 建议 |
| `SHELFMARK_METRICS` | `false` | 开启 `/metrics` |
| `SHELFMARK_METRICS_TOKEN` | 空 | 设了则 `/metrics` 需要 Bearer |
| `SHELFMARK_LOG_LEVEL` / `SHELFMARK_LOG_FORMAT` | `info` / `text` | 日志 |

也支持 `--config <file>`（YAML，键名为变量名去前缀转小写，如 `listen`、`data_dir`），环境变量优先。

## 15. 命令行

```
shelfmark serve                         # 默认子命令
shelfmark user add <name> [--admin] [--password-stdin]
shelfmark user passwd <name> [--password-stdin]
shelfmark user list | delete <name>
shelfmark token create <user> --name <n> --scopes api,dav    # 打印一次明文
shelfmark library list <user>
shelfmark import <user> <slug> <file> [--mode folder|merge|replace]
shelfmark export <user> <slug> [--format html|xbel|json] [-o file]
shelfmark backup [-o file]              # VACUUM INTO
shelfmark version
```

## 16. 部署

- 根目录 `Dockerfile` 多阶段：Node 构建 `web` 和 `extension` → 复制 `web/dist` 到 `server/internal/webui/dist`、插件 zip 到 `server/internal/webui/dist/downloads/` → `CGO_ENABLED=0 go build` → 运行镜像用 `gcr.io/distroless/static`（或 alpine），非 root，`/data` 卷，`HEALTHCHECK` 调 `shelfmark healthcheck`（请求本机 `/healthz`）。
- 多架构 `linux/amd64`、`linux/arm64`。
- `deploy/compose.example.yml`：一个服务、一个卷、端口只绑 `127.0.0.1`，环境变量示例用占位值。
- 运维端点：`/healthz`（无认证，返回 `ok` 和版本）、`/metrics`（Prometheus：各库书签数、DAV 请求数按方法/状态、上传应用次数按结果、拦截次数、修订数、HTTP 时延直方图、任务耗时与结果）。
- 反代说明写进 README：前面套 Cloudflare Access 时按 7.1 配 bypass 路径和服务令牌；其它统一登录网关同理，`/dav/` 必须放行，插件要能带上网关认可的凭据。

## 17. 测试

- 服务端：`go test ./...`，覆盖 XBEL 往返（含 Floccus 生成的样例）、DAV 全流程（按 4.1 的请求序列回放：锁、GET+PROPFIND 长度一致、PUT temp → MOVE → PROPFIND、原生 PUT + HEAD、423、412 拦截、403 删除库文件）、上传差异与元数据迁移、修订合并与清理、恢复、认证与 CSRF、限流、导入导出、搜索语法、任务（用 `httptest` 假站点，不访问外网）、AI（假服务）。
- 网页：Vitest 单元测试 + Playwright（针对 MSW 内存假后端）；集成阶段再对真服务端跑。
- 插件：Vitest 单元测试 + Playwright 加载未打包插件的冒烟测试。
- 端到端（`e2e/`）：启动真实二进制和临时数据目录；Playwright 覆盖网页主要流程；加载从源码构建的 Floccus 插件做真实同步：浏览器 → 服务端、网页修改 → 浏览器、浏览器大批量删除 → 412 拦截 → 网页允许。

## 18. 仓库结构

```
shelfmark/
  AGENTS.md  README.md  Makefile  Dockerfile  .github/workflows/ci.yml
  docs/design.md
  api/openapi.yaml
  server/                      # Go 模块 shelfmark
    go.mod
    cmd/shelfmark/main.go
    internal/
      config/ store/ xbel/ dav/ auth/ api/ search/ meta/ linkcheck/ jobs/ ai/
      importexport/ urlnorm/ metrics/ webui/ (go:embed dist，仓库里放占位 index.html)
  web/                         # Svelte 应用，产物 web/dist
  extension/                   # 插件，产物 extension/dist/{chrome,firefox} 和 zip
  e2e/                         # Playwright 端到端
  deploy/compose.example.yml
```

## 19. 分工边界（并行开发约定）

- 第一阶段并行三块，各在自己的 worktree 和分支，只改自己的目录：
  - 服务端：`server/`（可对 `api/openapi.yaml` 做向后兼容的补充，必须在汇报里列出每处改动）。
  - 网页：`web/`。
  - 插件：`extension/`。
- 网页和插件第一阶段对着契约和自建的内存假后端开发，不依赖服务端进度；发现契约不够用，写进汇报，不改契约。
- 第二阶段集成：合并三条分支，按最终契约重新生成类型并修正，接通 `go:embed`，写根目录构建、Docker、CI、README、端到端测试，跑完整验证。
