import type { ApiConfig } from '../api/client';

/** Minimal promise-based subset of chrome.storage.StorageArea (easy to fake in tests). */
export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface Config {
  serverUrl: string;
  token: string;
  /** ID of the token this extension created by password login; null when pasted. */
  tokenId: number | null;
  username: string;
  accessClientId: string;
  accessClientSecret: string;
  /** New tab shows the bookmark page; false = search box only. */
  newTabBookmarks: boolean;
}

export const DEFAULT_CONFIG: Config = {
  serverUrl: '',
  token: '',
  tokenId: null,
  username: '',
  accessClientId: '',
  accessClientSecret: '',
  newTabBookmarks: true,
};

export const CONFIG_KEY = 'config';
export const CACHE_PREFIX = 'cache:';

export function isConfigured(c: Config): boolean {
  return Boolean(c.serverUrl && c.token);
}

export function apiConfig(c: Config): ApiConfig {
  return {
    serverUrl: c.serverUrl,
    token: c.token,
    accessClientId: c.accessClientId,
    accessClientSecret: c.accessClientSecret,
  };
}

export function hasAccessToken(c: Pick<Config, 'accessClientId' | 'accessClientSecret'>): boolean {
  return Boolean(c.accessClientId.trim() && c.accessClientSecret.trim());
}

/** Whether cached server data (trees, lookups, settings) may belong to another account/server. */
export function connectionChanged(a: Config, b: Config): boolean {
  return a.serverUrl !== b.serverUrl || a.token !== b.token || a.username !== b.username;
}

export async function loadConfig(area: StorageAreaLike): Promise<Config> {
  const got = await area.get(CONFIG_KEY);
  const stored = (got[CONFIG_KEY] ?? {}) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...stored };
}

/** Merge and persist; drops every cached server object when the connection changes. */
export async function saveConfig(area: StorageAreaLike, patch: Partial<Config>): Promise<Config> {
  const current = await loadConfig(area);
  const next: Config = { ...current, ...patch };
  if (connectionChanged(current, next)) await clearCache(area);
  await area.set({ [CONFIG_KEY]: next });
  return next;
}

export async function readCache<T>(area: StorageAreaLike, key: string): Promise<T | undefined> {
  const full = CACHE_PREFIX + key;
  const got = await area.get(full);
  return got[full] as T | undefined;
}

export async function writeCache(area: StorageAreaLike, key: string, value: unknown): Promise<void> {
  await area.set({ [CACHE_PREFIX + key]: value });
}

export async function removeCache(area: StorageAreaLike, keys: string[]): Promise<void> {
  if (keys.length) await area.remove(keys.map((k) => CACHE_PREFIX + k));
}

export async function clearCache(area: StorageAreaLike): Promise<void> {
  const all = await area.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await area.remove(keys);
}
