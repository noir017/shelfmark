import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/client';
import { compactItems, readSnapshot, refreshSnapshot, walkBookmarks, type Snapshot } from '../../src/lib/data';
import { readDiscovery, refreshDiscovery } from '../../src/lib/discovery';
import { filterTargets, findTarget, folderTargets, orderTargets, snapshotTargets, targetLabel } from '../../src/lib/targets';
import type { ItemWithPath } from '../../src/lib/types';
import { buildGroups, searchLocal } from '../../src/newtab/model';
import { startFakeServer } from '../fake-server/server.mjs';
import { MemoryArea } from '../helpers/memory-area';

type Fake = Awaited<ReturnType<typeof startFakeServer>>;
let server: Fake;
let api: ReturnType<typeof createApi>;

beforeAll(async () => {
  server = await startFakeServer();
  api = createApi({ serverUrl: server.url, token: server.issueToken() });
});
afterAll(() => server.close());

const treeRequests = () => server.state.requests.filter((r) => r.path.endsWith('/tree'));

describe('snapshot cache', () => {
  it('stores compact trees and skips unchanged libraries', async () => {
    const area = new MemoryArea();
    expect(await readSnapshot(area)).toBeNull();
    server.state.requests.length = 0;
    const snap = await refreshSnapshot(api, area, () => 1234);
    expect(snap.libraries.map((l) => l.slug)).toEqual(['bookmarks', 'work']);
    expect(treeRequests()).toHaveLength(2);
    expect(snap.fetchedAt).toBe(1234);
    const tools = snap.trees.bookmarks!.children.find((n) => n.title === '工具')!;
    expect(tools.children![0]).toEqual({ id: 3, type: 'bookmark', title: 'Example Tools', url: 'https://tools.example.com/', faviconId: expect.any(String), tags: ['dev'] });
    expect(await readSnapshot(area)).toEqual(snap);

    // Same revisions: no tree requests at all.
    server.state.requests.length = 0;
    await refreshSnapshot(api, area);
    expect(treeRequests()).toHaveLength(0);

    // A change in one library refetches just that tree, conditionally.
    await api.quickSave({ library: 'work', url: 'https://new-work.example.com/' });
    server.state.requests.length = 0;
    const next = await refreshSnapshot(api, area);
    expect(treeRequests().map((r) => [r.path, r.headers['if-none-match']])).toEqual([['/api/v1/libraries/work/tree', '"r1"']]);
    expect([...walkBookmarks(next.trees.work!.children)].map((b) => b.node.url)).toContain('https://new-work.example.com/');
  });

  it('forgets trees of libraries that disappeared', async () => {
    const area = new MemoryArea();
    await refreshSnapshot(api, area);
    const work = server.alice.libraries.get('work');
    server.alice.libraries.delete('work');
    try {
      const snap = await refreshSnapshot(api, area);
      expect(snap.libraries.map((l) => l.slug)).toEqual(['bookmarks']);
      expect(Object.keys(area.data).filter((k) => k.startsWith('cache:tree:'))).toEqual(['cache:tree:bookmarks']);
    } finally {
      server.alice.libraries.set('work', work);
    }
  });

  it('compactItems drops fields the extension never shows', () => {
    const nodes = compactItems([
      {
        id: 1, type: 'folder', parentId: 0, position: 0, title: 'F', createdAt: '', updatedAt: '', tags: [], visitCount: 0,
        children: [{ id: 2, type: 'bookmark', parentId: 1, position: 0, title: 'B', url: 'https://b/', createdAt: '', updatedAt: '', tags: [], visitCount: 3, notes: 'long' }],
      },
    ]);
    expect(nodes).toEqual([{ id: 1, type: 'folder', title: 'F', children: [{ id: 2, type: 'bookmark', title: 'B', url: 'https://b/' }] }]);
  });
});

describe('save targets', () => {
  const lib = { slug: 'bookmarks', name: '书签', revision: 1 };
  const nodes = compactItems([]);
  const tree = [
    { id: 1, type: 'folder' as const, title: '工具', children: [{ id: 2, type: 'folder' as const, title: '开发', children: [] }] },
    { id: 3, type: 'bookmark' as const, title: 'x', url: 'https://x/' },
    { id: 4, type: 'folder' as const, title: '阅读', children: [] },
  ];

  it('lists the root and every folder with its path', () => {
    expect(folderTargets(lib, nodes)).toHaveLength(1);
    expect(folderTargets(lib, tree).map((t) => [t.folderId, t.path])).toEqual([
      [0, []],
      [1, ['工具']],
      [2, ['工具', '开发']],
      [4, ['阅读']],
    ]);
  });

  it('puts recently used targets first and skips stale ones', () => {
    const all = folderTargets(lib, tree);
    const { recent, others } = orderTargets(all, [
      { library: 'bookmarks', folderId: 4 },
      { library: 'bookmarks', folderId: 99 },
      { library: 'bookmarks', folderId: 4 },
      { library: 'bookmarks', folderId: 2 },
    ]);
    expect(recent.map((t) => t.folderId)).toEqual([4, 2]);
    expect(others.map((t) => t.folderId)).toEqual([0, 1]);
  });

  it('filters by every word, case-insensitively, including the library name', () => {
    const all = folderTargets(lib, tree);
    expect(filterTargets(all, '开发').map((t) => t.folderId)).toEqual([2]);
    expect(filterTargets(all, '工具 开发').map((t) => t.folderId)).toEqual([2]);
    expect(filterTargets(all, 'BOOKMARKS 阅读').map((t) => t.folderId)).toEqual([4]);
    expect(filterTargets(all, '')).toHaveLength(4);
  });

  it('labels with or without the library name', () => {
    const [root, , dev] = folderTargets(lib, tree);
    expect(targetLabel(root!, true)).toBe('书签');
    expect(targetLabel(dev!, false)).toBe('工具 / 开发');
    expect(targetLabel(dev!, true)).toBe('书签 / 工具 / 开发');
    expect(findTarget(folderTargets(lib, tree), { library: 'bookmarks', folderId: 2 })?.path).toEqual(['工具', '开发']);
    expect(findTarget(folderTargets(lib, tree), { library: 'work', folderId: 2 })).toBeNull();
    expect(findTarget(folderTargets(lib, tree), null)).toBeNull();
  });
});

function snapshotOf(over: Partial<Snapshot> = {}): Snapshot {
  return {
    libraries: [{ slug: 'bookmarks', name: '书签', revision: 1 }],
    trees: {
      bookmarks: {
        slug: 'bookmarks',
        revision: 1,
        etag: null,
        children: [
          { id: 1, type: 'bookmark', title: 'Root link', url: 'https://root.example.com/' },
          {
            id: 2, type: 'folder', title: '工具',
            children: [
              { id: 3, type: 'bookmark', title: 'Rust Book', url: 'https://doc.rust-lang.example/book', tags: ['rust', 'docs'] },
              { id: 4, type: 'folder', title: '深层', children: [{ id: 5, type: 'bookmark', title: 'Deep', url: 'https://deep.example.com/' }] },
            ],
          },
          { id: 6, type: 'folder', title: '阅读', children: [{ id: 7, type: 'bookmark', title: 'Trusty blog', url: 'https://blog.example.org/' }] },
        ],
      },
    },
    settings: null,
    fetchedAt: 0,
    ...over,
  };
}

describe('new tab model', () => {
  it('shows one group at the library root', () => {
    const groups = buildGroups(snapshotOf());
    expect(groups.map((g) => g.title)).toEqual(['书签']);
    const entries = groups[0]!.entries;
    expect(entries.map((e) => (e.kind === 'link' ? e.link.title : `[${e.title}]`))).toEqual(['Root link', '[工具]', '[阅读]']);
    const tools = entries[1]!;
    expect(tools.kind === 'folder' && tools.entries.map((e) => (e.kind === 'link' ? e.link.title : `[${e.title}]`))).toEqual(['Rust Book', '[深层]']);
  });

  it('opens the configured start folder', () => {
    const snap = snapshotOf({
      settings: {
        language: 'auto', theme: 'dark', openInNewTab: false, defaultSave: null, recentSaveTargets: [],
        startLocation: { kind: 'folder', library: 'bookmarks', folderId: 6 },
      },
    });
    const groups = buildGroups(snap);
    expect(groups.map((g) => [g.id, g.title, g.layout, g.collapsed])).toEqual([['bookmarks:6', '阅读', 'grid', false]]);
    expect(groups[0]!.entries.map((e) => (e.kind === 'link' ? e.link.title : ''))).toEqual(['Trusty blog']);
  });

  it('searches the cached trees offline', () => {
    const s = snapshotOf();
    expect(searchLocal(s, 'rust').map((h) => h.link.title)).toEqual(['Rust Book', 'Trusty blog']);
    expect(searchLocal(s, '#docs').map((h) => h.link.title)).toEqual(['Rust Book']);
    expect(searchLocal(s, '深层').map((h) => [h.link.title, h.path])).toEqual([['Deep', ['书签', '工具', '深层']]]);
    expect(searchLocal(s, 'rust blog').map((h) => h.link.title)).toEqual(['Trusty blog']);
    expect(searchLocal(s, '   ')).toEqual([]);
  });
});

describe('discovery (recent / frequent across libraries)', () => {
  it('fetches only what the start page shows and caches it', async () => {
    const area = new MemoryArea();
    const snap = await refreshSnapshot(api, area);
    const d = await refreshDiscovery(api, area, snap, () => 99);
    expect(d.recent.length).toBeGreaterThan(0); // demo settings show recent
    expect(d.frequent).toEqual([]);
    expect(await readDiscovery(area)).toEqual(d);
    expect(snapshotTargets(snap).length).toBeGreaterThan(3);
  });
});
