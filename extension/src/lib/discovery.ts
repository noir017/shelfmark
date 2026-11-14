import type { Api } from '../api/client';
import type { Snapshot } from './data';
import { readCache, writeCache, type StorageAreaLike } from './storage';
import type { ItemWithPath } from './types';

/** A bookmark as shown on the new tab page. */
export interface Link {
  library: string;
  id: number;
  title: string;
  url: string;
  faviconId?: string;
}

export interface Discovery {
  recent: Link[];
  frequent: Link[];
  fetchedAt: number;
}

const KEY = 'discovery';

export function toLink(x: ItemWithPath): Link | null {
  if (x.item.type !== 'bookmark' || !x.item.url) return null;
  return {
    library: x.library,
    id: x.item.id,
    title: x.item.title,
    url: x.item.url,
    ...(x.item.faviconId ? { faviconId: x.item.faviconId } : {}),
  };
}

/** Merge per-library lists (the API has no cross-library recent/frequent endpoint). */
export function mergeRecent(lists: ItemWithPath[][], count: number): Link[] {
  return lists
    .flat()
    .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.item.id - a.item.id)
    .map(toLink)
    .filter((l): l is Link => l !== null)
    .slice(0, count);
}

export function mergeFrequent(lists: ItemWithPath[][], count: number): Link[] {
  return lists
    .flat()
    .filter((x) => x.item.visitCount > 0)
    .sort((a, b) => b.item.visitCount - a.item.visitCount)
    .map(toLink)
    .filter((l): l is Link => l !== null)
    .slice(0, count);
}

export async function refreshDiscovery(
  api: Api,
  area: StorageAreaLike,
  snapshot: Snapshot,
  now: () => number = Date.now,
): Promise<Discovery> {
  const sp = snapshot.settings?.startPage;
  const slugs = snapshot.libraries.map((l) => l.slug);
  const recentCount = sp?.recentCount ?? 10;
  const frequentCount = sp?.frequentCount ?? 10;
  const [recentLists, frequentLists] = await Promise.all([
    sp?.showRecent ? Promise.all(slugs.map((s) => api.recent(s, recentCount))) : Promise.resolve([]),
    sp?.showFrequent ? Promise.all(slugs.map((s) => api.frequent(s, frequentCount))) : Promise.resolve([]),
  ]);
  const d: Discovery = {
    recent: mergeRecent(recentLists, recentCount),
    frequent: mergeFrequent(frequentLists, frequentCount),
    fetchedAt: now(),
  };
  await writeCache(area, KEY, d);
  return d;
}

export function readDiscovery(area: StorageAreaLike): Promise<Discovery | undefined> {
  return readCache<Discovery>(area, KEY);
}
