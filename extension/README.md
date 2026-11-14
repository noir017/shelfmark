# shelfmark 浏览器插件

Manifest V3，TypeScript + esbuild，无 UI 框架。Chrome / Edge / Brave 用 `dist/chrome`，Firefox（≥ 140）用 `dist/firefox`。

## 命令

```sh
npm ci
npm run build          # 类型检查 + 构建 dist/chrome、dist/firefox
npm test               # Vitest 单元测试 + Playwright 冒烟（需先 build）+ web-ext lint
npm run package        # dist/shelfmark-chrome.zip、dist/shelfmark-firefox.zip
npm run gen:api        # 从 ../api/openapi.yaml 重新生成 src/api/schema.d.ts（生成文件要提交）
npm run fake-server    # 本地假服务端，默认 http://127.0.0.1:8787，账号 alice / alice-password
```

手动试用：`npm run fake-server` 后在 `chrome://extensions` 加载 `dist/chrome`，设置页填 `http://127.0.0.1:8787`。
假服务端模拟 Cloudflare Access：`npm run fake-server -- --access-id ID --access-secret SECRET [--access-mode redirect|forbidden|html]`。

## 目录

- `src/api/`：生成的类型和 openapi-fetch 封装（Bearer、Access 服务令牌头、Access 拦截识别、错误映射）
- `src/background/`：角标、lookup 缓存、右键菜单、快捷键、地址栏 `sm`、定时预取
- `src/popup/`、`src/options/`、`src/newtab/`：三个页面
- `src/lib/`：存储、URL 缓存、离线快照、图标加载、i18n 等共用代码
- `static/`：HTML、CSS、图标、`_locales`（en、zh_CN）
- `scripts/`：构建、manifest、打包、图标生成
- `test/fake-server/`：按契约实现的内存假服务端；`test/unit/`、`test/e2e/`

## 约定

- 不申请 `bookmarks` 权限；服务器源走 `optional_host_permissions`，在设置页保存服务器时申请（不带端口的 `scheme://host/*`）。
- 所有请求 `redirect: 'manual'`、`credentials: 'omit'`。收到跳转、HTML，或 Cloudflare 返回的非 JSON 401/403，都按“被 Access 拦截”处理。
- 图标经 API 带认证头取回，转成 blob URL，存进 Cache Storage（ID 是内容哈希，离线也能用）。
- 冒烟测试把 dist/chrome 复制到临时目录，给 manifest 加上 `host_permissions: ["http://127.0.0.1/*"]`：headless Chromium 没法点权限弹窗，加上后 `permissions.request` 会直接返回 true。
