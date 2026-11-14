import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../../src/api/client';
import { buildSuggestions, escapeXml, OmniboxController, resolveInput, suggestionFor } from '../../src/background/omnibox';
import type { SearchHit } from '../../src/lib/types';
import { tt } from '../helpers/memory-area';

function hit(id: number, title: string, url: string, path: string[] = []): SearchHit {
  return {
    library: 'bookmarks',
    path,
    item: { id, type: 'bookmark', parentId: 0, position: 0, title, url, createdAt: '', updatedAt: '', tags: [], visitCount: 0 },
  };
}

describe('omnibox suggestions', () => {
  it('escapes XML for Chrome', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    const s = suggestionFor(hit(1, 'R&D <tips>', 'https://x.example.com/?a=1&b=2', ['工具']), 'chrome');
    expect(s.content).toBe('https://x.example.com/?a=1&b=2');
    expect(s.description).toBe(
      '<match>R&amp;D &lt;tips&gt;</match> <dim>bookmarks / 工具</dim> <url>https://x.example.com/?a=1&amp;b=2</url>',
    );
  });

  it('uses plain text for Firefox', () => {
    const s = suggestionFor(hit(1, 'R&D', 'https://x.example.com/'), 'firefox');
    expect(s.description).toBe('R&D — bookmarks — https://x.example.com/');
  });

  it('dedupes by URL, skips folders and caps the list', () => {
    const folder = { ...hit(9, 'F', ''), item: { ...hit(9, 'F', '').item, type: 'folder' as const, url: null } };
    const hits = [hit(1, 'A', 'https://a/'), hit(2, 'A again', 'https://a/'), folder, ...[3, 4, 5].map((i) => hit(i, `H${i}`, `https://h${i}/`))];
    const out = buildSuggestions(hits, 'firefox', 3);
    expect(out.map((s) => s.content)).toEqual(['https://a/', 'https://h3/', 'https://h4/']);
  });
});

describe('omnibox Enter', () => {
  const known = new Map([['https://a.example.com/', { library: 'bookmarks', itemId: 1 }]]);
  const web = (q: string) => `https://bm.example.com/search?q=${encodeURIComponent(q)}`;

  it('opens a suggested bookmark and remembers it for the visit count', () => {
    expect(resolveInput('https://a.example.com/', known, web)).toEqual({
      url: 'https://a.example.com/',
      visit: { library: 'bookmarks', itemId: 1 },
    });
  });

  it('opens typed addresses directly', () => {
    expect(resolveInput('https://b.example.com/x', known, web)).toEqual({ url: 'https://b.example.com/x' });
    expect(resolveInput('example.org/path', known, web)).toEqual({ url: 'https://example.org/path' });
  });

  it("sends anything else to the server's search page", () => {
    expect(resolveInput('rust async', known, web)).toEqual({ url: 'https://bm.example.com/search?q=rust%20async' });
    expect(resolveInput('rust', known, null)).toBeNull();
    expect(resolveInput('   ', known, web)).toBeNull();
  });
});

describe('OmniboxController', () => {
  function controller(search: (q: string) => Promise<{ results: SearchHit[] }>) {
    const recordVisit = vi.fn(async () => undefined);
    const api = { search, recordVisit, webSearchUrl: (q: string) => `https://bm.example.com/search?q=${q}` } as unknown as Api;
    const openUrl = vi.fn(async () => undefined);
    const setDefault = vi.fn();
    const c = new OmniboxController({ getApi: async () => api, openUrl, setDefault, target: 'chrome', t: tt, debounceMs: 0 });
    return { c, openUrl, recordVisit, setDefault };
  }

  it('suggests search results and records a visit on Enter', async () => {
    const { c, openUrl, recordVisit } = controller(async () => ({ results: [hit(5, 'Rust', 'https://rust.example.com/')] }));
    const suggest = vi.fn();
    await c.onInputChanged('rust', suggest);
    expect(suggest).toHaveBeenCalledWith([expect.objectContaining({ content: 'https://rust.example.com/' })]);
    await c.onInputEntered('https://rust.example.com/', 'newForegroundTab');
    expect(openUrl).toHaveBeenCalledWith('https://rust.example.com/', 'newForegroundTab');
    expect(recordVisit).toHaveBeenCalledWith('bookmarks', 5);
  });

  it('drops results of outdated keystrokes', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const search = vi.fn(async (q: string) => {
      if (q === 'ru') await slow;
      return { results: [hit(q.length, q, `https://${q}.example.com/`)] };
    });
    const { c } = controller(search);
    const first = vi.fn();
    const second = vi.fn();
    const p1 = c.onInputChanged('ru', first);
    await vi.waitFor(() => expect(search).toHaveBeenCalledWith('ru', 10));
    const p2 = c.onInputChanged('rust', second);
    await p2;
    release();
    await p1;
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('empty input clears suggestions without a request', async () => {
    const search = vi.fn();
    const { c, setDefault } = controller(search);
    const suggest = vi.fn();
    await c.onInputChanged('  ', suggest);
    expect(suggest).toHaveBeenCalledWith([]);
    expect(search).not.toHaveBeenCalled();
    c.onInputStarted();
    expect(setDefault).toHaveBeenCalledWith('omniboxDefault');
  });
});
