import { describe, expect, it } from 'vitest';
import { UrlCache, urlKey } from '../../src/lib/url-cache';
import { MemoryArea } from '../helpers/memory-area';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const FIVE_MIN = 5 * 60 * 1000;

describe('UrlCache', () => {
  it('returns values until the TTL passes', async () => {
    const c = clock();
    const cache = new UrlCache<number>({ ttlMs: FIVE_MIN, now: c.now });
    await cache.set('https://a.example.com/', 1);
    c.advance(FIVE_MIN - 1);
    expect(await cache.get('https://a.example.com/')).toBe(1);
    c.advance(1);
    expect(await cache.get('https://a.example.com/')).toBeUndefined();
    expect(await cache.size()).toBe(0);
  });

  it('ignores the fragment', async () => {
    const cache = new UrlCache<string>({ ttlMs: FIVE_MIN });
    await cache.set('https://a.example.com/page#one', 'x');
    expect(await cache.get('https://a.example.com/page#two')).toBe('x');
    expect(await cache.get('https://a.example.com/page')).toBe('x');
    expect(await cache.get('https://a.example.com/page?x=1')).toBeUndefined();
    expect(urlKey('https://a/#b#c')).toBe('https://a/');
  });

  it('re-setting refreshes the expiry', async () => {
    const c = clock();
    const cache = new UrlCache<number>({ ttlMs: 1000, now: c.now });
    await cache.set('u', 1);
    c.advance(900);
    await cache.set('u', 2);
    c.advance(900);
    expect(await cache.get('u')).toBe(2);
  });

  it('deletes and clears', async () => {
    const cache = new UrlCache<number>({ ttlMs: 1000 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.delete('a#frag');
    expect(await cache.get('a')).toBeUndefined();
    await cache.clear();
    expect(await cache.get('b')).toBeUndefined();
  });

  it('evicts the oldest entries beyond maxEntries', async () => {
    const cache = new UrlCache<number>({ ttlMs: 1000, maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 11); // touch a, so b is now the oldest
    await cache.set('c', 3);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(11);
    expect(await cache.get('c')).toBe(3);
  });

  it('persists to a storage area and survives a restart', async () => {
    const c = clock();
    const area = new MemoryArea();
    const first = new UrlCache<{ saved: boolean }>({ ttlMs: FIVE_MIN, now: c.now, area, storageKey: 'lk' });
    await first.set('https://a.example.com/', { saved: true });
    await first.set('https://b.example.com/', { saved: false });
    expect(Object.keys(area.data)).toEqual(['lk']);

    // A new service worker instance starts with an empty memory map.
    const second = new UrlCache<{ saved: boolean }>({ ttlMs: FIVE_MIN, now: c.now, area, storageKey: 'lk' });
    expect(await second.get('https://a.example.com/')).toEqual({ saved: true });
    c.advance(FIVE_MIN);
    const third = new UrlCache<{ saved: boolean }>({ ttlMs: FIVE_MIN, now: c.now, area, storageKey: 'lk' });
    expect(await third.get('https://b.example.com/')).toBeUndefined();
  });

  it('keeps working when persistence fails', async () => {
    const broken = {
      get: async () => {
        throw new Error('no session storage');
      },
      set: async () => {
        throw new Error('quota');
      },
      remove: async () => undefined,
    };
    const cache = new UrlCache<number>({ ttlMs: 1000, area: broken });
    await cache.set('a', 1);
    expect(await cache.get('a')).toBe(1);
  });
});
