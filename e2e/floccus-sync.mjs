// 真实 Floccus ↔ shelfmark 端到端同步，用法见 README.md。
// 参数：<全新实例的地址> <解压后的 Floccus Chrome 版目录>
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 借用 extension/ 装好的 Playwright
const { chromium, request } = createRequire(new URL('../extension/package.json', import.meta.url))('@playwright/test');

const [BASE, FLOCCUS] = process.argv.slice(2);
if (!BASE || !FLOCCUS) throw new Error('usage: node e2e/floccus-sync.mjs <base url> <floccus dir>');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const H = { 'X-Requested-With': 'shelfmark' };
const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: H });
const ok = async (r) => { const res = await r; if (!res.ok()) throw new Error(`${res.url()} ${res.status()} ${await res.text()}`); return res.status() === 204 ? null : res.json(); };

// 1. server-side seed（内网直连，身份是首次启动自动建的 admin）
const add = (data) => ok(api.post('/api/v1/libraries/bookmarks/items', { data }));
const sf = await add({ type: 'folder', title: '服务器文件夹' });
await add({ type: 'bookmark', title: 'Server A', url: 'https://a.example.com/', parentId: sf.item.id });
await add({ type: 'bookmark', title: 'Server B', url: 'https://b.example.com/' });
const setup = await ok(api.post('/api/v1/floccus/setup', { data: { library: 'bookmarks', deviceName: 'Floccus e2e' } }));
log('floccus profile:', JSON.stringify({ ...setup.profile[0], password: '***' }));

// 2. browser with Floccus
const tmp = await mkdtemp(join(tmpdir(), 'floccus-e2e-'));
const ext = join(tmp, 'ext');
await cp(FLOCCUS, ext, { recursive: true });
const ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const errors = [];
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  log('floccus sw', sw.url());

  // local folder with its own bookmarks
  const localRoot = await sw.evaluate(async () => {
    const root = await chrome.bookmarks.create({ parentId: '1', title: 'shelfmark' });
    await chrome.bookmarks.create({ parentId: root.id, title: 'Local C', url: 'https://c.example.org/' });
    const f = await chrome.bookmarks.create({ parentId: root.id, title: '本地文件夹' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Local D', url: 'https://d.example.org/x' });
    return root.id;
  });
  const accId = 'e2e' + Date.now();
  await sw.evaluate(async ({ accId, data }) => {
    await chrome.storage.local.set({ accounts: JSON.stringify({ [accId]: data }) });
  }, { accId, data: { ...setup.profile[0], localRoot, enabled: false } });

  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extId}/dist/html/options.html`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });

  const account = () => sw.evaluate(async (accId) => JSON.parse((await chrome.storage.local.get('accounts')).accounts)[accId], accId);
  // syncAccount returns at once if Floccus is busy with its own background check: retry until lastSync moves.
  const sync = async (label) => {
    const t0 = Date.now();
    const prev = (await account()).lastSync ?? 0;
    for (let attempt = 1; attempt <= 20; attempt++) {
      await page.evaluate((accId) => new Promise((res) => {
        const l = (e) => { if (e.data?.type === 'syncAccountResponse') { navigator.serviceWorker.removeEventListener('message', l); res(); } };
        navigator.serviceWorker.addEventListener('message', l);
        navigator.serviceWorker.controller.postMessage({ type: 'syncAccount', params: [accId] });
      }), accId);
      const acc = await account();
      if (acc.error) { log(`${label}: attempt ${attempt}, ${Date.now() - t0}ms error=${acc.error}`); throw new Error(`${label} failed: ${acc.error}`); }
      if ((acc.lastSync ?? 0) > prev) { log(`${label}: ok after ${attempt} attempt(s), ${Date.now() - t0}ms`); return; }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label}: lastSync never moved`);
  };
  const norm = (nodes) => nodes.map((n) => (n.url ? { t: n.title, u: n.url } : { t: n.title, c: norm(n.children ?? []) }));
  const browserTree = async () => norm((await sw.evaluate((id) => chrome.bookmarks.getSubTree(id), localRoot))[0].children);
  const serverTree = async () => norm((await ok(api.get('/api/v1/libraries/bookmarks/tree'))).children);
  const sortDeep = (nodes) => nodes.map((n) => (n.c ? { ...n, c: sortDeep(n.c) } : n)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const compare = async (label, { order = true } = {}) => {
    const [b, s] = [await browserTree(), await serverTree()];
    const content = JSON.stringify(sortDeep(b)) === JSON.stringify(sortDeep(s));
    const ordered = JSON.stringify(b) === JSON.stringify(s);
    log(`${label}: content ${content ? 'MATCH' : 'MISMATCH'}, order ${ordered ? 'MATCH' : 'DIFFERS'}`);
    if (!content || (order && !ordered)) { log('browser', JSON.stringify(b)); log('server ', JSON.stringify(s)); }
    if (!content || (order && !ordered)) throw new Error(`${label} mismatch`);
    log('  tree', JSON.stringify(s));
  };

  // 3. first sync: merge both sides
  await sync('sync#1 (merge)');
  await compare('after sync#1', { order: false });
  await sync('sync#1b (no changes)');
  await compare('after sync#1b', { order: false });

  // 4. web edit → browser
  const tree = await ok(api.get('/api/v1/libraries/bookmarks/tree'));
  const b = tree.children.find((n) => n.title === 'Server B');
  await ok(api.patch(`/api/v1/libraries/bookmarks/items/${b.id}`, { data: { title: 'Server B 改名' } }));
  await add({ type: 'bookmark', title: 'Web E', url: 'https://e.example.net/' });
  await sync('sync#2 (server→browser)');
  await compare('after sync#2');

  // 5. browser edit → server
  await sw.evaluate(async (id) => {
    const [root] = await chrome.bookmarks.getSubTree(id);
    const c = root.children.find((n) => n.title === 'Local C');
    await chrome.bookmarks.update(c.id, { title: 'Local C 改名' });
    await chrome.bookmarks.create({ parentId: id, title: 'Browser F', url: 'https://f.example.org/' });
  }, localRoot);
  await sync('sync#3 (browser→server)');
  await compare('after sync#3');

  // 6. mass delete in browser → 412 guard → approve on web → next sync clean
  await sw.evaluate(async (id) => {
    const [root] = await chrome.bookmarks.getSubTree(id);
    for (const n of root.children.slice(0, -1)) await chrome.bookmarks.removeTree(n.id);
  }, localRoot);
  // Floccus' own failsafe (E029) would refuse first; switch it off to reach shelfmark's guard
  await sw.evaluate(async (accId) => {
    const all = JSON.parse((await chrome.storage.local.get('accounts')).accounts);
    all[accId].failsafe = false;
    await chrome.storage.local.set({ accounts: JSON.stringify(all) });
  }, accId);
  const before = JSON.stringify(await serverTree());
  let blocked = false;
  try { await sync('sync#4 (mass delete)'); } catch (e) { blocked = /412/.test(e.message); log('sync#4:', e.message.slice(0, 120)); }
  if (!blocked) throw new Error('sync#4 should be blocked with 412');
  if (JSON.stringify(await serverTree()) !== before) throw new Error('server changed while upload pending');
  const [p] = await ok(api.get('/api/v1/pending'));
  log('pending:', JSON.stringify(p));
  await ok(api.post(`/api/v1/libraries/${p.library}/pending/${p.id}/approve`));
  await compare('after approve', { order: true });
  await sync('sync#5 (after approve)');
  await compare('after sync#5');
  const revs = await ok(api.get('/api/v1/libraries/bookmarks/revisions'));
  log('server revisions:', revs.items.map((r) => `${r.rev}:${r.source}`).join(' '));
  log('PASS');
} finally {
  if (errors.length) log('page console errors:', errors.slice(0, 5));
  await ctx.close();
  await rm(tmp, { recursive: true, force: true });
  await api.dispose();
}
