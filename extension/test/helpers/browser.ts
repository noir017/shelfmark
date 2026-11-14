// Shared by the Playwright specs: load the unpacked Chrome build into Chromium.
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const dist = join(root, 'dist', 'chrome');
const zh = JSON.parse(readFileSync(join(root, 'static/_locales/zh_CN/messages.json'), 'utf8')) as Record<string, { message: string }>;
export const msg = (key: string) => zh[key]!.message;

export interface Launched {
  context: BrowserContext;
  sw: Worker;
  base: string;
  close(): Promise<void>;
}

/**
 * Load dist/chrome unpacked. Headless Chromium cannot answer the optional host permission
 * prompt, so the test copy of the manifest pre-grants 127.0.0.1; the code path is the same
 * (permissions.request resolves true at once when access is already granted).
 */
export async function launch(): Promise<Launched> {
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/chrome missing: run "npm run build" first');
  const tmp = await mkdtemp(join(tmpdir(), 'shelfmark-e2e-'));
  const extDir = join(tmp, 'ext');
  await cp(dist, extDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--lang=zh-CN'],
    // Chromium on Linux takes its UI language (chrome.i18n) from the environment.
    env: { ...process.env, LANGUAGE: 'zh_CN', LANG: 'zh_CN.UTF-8' },
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return {
    context,
    sw,
    base: `chrome-extension://${new URL(sw.url()).host}`,
    async close() {
      await context.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

export const badgeText = (sw: Worker, tabId: number) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);

export async function tabIdOf(sw: Worker, url: string): Promise<number> {
  const id = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  if (id === undefined) throw new Error(`no tab for ${url}`);
  return id;
}

