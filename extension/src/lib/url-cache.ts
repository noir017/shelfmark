import type { StorageAreaLike } from './storage';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface UrlCacheOptions {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
  /** Optional persistence (e.g. storage.session) so entries survive service worker restarts. */
  area?: StorageAreaLike;
  storageKey?: string;
}

/** Cache key for a page address: the fragment never changes what the server matches. */
export function urlKey(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Time-limited cache keyed by URL, with optional write-through persistence. */
export class UrlCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly area?: StorageAreaLike;
  private readonly storageKey: string;
  private entries = new Map<string, Entry<T>>();
  private loading?: Promise<void>;

  constructor(opts: UrlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 500;
    this.now = opts.now ?? Date.now;
    this.area = opts.area;
    this.storageKey = opts.storageKey ?? 'urlCache';
  }

  async get(url: string): Promise<T | undefined> {
    await this.load();
    const key = urlKey(url);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      await this.persist();
      return undefined;
    }
    return entry.value;
  }

  async set(url: string, value: T): Promise<void> {
    await this.load();
    const key = urlKey(url);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.prune();
    await this.persist();
  }

  async delete(url: string): Promise<void> {
    await this.load();
    if (this.entries.delete(urlKey(url))) await this.persist();
  }

  async clear(): Promise<void> {
    await this.load();
    this.entries.clear();
    await this.persist();
  }

  async size(): Promise<number> {
    await this.load();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
    // Map keeps insertion order and set() re-inserts, so the first keys are the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  private load(): Promise<void> {
    if (!this.area) return Promise.resolve();
    this.loading ??= (async () => {
      try {
        const got = await this.area!.get(this.storageKey);
        const stored = got[this.storageKey] as Record<string, Entry<T>> | undefined;
        if (stored) {
          // Entries set before the load finished win over persisted ones.
          const fresh = this.entries;
          this.entries = new Map(Object.entries(stored));
          for (const [k, e] of fresh) this.entries.set(k, e);
          this.prune();
        }
      } catch {
        // Persistence is best effort; fall back to memory only.
      }
    })();
    return this.loading;
  }

  private async persist(): Promise<void> {
    if (!this.area) return;
    try {
      await this.area.set({ [this.storageKey]: Object.fromEntries(this.entries) });
    } catch {
      // ignore quota or availability errors
    }
  }
}
