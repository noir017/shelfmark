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

function toLinks(list: ItemWithPath[]): Link[] {
  return list.map(toLink).filter((l): l is Link => l !== null);
}

export async function refreshDiscovery(
  api: Api,
  area: StorageAreaLike,
  snapshot: Snapshot,
  now: () => number = Date.now,
): Promise<Discovery> {
  const sp = snapshot.settings?.startPage;
  const [recent, frequent] = await Promise.all([
    sp?.showRecent ? api.recent(sp.recentCount) : Promise.resolve([]),
    sp?.showFrequent ? api.frequent(sp.frequentCount) : Promise.resolve([]),
  ]);
  const d: Discovery = { recent: toLinks(recent), frequent: toLinks(frequent), fetchedAt: now() };
  await writeCache(area, KEY, d);
  return d;
}

export function readDiscovery(area: StorageAreaLike): Promise<Discovery | undefined> {
  return readCache<Discovery>(area, KEY);
}
