import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../../src/api/client';
import { COLORS, errorBadge, lookupBadge, type BadgeView } from '../../src/background/badge';
import { LookupService, summarize, type LookupSummary } from '../../src/background/lookup';
import { ERROR_MS, FLASH_MS, saveToDefault, type SaveDeps } from '../../src/background/save';
import { DEFAULT_CONFIG } from '../../src/lib/storage';
import { UrlCache } from '../../src/lib/url-cache';
import type { QuickSaveResult } from '../../src/lib/types';
import { tt } from '../helpers/memory-area';

const config = { ...DEFAULT_CONFIG, serverUrl: 'https://bm.example.com', token: 't' };

function saved(over: Partial<QuickSaveResult> = {}): QuickSaveResult {
  return {
    existed: false,
    library: 'bookmarks',
    path: ['收件箱'],
    revision: 3,
    item: {
      id: 42, type: 'bookmark', parentId: 9, position: 0, title: 'Page', url: 'https://page.example.com/',
      createdAt: '', updatedAt: '', tags: [], visitCount: 0,
    },
    ...over,
  };
}

function setup(quickSave: Api['quickSave'], opts: { configured?: boolean } = {}) {
  const badges: BadgeView[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const api = { quickSave } as unknown as Api;
  const lookups = new LookupService(new UrlCache<LookupSummary>({ ttlMs: 60_000 }), async () => api);
  const deps: SaveDeps = {
    services: async () => (opts.configured === false ? null : { api, config }),
    lookups,
    badge: async (_tabId, view) => void badges.push(view),
    refreshTab: vi.fn(async () => undefined),
    openOptions: vi.fn(async () => undefined),
    t: tt,
    later: (fn, ms) => void timers.push({ fn, ms }),
  };
  return { deps, badges, timers, lookups };
}

describe('saveToDefault (context menu / shortcut)', () => {
  it('saves to the default location and flashes ✓ with the location', async () => {
    const quickSave = vi.fn(async () => ({ result: saved(), created: true }));
    const { deps, badges, timers, lookups } = setup(quickSave);
    const r = await saveToDefault(deps, { url: 'https://page.example.com/', title: ' Page ', tabId: 5 });
    expect(r?.item.id).toBe(42);
    expect(quickSave).toHaveBeenCalledWith({ url: 'https://page.example.com/', title: 'Page' });
    expect(badges.map((b) => b.text)).toEqual(['…', '✓']);
    expect(badges[1]!.title).toBe('badgeSavedTo(Page|bookmarks / 收件箱)');
    expect((await lookups.get('https://page.example.com/'))?.matches[0]).toEqual({ library: 'bookmarks', itemId: 42, path: ['收件箱'] });
    expect(timers.map((t) => t.ms)).toEqual([FLASH_MS]);
    timers[0]!.fn();
    await vi.waitFor(() => expect(deps.refreshTab).toHaveBeenCalledWith(5));
  });

  it('omits an empty title so the server fetches one', async () => {
    const quickSave = vi.fn(async () => ({ result: saved({ existed: true }), created: false }));
    const { deps, badges } = setup(quickSave);
    await saveToDefault(deps, { url: 'https://page.example.com/', title: '  ', tabId: 5 });
    expect(quickSave).toHaveBeenCalledWith({ url: 'https://page.example.com/' });
    expect(badges[1]!.title).toMatch(/^badgeAlreadySaved/);
  });

  it('opens the settings when not connected', async () => {
    const quickSave = vi.fn();
    const { deps, badges } = setup(quickSave, { configured: false });
    expect(await saveToDefault(deps, { url: 'https://page.example.com/', tabId: 5 })).toBeNull();
    expect(deps.openOptions).toHaveBeenCalled();
    expect(quickSave).not.toHaveBeenCalled();
    expect(badges).toEqual([]);
  });

  it('refuses non-web pages with a ! badge', async () => {
    const quickSave = vi.fn();
    const { deps, badges, timers } = setup(quickSave);
    expect(await saveToDefault(deps, { url: 'chrome://settings/', tabId: 5 })).toBeNull();
    expect(quickSave).not.toHaveBeenCalled();
    expect(badges).toEqual([{ text: '!', color: COLORS.error, title: 'errUnsupportedUrl' }]);
    expect(timers[0]!.ms).toBe(ERROR_MS);
  });

  it('reports failures, including Cloudflare Access, on the badge', async () => {
    const blocked = new ApiError(0, 'access_blocked', 'blocked', { reason: 'redirect' });
    const { deps, badges, timers } = setup(vi.fn(async () => Promise.reject(blocked)));
    expect(await saveToDefault(deps, { url: 'https://page.example.com/', tabId: 5 })).toBeNull();
    expect(badges[1]).toEqual({ text: '!', color: COLORS.error, title: 'badgeSaveFailed\nerrAccessBlocked' });
    expect(timers[0]!.ms).toBe(ERROR_MS);
  });
});

describe('badge views', () => {
  it('shows ✓ only when there are matches', () => {
    expect(lookupBadge(null, tt).text).toBe('');
    expect(lookupBadge({ matches: [] }, tt).text).toBe('');
    const v = lookupBadge({ matches: [{ library: 'work', itemId: 1, path: ['项目'] }] }, tt);
    expect(v).toEqual({ text: '✓', color: COLORS.saved, title: 'badgeSaved\nwork / 项目' });
  });

  it('only flags errors the user has to fix', () => {
    expect(errorBadge(new ApiError(0, 'network', 'x'), tt, {}).text).toBe('');
    expect(errorBadge(new ApiError(401, 'unauthorized', 'x'), tt, {})).toMatchObject({ text: '!', title: 'errUnauthorized' });
    expect(errorBadge(new ApiError(0, 'access_blocked', 'x'), tt, { accessTokenSet: true }).title).toBe('errAccessRejected');
  });
});

describe('LookupService', () => {
  it('caches per URL and shares in-flight requests', async () => {
    const lookup = vi.fn(async (url: string) => ({ url, normalizedUrl: url, matches: [] }));
    const svc = new LookupService(new UrlCache<LookupSummary>({ ttlMs: 60_000 }), async () => ({ lookup }) as unknown as Api);
    const [a, b] = await Promise.all([svc.get('https://x.example.com/'), svc.get('https://x.example.com/')]);
    expect(a).toEqual({ matches: [] });
    expect(b).toEqual(a);
    await svc.get('https://x.example.com/#frag');
    expect(lookup).toHaveBeenCalledTimes(1);
    await svc.get('https://x.example.com/', { force: true });
    expect(lookup).toHaveBeenCalledTimes(2);
    await svc.invalidate('https://x.example.com/');
    await svc.get('https://x.example.com/');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('returns null when not connected', async () => {
    const svc = new LookupService(new UrlCache<LookupSummary>({ ttlMs: 1000 }), async () => null);
    expect(await svc.get('https://x.example.com/')).toBeNull();
  });

  it('summarize keeps only what the badge needs', () => {
    const r = saved();
    expect(summarize({ matches: [{ library: 'b', item: r.item, path: ['a'] }] })).toEqual({
      matches: [{ library: 'b', itemId: 42, path: ['a'] }],
    });
  });
});
