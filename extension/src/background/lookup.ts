import type { Api } from '../api/client';
import type { UrlCache } from '../lib/url-cache';
import type { LookupResult } from '../lib/types';

/** What the badge needs to know about a URL; small enough to keep hundreds in storage.session. */
export interface LookupSummary {
  matches: { library: string; itemId: number; path: string[] }[];
}

export function summarize(r: Pick<LookupResult, 'matches'>): LookupSummary {
  return {
    matches: r.matches.map((m) => ({ library: m.library, itemId: m.item.id, path: m.path })),
  };
}

export const LOOKUP_TTL_MS = 5 * 60 * 1000;

/** lookup with a 5-minute per-URL cache (design 13). */
export class LookupService {
  private readonly cache: UrlCache<LookupSummary>;
  private readonly getApi: () => Promise<Api | null>;
  private readonly inflight = new Map<string, Promise<LookupSummary | null>>();

  constructor(cache: UrlCache<LookupSummary>, getApi: () => Promise<Api | null>) {
    this.cache = cache;
    this.getApi = getApi;
  }

  /** null when the extension is not connected to a server. Throws ApiError on failure. */
  async get(url: string, opts: { force?: boolean } = {}): Promise<LookupSummary | null> {
    if (!opts.force) {
      const hit = await this.cache.get(url);
      if (hit) return hit;
    }
    const running = this.inflight.get(url);
    if (running) return running;
    const p = (async () => {
      const api = await this.getApi();
      if (!api) return null;
      const summary = summarize(await api.lookup(url));
      await this.cache.set(url, summary);
      return summary;
    })();
    this.inflight.set(url, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(url);
    }
  }

  put(url: string, summary: LookupSummary): Promise<void> {
    return this.cache.set(url, summary);
  }

  invalidate(url: string): Promise<void> {
    return this.cache.delete(url);
  }

  clear(): Promise<void> {
    return this.cache.clear();
  }
}
