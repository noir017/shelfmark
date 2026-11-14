import type { LibraryInfo, Node, Snapshot } from './data';
import type { SaveTarget } from './types';

/** A folder (or library root, folderId 0) something can be saved into. */
export interface Target {
  library: string;
  libraryName: string;
  folderId: number;
  /** Folder titles from the root down to and including this folder; [] for the root. */
  path: string[];
}

export function targetKey(t: Pick<SaveTarget, 'library' | 'folderId'>): string {
  return `${t.library}:${t.folderId}`;
}

export function folderTargets(lib: LibraryInfo, children: readonly Node[]): Target[] {
  const out: Target[] = [{ library: lib.slug, libraryName: lib.name, folderId: 0, path: [] }];
  const walk = (nodes: readonly Node[], path: string[]) => {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      const p = [...path, n.title];
      out.push({ library: lib.slug, libraryName: lib.name, folderId: n.id, path: p });
      walk(n.children ?? [], p);
    }
  };
  walk(children, []);
  return out;
}

export function snapshotTargets(s: Snapshot): Target[] {
  return s.libraries.flatMap((l) => folderTargets(l, s.trees[l.slug]?.children ?? []));
}

export function findTarget(targets: readonly Target[], st: SaveTarget | null | undefined): Target | null {
  if (!st) return null;
  const key = targetKey(st);
  return targets.find((t) => targetKey(t) === key) ?? null;
}

/** Recently used targets first (in server order, skipping ones that no longer exist), then the rest. */
export function orderTargets(
  targets: readonly Target[],
  recent: readonly SaveTarget[],
): { recent: Target[]; others: Target[] } {
  const seen = new Set<string>();
  const recentTargets: Target[] = [];
  for (const r of recent) {
    const t = findTarget(targets, r);
    if (!t || seen.has(targetKey(t))) continue;
    seen.add(targetKey(t));
    recentTargets.push(t);
  }
  return { recent: recentTargets, others: targets.filter((t) => !seen.has(targetKey(t))) };
}

export function targetLabel(t: Target, includeLibrary: boolean): string {
  if (!t.path.length) return t.libraryName;
  return includeLibrary ? [t.libraryName, ...t.path].join(' / ') : t.path.join(' / ');
}

/** Case-insensitive AND match of every word against library name and folder path. */
export function filterTargets(targets: readonly Target[], query: string): Target[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...targets];
  return targets.filter((t) => {
    const hay = [t.libraryName, t.library, ...t.path].join(' / ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
