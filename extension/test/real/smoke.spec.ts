// Smoke run against the real shelfmark binary (started by playwright.real.config.ts).
// Covers: token login → popup save → badge → move to another library (transfer) → new tab → delete.
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupResult } from '../../src/lib/types';
import { badgeText, launch, msg, tabIdOf } from '../helpers/browser';

const base = process.env.SHELFMARK_E2E_URL!;

/** A page to bookmark, on its own port. */
async function pageServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Hello Shelfmark</title><h1>hi</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`, server };
}

async function apiSession(): Promise<APIRequestContext> {
  // 内网直连：不需要登录，直接就是默认用户。
  return request.newContext({ baseURL: base, extraHTTPHeaders: { 'X-Requested-With': 'shelfmark' } });
}

async function json<T>(r: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await r;
  expect(res.ok(), `${res.url()}: ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

test('real server: token login → save → transfer to another library → new tab → delete', async () => {
  const api = await apiSession();
  const info = await json<{ version: string }>(api.get('/api/v1/system/info'));
  const created = await json<{ token: string }>(api.post('/api/v1/tokens', { data: { name: '插件 · Chrome · Linux', scopes: ['api'] } }));
  const libs = await json<{ slug: string; name: string }[]>(api.get('/api/v1/libraries'));
  const mainName = libs.find((l) => l.slug === 'bookmarks')!.name;
  await json(api.post('/api/v1/libraries/bookmarks/items', { data: { type: 'folder', title: '阅读' } }));
  await json(api.post('/api/v1/libraries', { data: { slug: 'work', name: '工作' } }));
  await json(api.post('/api/v1/libraries/work/items', { data: { type: 'folder', title: '项目' } }));
  const lookup = (url: string) => json<LookupResult>(api.get('/api/v1/lookup', { params: { url } }));

  const target = await pageServer();
  const ext = await launch();
  const { context, sw } = ext;
  const extBase = ext.base;
  try {
    await test.step('options: paste the API token', async () => {
      const page = await context.newPage();
      await page.goto(`${extBase}/options.html`);
      await page.fill('#server-url', base);
      await page.fill('#token', created.token);
      await page.click('#token-btn');
      await expect(page.locator('#conn-status')).toContainText(`（shelfmark ${info.version}）`);
      const tokens = await json<{ name: string; scopes: string[] }[]>(api.get('/api/v1/tokens'));
      expect(tokens).toContainEqual(expect.objectContaining({ name: '插件 · Chrome · Linux', scopes: ['api'] }));
      await page.close();
    });

    const tab = await context.newPage();
    await tab.goto(target.url);
    const tabId = await tabIdOf(sw, target.url);

    await test.step('popup: save into a folder with tags and notes', async () => {
      const popup = await context.newPage();
      await popup.goto(`${extBase}/popup.html?tab=${tabId}`);
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'unsaved');
      await expect(popup.locator('#f-title')).toHaveValue('Hello Shelfmark');
      await popup.click('#picker-button');
      await popup.fill('.picker-search', '阅读');
      await popup.keyboard.press('Enter');
      await expect(popup.locator('#picker-button')).toContainText('阅读');
      await popup.fill('#f-tags', 'demo, e2e');
      await popup.fill('#f-notes', 'saved from e2e');
      await popup.click('#save-btn');
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'saved');
      await expect(popup.locator('#locations')).toHaveText(`${mainName} / 阅读`);
      const { matches } = await lookup(target.url);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ library: 'bookmarks', path: ['阅读'], item: { title: 'Hello Shelfmark', tags: ['demo', 'e2e'], notes: 'saved from e2e' } });
      await popup.close();
    });

    await test.step('badge shows ✓', async () => {
      await expect.poll(() => badgeText(sw, tabId)).toBe('✓');
    });

    await test.step('popup: edit and move to another library (transfer)', async () => {
      const popup = await context.newPage();
      await popup.goto(`${extBase}/popup.html?tab=${tabId}`);
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'saved');
      await popup.click('#picker-button');
      await popup.fill('.picker-search', '项目');
      await popup.keyboard.press('Enter');
      await expect(popup.locator('#picker-button')).toContainText('项目');
      await popup.fill('#f-title', 'Hello Moved');
      await popup.click('#save-btn');
      await expect(popup.locator('#message')).toHaveText(msg('popupUpdated'));
      await expect(popup.locator('#locations')).toHaveText('工作 / 项目');
      const { matches } = await lookup(target.url);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ library: 'work', path: ['项目'], item: { title: 'Hello Moved', tags: ['demo', 'e2e'], notes: 'saved from e2e' } });
      await popup.close();
    });

    await test.step('new tab lists it under recent (cross-library endpoint)', async () => {
      const nt = await context.newPage();
      await nt.goto(`${extBase}/newtab.html`);
      await expect(nt.locator('.group[data-id="recent"] .tile', { hasText: 'Hello Moved' })).toBeVisible();
      await nt.close();
    });

    await test.step('popup: delete clears the badge', async () => {
      const popup = await context.newPage();
      await popup.goto(`${extBase}/popup.html?tab=${tabId}`);
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'saved');
      await popup.click('#delete-btn');
      await popup.click('#delete-btn');
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'unsaved');
      expect((await lookup(target.url)).matches).toEqual([]);
      await expect.poll(() => badgeText(sw, tabId)).toBe('');
      await popup.close();
    });
  } finally {
    await ext.close();
    target.server.close();
    await api.dispose();
  }
});
