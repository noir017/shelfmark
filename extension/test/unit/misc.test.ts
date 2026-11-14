import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIREFOX_ID, buildManifest } from '../../scripts/manifest.mjs';
import { detectBrowser, detectOs, deviceName } from '../../src/lib/device';
import { FaviconLoader } from '../../src/lib/favicons';
import { isSavableUrl, looksLikeUrl, normalizeServerUrl, originPattern } from '../../src/lib/server-url';
import { addTag, formatTags, parseTags } from '../../src/lib/tags';

const root = join(import.meta.dirname, '..', '..');

describe('manifest', () => {
  const chrome = buildManifest('chrome', '1.2.3') as Record<string, any>;
  const firefox = buildManifest('firefox', '1.2.3') as Record<string, any>;

  it('uses a service worker on Chrome and background scripts on Firefox', () => {
    expect(chrome.background).toEqual({ service_worker: 'background.js' });
    expect(firefox.background).toEqual({ scripts: ['background.js'] });
    expect(firefox.browser_specific_settings.gecko.id).toBe(FIREFOX_ID);
    expect(FIREFOX_ID).toMatch(/@example\.com$/);
    expect(chrome.browser_specific_settings).toBeUndefined();
  });

  it('asks for the design 13 permissions only; server access is optional', () => {
    for (const m of [chrome, firefox]) {
      expect(m.manifest_version).toBe(3);
      expect(m.version).toBe('1.2.3');
      expect(m.permissions).toEqual(['storage', 'contextMenus', 'activeTab', 'tabs', 'alarms']);
      expect(m.permissions).not.toContain('bookmarks');
      expect(m.host_permissions).toBeUndefined();
      expect(m.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
      expect(m.omnibox).toEqual({ keyword: 'sm' });
      expect(m.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
    }
  });

  it('every __MSG_ key and icon exists', () => {
    const en = JSON.parse(readFileSync(join(root, 'static/_locales/en/messages.json'), 'utf8'));
    const keys = JSON.stringify(chrome).match(/__MSG_(\w+)__/g)!.map((m) => m.slice(6, -2));
    for (const k of keys) expect(en[k], k).toBeDefined();
    for (const icon of Object.values(chrome.icons) as string[]) expect(() => readFileSync(join(root, 'static', icon))).not.toThrow();
  });
});

describe('locales', () => {
  const load = (loc: string) => JSON.parse(readFileSync(join(root, `static/_locales/${loc}/messages.json`), 'utf8'));
  const en = load('en');
  const zh = load('zh_CN');

  it('English and Chinese have the same keys', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries<{ message: string }>(zh)) expect(v.message, k).not.toBe('');
  });

  it('every key used in code and HTML exists', () => {
    const used = new Set<string>();
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of walk(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'(\w+)'/g)) used.add(m[1]!);
    }
    for (const f of walk(join(root, 'static')).filter((f) => f.endsWith('.html'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(40);
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });
});

describe('server address', () => {
  it('normalizes what users type', () => {
    expect(normalizeServerUrl(' bm.example.com ')).toBe('https://bm.example.com');
    expect(normalizeServerUrl('http://192.168.1.5:8080/')).toBe('http://192.168.1.5:8080');
    expect(normalizeServerUrl('https://example.com/shelf///?x=1#y')).toBe('https://example.com/shelf');
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow();
    expect(() => normalizeServerUrl('')).toThrow();
  });

  it('requests a port-less host permission', () => {
    expect(originPattern('http://192.168.1.5:8080')).toBe('http://192.168.1.5/*');
    expect(originPattern('https://bm.example.com/sub')).toBe('https://bm.example.com/*');
  });

  it('knows what can be saved and what looks like an address', () => {
    expect(isSavableUrl('https://a/')).toBe(true);
    expect(isSavableUrl('chrome://newtab/')).toBe(false);
    expect(isSavableUrl(undefined)).toBe(false);
    expect(looksLikeUrl('example.com')).toBe(true);
    expect(looksLikeUrl('localhost:3000/x')).toBe(true);
    expect(looksLikeUrl('rust book')).toBe(false);
    expect(looksLikeUrl('hello')).toBe(false);
  });
});

describe('tags', () => {
  it('splits on spaces and commas (ASCII and CJK) and dedupes', () => {
    expect(parseTags('a, b，c、 #d  A')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseTags('')).toEqual([]);
    expect(formatTags(['x', 'y'])).toBe('x, y');
    expect(addTag('x, y', 'Y')).toBe('x, y');
    expect(addTag('x', 'z')).toBe('x, z');
  });
});

describe('device name', () => {
  const linuxChrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  it('names the browser and OS', () => {
    expect(deviceName('插件', { userAgent: linuxChrome })).toBe('插件 · Chrome · Linux');
    expect(detectBrowser({ userAgent: `${linuxChrome} Edg/141.0` })).toBe('Edge');
    expect(detectBrowser({ userAgent: linuxChrome, isBrave: true })).toBe('Brave');
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0' })).toBe('Firefox');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('macOS');
    expect(detectOs({ userAgent: linuxChrome, platform: 'Windows' })).toBe('Windows');
  });
});

describe('FaviconLoader', () => {
  class FakeCaches {
    store = new Map<string, Response>();
    async open() {
      return {
        match: async (k: string) => this.store.get(k)?.clone(),
        put: async (k: string, r: Response) => void this.store.set(k, r),
      } as unknown as Cache;
    }
  }

  function loader(favicon: (id: string) => Promise<Blob>, caches: FakeCaches | null, concurrency = 6) {
    let n = 0;
    return new FaviconLoader(
      { favicon: vi.fn(favicon), baseUrl: 'https://bm.example.com' },
      { caches: caches as unknown as CacheStorage, concurrency, createObjectURL: () => `blob:${++n}`, revokeObjectURL: vi.fn() },
    );
  }

  it('fetches through the API once per icon and hands out blob URLs', async () => {
    const caches = new FakeCaches();
    const fetchIcon = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    const l = loader(fetchIcon, caches);
    const [a, b] = await Promise.all([l.load('abc'), l.load('abc')]);
    expect(a).toBe('blob:1');
    expect(b).toBe('blob:1');
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    expect([...caches.store.keys()]).toEqual(['https://bm.example.com/api/v1/favicons/abc']);
  });

  it('serves from the cache when offline', async () => {
    const caches = new FakeCaches();
    await loader(async () => new Blob(['png'], { type: 'image/png' }), caches).load('abc');
    const offline = loader(async () => Promise.reject(new Error('offline')), caches);
    expect(await offline.load('abc')).toBe('blob:1');
    expect(await offline.load('missing')).toBeNull();
  });

  it('rejects non-image bodies (e.g. a login page) without caching them', async () => {
    const caches = new FakeCaches();
    const l = loader(async () => new Blob(['<html>'], { type: 'text/html' }), caches);
    expect(await l.load('abc')).toBeNull();
    expect(caches.store.size).toBe(0);
  });

  it('limits concurrent downloads', async () => {
    let running = 0;
    let peak = 0;
    const l = loader(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Blob(['x'], { type: 'image/png' });
    }, null, 2);
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => l.load(id)));
    expect(peak).toBe(2);
  });
});
