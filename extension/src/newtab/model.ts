import { findFolder, walkBookmarks, type Node, type Snapshot } from '../lib/data';
import type { Discovery, Link } from '../lib/discovery';

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
 * What the bookmark page shows, following the server's start page settings:
 * recent / frequent rows, then the configured folder sections. Without sections every
 * library's root bookmarks and top-level folders become groups.
 */
export function buildGroups(s: Snapshot, d: Discovery | undefined, labels: { recent: string; frequent: string }): Group[] {
  const sp = s.settings?.startPage;
  const groups: Group[] = [];
  const links = (list: Link[]): Entry[] => list.map((link) => ({ kind: 'link', link }));
  if (sp?.showRecent && d?.recent.length)
    groups.push({ id: 'recent', title: labels.recent, layout: 'grid', collapsed: false, entries: links(d.recent) });
  if (sp?.showFrequent && d?.frequent.length)
    groups.push({ id: 'frequent', title: labels.frequent, layout: 'grid', collapsed: false, entries: links(d.frequent) });

  const sections = sp?.sections ?? [];
  if (sections.length) {
    for (const sec of sections) {
      const tree = s.trees[sec.library];
      if (!tree) continue;
      const folder = sec.folderId === 0 ? null : findFolder(tree.children, sec.folderId);
      if (sec.folderId !== 0 && !folder) continue;
      const libName = s.libraries.find((l) => l.slug === sec.library)?.name ?? sec.library;
      groups.push({
        id: `section:${sec.id}`,
        title: sec.title || folder?.title || libName,
        layout: sec.layout,
        collapsed: sec.collapsed,
        entries: entriesOf(sec.library, folder ? (folder.children ?? []) : tree.children),
      });
    }
    return groups;
  }

  for (const lib of s.libraries) {
    const tree = s.trees[lib.slug];
    if (!tree) continue;
    const rootLinks = entriesOf(lib.slug, tree.children.filter((n) => n.type === 'bookmark'));
    if (rootLinks.length) groups.push({ id: `${lib.slug}:0`, title: lib.name, layout: 'grid', collapsed: false, entries: rootLinks });
    for (const f of tree.children) {
      if (f.type !== 'folder') continue;
      groups.push({
        id: `${lib.slug}:${f.id}`,
        title: s.libraries.length > 1 ? `${lib.name} / ${f.title}` : f.title,
        layout: 'grid',
        collapsed: false,
        entries: entriesOf(lib.slug, f.children ?? [], 1),
      });
    }
  }
  return groups;
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
