import type { Api } from '../api/client';

export interface FaviconLoaderOptions {
  concurrency?: number;
  /** Cache Storage for offline use; null disables it. Defaults to globalThis.caches. */
  caches?: CacheStorage | null;
  cacheName?: string;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

/**
 * Loads favicons through the API (with auth and Access headers) and hands out blob: URLs.
 * IDs are content hashes, so cached bytes never go stale.
 */
export class FaviconLoader {
  private readonly api: Pick<Api, 'favicon' | 'baseUrl'>;
  private readonly concurrency: number;
  private readonly caches: CacheStorage | null;
  private readonly cacheName: string;
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly urls: string[] = [];
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(api: Pick<Api, 'favicon' | 'baseUrl'>, opts: FaviconLoaderOptions = {}) {
    this.api = api;
    this.concurrency = opts.concurrency ?? 6;
    this.caches = opts.caches === undefined ? (globalThis.caches ?? null) : opts.caches;
    this.cacheName = opts.cacheName ?? 'shelfmark-favicons';
    this.createUrl = opts.createObjectURL ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = opts.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
  }

  /** blob: URL for the icon, or null when it can't be loaded. */
  load(faviconId: string): Promise<string | null> {
    let p = this.pending.get(faviconId);
    if (!p) {
      p = this.limit(() => this.fetchBlob(faviconId)).then((blob) => {
        if (!blob) return null;
        const url = this.createUrl(blob);
        this.urls.push(url);
        return url;
      });
      this.pending.set(faviconId, p);
    }
    return p;
  }

  dispose(): void {
    for (const u of this.urls.splice(0)) this.revokeUrl(u);
    this.pending.clear();
  }

  private cacheKey(id: string): string {
    return `${this.api.baseUrl}/api/v1/favicons/${id}`;
  }

  private async fetchBlob(id: string): Promise<Blob | null> {
    const cache = await this.openCache();
    if (cache) {
      try {
        const hit = await cache.match(this.cacheKey(id));
        if (hit) return await hit.blob();
      } catch {
        // fall through to network
      }
    }
    let blob: Blob;
    try {
      blob = await this.api.favicon(id);
    } catch {
      return null;
    }
    if (!blob.type.startsWith('image/')) return null;
    if (cache) {
      try {
        await cache.put(this.cacheKey(id), new Response(blob, { headers: { 'content-type': blob.type } }));
      } catch {
        // quota or unsupported; icon still shows
      }
    }
    return blob;
  }

  private async openCache(): Promise<Cache | null> {
    if (!this.caches) return null;
    try {
      return await this.caches.open(this.cacheName);
    } catch {
      return null;
    }
  }

  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter.
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
