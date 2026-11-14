import { describe, expect, it } from 'vitest';
import {
  apiConfig,
  clearCache,
  CONFIG_KEY,
  DEFAULT_CONFIG,
  hasAccessToken,
  isConfigured,
  loadConfig,
  readCache,
  removeCache,
  saveConfig,
  writeCache,
} from '../../src/lib/storage';
import { MemoryArea } from '../helpers/memory-area';

describe('config storage', () => {
  it('returns defaults when nothing is stored', async () => {
    const config = await loadConfig(new MemoryArea());
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.newTabBookmarks).toBe(true);
    expect(isConfigured(config)).toBe(false);
  });

  it('merges patches and fills fields added in later versions', async () => {
    const area = new MemoryArea();
    area.data[CONFIG_KEY] = { serverUrl: 'https://bm.example.com', token: 'smk_a' }; // older shape
    const next = await saveConfig(area, { username: 'alice' });
    expect(next).toMatchObject({ serverUrl: 'https://bm.example.com', token: 'smk_a', username: 'alice', accessClientId: '' });
    expect(await loadConfig(area)).toEqual(next);
    expect(isConfigured(next)).toBe(true);
  });

  it('drops cached server data when the account or server changes', async () => {
    const area = new MemoryArea();
    await saveConfig(area, { serverUrl: 'https://bm.example.com', token: 'smk_a', username: 'alice' });
    await writeCache(area, 'tree:bookmarks', { x: 1 });
    await saveConfig(area, { newTabBookmarks: false });
    expect(await readCache(area, 'tree:bookmarks')).toEqual({ x: 1 });
    await saveConfig(area, { accessClientId: 'id', accessClientSecret: 's' });
    expect(await readCache(area, 'tree:bookmarks')).toEqual({ x: 1 });
    await saveConfig(area, { token: 'smk_b' });
    expect(await readCache(area, 'tree:bookmarks')).toBeUndefined();
    expect((await loadConfig(area)).token).toBe('smk_b');
  });

  it('reads, writes and clears cache entries under their own prefix', async () => {
    const area = new MemoryArea();
    await writeCache(area, 'a', [1]);
    await writeCache(area, 'b', 'two');
    await area.set({ unrelated: true });
    expect(await readCache(area, 'a')).toEqual([1]);
    await removeCache(area, ['a']);
    expect(await readCache(area, 'a')).toBeUndefined();
    await clearCache(area);
    expect(Object.keys(area.data)).toEqual(['unrelated']);
  });

  it('derives API settings and the access token flag', () => {
    const c = { ...DEFAULT_CONFIG, serverUrl: 'https://bm.example.com', token: 't', accessClientId: 'i', accessClientSecret: ' ' };
    expect(hasAccessToken(c)).toBe(false);
    expect(hasAccessToken({ ...c, accessClientSecret: 's' })).toBe(true);
    expect(apiConfig(c)).toEqual({ serverUrl: 'https://bm.example.com', token: 't', accessClientId: 'i', accessClientSecret: ' ' });
  });
});
