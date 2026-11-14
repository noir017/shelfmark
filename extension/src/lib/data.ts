import type { Api } from '../api/client';
import { readCache, removeCache, writeCache, type StorageAreaLike } from './storage';
import type { Item, Library, Settings } from './types';

/** Tree node as cached locally: only what the extension renders or searches. */
export interface Node {
  id: number;
  type: 'folder' | 'bookmark';
  title: string;
  url?: string;
  faviconId?: string;
  tags?: string[];
  children?: Node[];
}

export interface LibraryInfo {
  slug: string;
  name: string;
  revision: number;
}

export interface CachedTree {
  slug: string;
  revision: number;
  etag: string | null;
  children: Node[];
}

/** Everything the popup, options page and new tab need about the account, cached for offline use. */
export interface Snapshot {
  libraries: LibraryInfo[];
  trees: Record<string, CachedTree>;
  settings: Settings | null;
  fetchedAt: number;
}

const LIBS_KEY = 'libraries';
const SETTINGS_KEY = 'settings';
const treeKey = (slug: string) => `tree:${slug}`;

export function compactItems(items: readonly Item[]): Node[] {
  return items.map((it) => {
    const node: Node = { id: it.id, type: it.type, title: it.title };
    if (it.type === 'bookmark') {
      if (it.url) node.url = it.url;
      if (it.faviconId) node.faviconId = it.faviconId;
      if (it.tags?.length) node.tags = it.tags;
    } else {
      node.children = compactItems(it.children ?? []);
    }
    return node;
  });
}

export function libraryInfo(l: Library): LibraryInfo {
  return { slug: l.slug, name: l.name, revision: l.revision };
}

interface StoredLibraries {
  libraries: LibraryInfo[];
  fetchedAt: number;
}

export async function readSnapshot(area: StorageAreaLike): Promise<Snapshot | null> {
  const libs = await readCache<StoredLibraries>(area, LIBS_KEY);
  if (!libs) return null;
  const settings = (await readCache<Settings>(area, SETTINGS_KEY)) ?? null;
  const trees: Record<string, CachedTree> = {};
  for (const l of libs.libraries) {
    const t = await readCache<CachedTree>(area, treeKey(l.slug));
    if (t) trees[l.slug] = t;
  }
  return { libraries: libs.libraries, trees, settings, fetchedAt: libs.fetchedAt };
}

/** Fetch libraries, settings and changed trees (skipping unchanged revisions, then ETag). */
export async function refreshSnapshot(
  api: Api,
  area: StorageAreaLike,
  now: () => number = Date.now,
): Promise<Snapshot> {
  const [libs, settings] = await Promise.all([api.libraries(), api.settings()]);
  const libraries = libs.map(libraryInfo);
  const previous = await readCache<StoredLibraries>(area, LIBS_KEY);
  const trees: Record<string, CachedTree> = {};
  for (const lib of libraries) {
    const cached = await readCache<CachedTree>(area, treeKey(lib.slug));
    if (cached && cached.revision === lib.revision) {
      trees[lib.slug] = cached;
      continue;
    }
    const r = await api.tree(lib.slug, cached?.etag);
    if (r.notModified && cached) {
      trees[lib.slug] = cached;
      continue;
    }
    if (r.notModified) {
      // 304 without a local copy should not happen; fetch the full tree.
      const full = await api.tree(lib.slug);
      if (full.notModified) continue;
      trees[lib.slug] = toCached(lib.slug, full.tree, full.etag);
    } else {
      trees[lib.slug] = toCached(lib.slug, r.tree, r.etag);
    }
    await writeCache(area, treeKey(lib.slug), trees[lib.slug]);
  }
  const fetchedAt = now();
  await writeCache(area, LIBS_KEY, { libraries, fetchedAt } satisfies StoredLibraries);
  await writeCache(area, SETTINGS_KEY, settings);
  const gone = (previous?.libraries ?? []).filter((p) => !libraries.some((l) => l.slug === p.slug));
  await removeCache(area, gone.map((g) => treeKey(g.slug)));
  return { libraries, trees, settings, fetchedAt };
}

function toCached(slug: string, tree: { revision: number; children: Item[] }, etag: string | null): CachedTree {
  return { slug, revision: tree.revision, etag, children: compactItems(tree.children) };
}

export async function cacheSettings(area: StorageAreaLike, settings: Settings): Promise<void> {
  await writeCache(area, SETTINGS_KEY, settings);
}

/** Depth-first walk over bookmarks with their folder path. */
export function* walkBookmarks(
  nodes: readonly Node[],
  path: string[] = [],
): Generator<{ node: Node; path: string[] }> {
  for (const n of nodes) {
    if (n.type === 'bookmark') yield { node: n, path };
    else if (n.children) yield* walkBookmarks(n.children, [...path, n.title]);
  }
}

export function findFolder(nodes: readonly Node[], id: number): Node | null {
  for (const n of nodes) {
    if (n.type !== 'folder') continue;
    if (n.id === id) return n;
    const hit = findFolder(n.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}
