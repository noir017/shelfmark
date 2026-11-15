import { findFolder, walkBookmarks, type Node, type Snapshot } from '../lib/data';
import type { Link } from '../lib/discovery';

export type Entry = { kind: 'link'; link: Link } | { kind: 'folder'; id: string; title: string; entries: Entry[] };

export interface Group {
  id: string;
  title: string;
  layout: 'grid' | 'list';
  collapsed: boolean;
  entries: Entry[];
}

const MAX_DEPTH = 4;

export function entriesOf(library: string, nodes: readonly Node[], depth = 0): Entry[] {
  const out: Entry[] = [];
  for (const n of nodes) {
    if (n.type === 'bookmark') {
      if (!n.url) continue;
      out.push({
        kind: 'link',
        link: { library, id: n.id, title: n.title, url: n.url, ...(n.faviconId ? { faviconId: n.faviconId } : {}) },
      });
    } else if (depth < MAX_DEPTH) {
      out.push({ kind: 'folder', id: `${library}:${n.id}`, title: n.title, entries: entriesOf(library, n.children ?? [], depth + 1) });
    }
  }
  return out;
}

/**
 * 新标签页只显示一个位置：startLocation 指定的文件夹，或第一个库的根。
 * 最近/常用和多段起始页配置已去掉，搜索框常驻。
 */
export function buildGroups(s: Snapshot): Group[] {
  const sl = s.settings?.startLocation;
  let library = '';
  let folderId = 0;
  if (sl?.kind === 'folder' && sl.library && s.trees[sl.library]) {
    library = sl.library;
    folderId = sl.folderId ?? 0;
  } else {
    library = s.libraries[0]?.slug ?? '';
  }
  const tree = s.trees[library];
  if (!tree) return [];
  const folder = folderId ? findFolder(tree.children, folderId) : null;
  const title = folder?.title ?? s.libraries.find((l) => l.slug === library)?.name ?? library;
  return [{
    id: `${library}:${folderId}`,
    title,
    layout: 'grid',
    collapsed: false,
    entries: entriesOf(library, folder ? (folder.children ?? []) : tree.children),
  }];
}

export interface Hit {
  link: Link;
  path: string[];
  score: number;
}

/** Offline search over the cached trees: every word must match; `#tag` matches tags. */
export function searchLocal(s: Snapshot, query: string, limit = 20): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const lib of s.libraries) {
    const tree = s.trees[lib.slug];
    if (!tree) continue;
    for (const { node, path } of walkBookmarks(tree.children)) {
      if (!node.url) continue;
      const title = node.title.toLowerCase();
      const url = node.url.toLowerCase();
      const tags = (node.tags ?? []).map((t) => t.toLowerCase());
      const hay = `${title} ${url} ${path.join(' ').toLowerCase()} ${tags.join(' ')}`;
      let score = 0;
      const ok = words.every((w) => {
        if (w.startsWith('#') && w.length > 1) {
          const hit = tags.some((t) => t.startsWith(w.slice(1)));
          if (hit) score += 2;
          return hit;
        }
        if (title.includes(w)) score += 3;
        else if (url.includes(w)) score += 2;
        else if (hay.includes(w)) score += 1;
        else return false;
        return true;
      });
      if (!ok) continue;
      if (title.startsWith(words[0]!)) score += 1;
      hits.push({
        link: { library: lib.slug, id: node.id, title: node.title, url: node.url, ...(node.faviconId ? { faviconId: node.faviconId } : {}) },
        path: [lib.name, ...path],
        score,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.link.title.length - b.link.title.length).slice(0, limit);
}
