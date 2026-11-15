import { expect, test } from '@playwright/test';
import { FAKE_VERSION, startFakeServer } from '../fake-server/server.mjs';
import { badgeText, launch, msg, tabIdOf } from '../helpers/browser';

test('settings login → popup save → badge → new tab (online and offline)', async () => {
  const server = await startFakeServer();
  const ext = await launch();
  const { context, sw, base } = ext;
  try {
    expect(await sw.evaluate(() => chrome.i18n.getUILanguage())).toMatch(/^zh/);

    await test.step('options: paste an API token', async () => {
      const page = await context.newPage();
      await page.goto(`${base}/options.html`);
      await expect(page.locator('h1')).toContainText(msg('optionsTitle'));
      await page.fill('#server-url', server.url);
      await page.fill('#token', server.issueToken());
      await page.click('#token-btn');
      await expect(page.locator('#conn-status')).toHaveText(`已连接：alice（shelfmark ${FAKE_VERSION}）。`);
      await expect(page.locator('#token')).toHaveValue('');

      const tools = server.folderId('bookmarks', '工具');
      await expect(page.locator('#default-save')).toBeEnabled();
      await page.selectOption('#default-save', `bookmarks:${tools}`);
      await expect(page.locator('#default-save-msg')).toHaveText(msg('saved'));
      expect(server.alice.settings.defaultSave).toEqual({ library: 'bookmarks', folderId: tools });

      await page.click('#test-btn');
      await expect(page.locator('#conn-status')).toContainText(FAKE_VERSION);
      await expect(page.locator('#newtab-toggle')).toBeChecked();
      await page.close();
    });

    const pageUrl = `${server.url}/__test/page?title=Hello%20Shelfmark`;
    const target = await context.newPage();
    await target.goto(pageUrl);
    const tabId = await tabIdOf(sw, pageUrl);
    await expect.poll(() => server.state.requests.some((r) => r.path === '/api/v1/lookup')).toBe(true);
    expect(await badgeText(sw, tabId)).toBe('');

    await test.step('popup: save to a searched folder with tags and notes, then edit', async () => {
      const popup = await context.newPage();
      await popup.goto(`${base}/popup.html?tab=${tabId}`);
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'unsaved');
      await expect(popup.locator('#status')).toHaveText(msg('popupNotSaved'));
      await expect(popup.locator('#f-title')).toHaveValue('Hello Shelfmark');
      await expect(popup.locator('#picker-button')).toContainText('工具'); // the default just configured

      await popup.click('#picker-button');
      await expect(popup.locator('.picker-group')).toHaveCount(0); // nothing saved yet, so no recent folders
      await popup.fill('.picker-search', '阅读');
      await popup.keyboard.press('Enter');
      await expect(popup.locator('#picker-button')).toContainText('阅读');
      await popup.fill('#f-tags', 'demo, e2e');
      await popup.fill('#f-notes', 'saved from e2e');
      await popup.click('#save-btn');
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'saved');
      await expect(popup.locator('#locations')).toHaveText('书签 / 阅读');
      expect(server.findBookmark(pageUrl)).toMatchObject({
        library: 'bookmarks',
        path: ['阅读'],
        item: { title: 'Hello Shelfmark', tags: ['demo', 'e2e'], notes: 'saved from e2e' },
      });

      await popup.click('#ai-btn');
      await expect(popup.locator('#ai-result .chip', { hasText: '#ai' })).toBeVisible();
      await popup.locator('#ai-result .chip', { hasText: '#ai' }).click();
      await expect(popup.locator('#f-tags')).toHaveValue('demo, e2e, ai');

      await popup.fill('#f-title', 'Hello Edited');
      await popup.click('#save-btn');
      await expect(popup.locator('#message')).toHaveText(msg('popupUpdated'));
      expect(server.findBookmark(pageUrl)?.item).toMatchObject({ title: 'Hello Edited', tags: ['demo', 'e2e', 'ai'] });
      await popup.close();
    });

    await test.step('badge shows ✓ and survives a reload via the lookup cache', async () => {
      await expect.poll(() => badgeText(sw, tabId)).toBe('✓');
      const lookups = server.state.requests.filter((r) => r.path === '/api/v1/lookup').length;
      await target.reload();
      await expect.poll(() => badgeText(sw, tabId)).toBe('✓');
      expect(server.state.requests.filter((r) => r.path === '/api/v1/lookup').length).toBe(lookups);
    });

    const nt = await context.newPage();
    await test.step('new tab renders bookmarks from the API with favicons', async () => {
      await nt.goto(`${base}/newtab.html`);
      const tools = nt.locator('.group', { has: nt.locator('h2', { hasText: '工具' }) });
      await expect(tools.locator('.tile', { hasText: 'Example Tools' })).toBeVisible();
      await expect(tools.locator('.tile', { hasText: 'Example Tools' }).locator('img')).toHaveAttribute('src', /^blob:/);
      const icon = server.state.requests.find((r) => r.path.startsWith('/api/v1/favicons/'));
      expect(icon?.headers.authorization).toMatch(/^Bearer smk_/);

      await nt.fill('#q', 'hello');
      await expect(nt.locator('#results')).toContainText('Hello Edited');
      await expect(nt.locator('#content')).toBeHidden();
      await nt.fill('#q', '');
      await expect(nt.locator('#content')).toBeVisible();
    });

    await test.step('popup: delete clears the badge', async () => {
      const popup = await context.newPage();
      await popup.goto(`${base}/popup.html?tab=${tabId}`);
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'saved');
      // The folder used last is now listed first under "recently used".
      await popup.click('#picker-button');
      await expect(popup.locator('.picker-group').first()).toHaveText(msg('pickerRecent'));
      await expect(popup.locator('.picker-option').nth(1)).toHaveText('书签 / 阅读');
      await popup.keyboard.press('Escape');
      await popup.click('#delete-btn');
      await expect(popup.locator('#delete-btn')).toHaveText(msg('popupDeleteConfirm'));
      await popup.click('#delete-btn');
      await expect(popup.locator('#status')).toHaveAttribute('data-state', 'unsaved');
      expect(server.findBookmark(pageUrl)).toBeNull();
      await expect.poll(() => badgeText(sw, tabId)).toBe('');
      await popup.close();
    });

    await test.step('new tab keeps working offline from the local cache', async () => {
      const tile = nt.locator('.group', { has: nt.locator('h2', { hasText: '工具' }) }).locator('.tile', { hasText: 'Example Tools' });
      await nt.reload();
      await expect(tile).toBeVisible();
      await expect(nt.locator('.tile', { hasText: 'Hello Edited' })).toHaveCount(0);
      await server.close();
      await nt.reload();
      await expect(nt.locator('#banner')).toBeVisible();
      await expect(nt.locator('#banner')).toContainText('离线');
      await expect(tile).toBeVisible();
      await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/); // from Cache Storage
      await nt.fill('#q', 'blog');
      await expect(nt.locator('#results')).toContainText('Example Blog');
    });
  } finally {
    await ext.close();
    await server.close();
  }
});

test('Cloudflare Access: clear hint without a service token, works with one', async () => {
  const server = await startFakeServer({ access: { clientId: 'cid.access', clientSecret: 'access-secret', mode: 'redirect' } });
  const ext = await launch();
  try {
    const page = await ext.context.newPage();
    await page.goto(`${ext.base}/options.html`);
    await page.fill('#server-url', server.url);
    await page.fill('#token', server.issueToken());
    await page.click('#token-btn');
    await expect(page.locator('#conn-status')).toHaveText(msg('errAccessBlocked'));

    await page.locator('#access-box summary').click();
    await page.fill('#access-id', 'cid.access');
    await page.fill('#access-secret', 'access-secret');
    await page.click('#token-btn');
    await expect(page.locator('#conn-status')).toContainText('alice');
    const meCall = server.state.requests.filter((r) => r.path === '/api/v1/auth/me').at(-1);
    expect(meCall?.headers['cf-access-client-id']).toBe('cid.access');

    // New tab: favicons are fetched with the Access headers and shown as blob: URLs.
    const nt = await ext.context.newPage();
    await nt.goto(`${ext.base}/newtab.html`);
    await expect(nt.locator('.tile', { hasText: 'Example Tools' }).first().locator('img')).toHaveAttribute('src', /^blob:/);

    // Service token revoked in Access → the popup tells the user what to fix.
    server.setAccess({ clientId: 'cid.access', clientSecret: 'rotated', mode: 'redirect' });
    const target = await ext.context.newPage();
    const url = `${server.url}/__test/page?title=Blocked`;
    await target.goto(url);
    const popup = await ext.context.newPage();
    await popup.goto(`${ext.base}/popup.html?tab=${await tabIdOf(ext.sw, url)}`);
    await expect(popup.locator('#message')).toContainText(msg('errAccessRejected'));
    await expect(popup.locator('#status')).toHaveAttribute('data-state', 'error');
  } finally {
    await ext.close();
    await server.close();
  }
});
