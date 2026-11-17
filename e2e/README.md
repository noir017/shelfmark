# 端到端

## 网页、插件对真实二进制

先在仓库根目录 `make all`，然后：

```sh
cd web && npm run test:real         # 登录 + 建改删、拖放
cd extension && npm run test:real   # 插件冒烟：登录、收藏、角标、跨库移动、新标签页、删除
```

都会用临时数据目录自己起 `server/bin/shelfmark`，端口用 `E2E_REAL_PORT` 指定。

网页的 `test:e2e`、`test:real` 在设了 `PW_CDP_URL`（可选 `PW_CDP_HEADERS`，形如 `X-Api-Key: xxx`）时连该 CDP 地址上的远程浏览器，没设就用本地浏览器，见 `web/tests/fixtures.ts`。远程浏览器得能访问本机的被测端口。

## 真实 Floccus 同步

用 Floccus 发布的 Chrome 版（`floccus-build-<版本>-chrome.zip`，GitHub Releases）在 Chromium 里跑：两边合并、网页改 → 浏览器、浏览器改 → 服务端、浏览器大批量删除 → 412 拦截 → 网页允许。

```sh
make all && (cd extension && npm ci)
mkdir -p /tmp/floccus && unzip -q floccus-build-<版本>-chrome.zip -d /tmp/floccus
d=$(mktemp -d)
SHELFMARK_LISTEN=127.0.0.1:8099 SHELFMARK_DATA_DIR=$d SHELFMARK_GUARD_MIN_ITEMS=3 \
  SHELFMARK_FETCH_METADATA=false SHELFMARK_LINKCHECK_INTERVAL=0 server/bin/shelfmark serve &
node e2e/floccus-sync.mjs http://127.0.0.1:8099 /tmp/floccus
```

要求全新实例（脚本会调首次设置）。账户配置取自 `POST /api/v1/floccus/setup` 返回的 profile，直接写进 Floccus 的 `storage.local`，同步通过向它的 Service Worker 发 `syncAccount` 触发。
