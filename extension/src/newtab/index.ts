import { createApi, type Api } from '../api/client';
import { readSnapshot, refreshSnapshot, type Snapshot } from '../lib/data';
import type { Link } from '../lib/discovery';
import { byId, h, show } from '../lib/dom';
import { describeError, isOfflineError } from '../lib/errors';
import { ext } from '../lib/ext';
import { FaviconLoader } from '../lib/favicons';
import { localize, t } from '../lib/i18n';
import { looksLikeUrl, toNavigableUrl } from '../lib/server-url';
import { apiConfig, hasAccessToken, isConfigured, loadConfig, readCache, writeCache, type Config, type StorageAreaLike } from '../lib/storage';
import { buildGroups, searchLocal, type Entry, type Group, type Hit } from './model';

const area = ext.storage.local as unknown as StorageAreaLike;
const COLLAPSED_KEY = 'collapsed';

type Mode = 'setup' | 'bookmarks' | 'search';

class NewTab {
  private readonly config: Config;
  private readonly mode: Mode;
  private readonly api: Api | null;
  private readonly favicons: FaviconLoader | null;
  private snapshot: Snapshot | null = null;
  private collapsed: Record<string, boolean> = {};
  private hits: Hit[] = [];
  private active = -1;
  private readonly observer: IntersectionObserver;

  private readonly q = byId<HTMLInputElement>('q');
  private readonly results = byId<HTMLUListElement>('results');
  private readonly content = byId('content');
  private readonly banner = byId('banner');
  private readonly hint = byId('hint');

  constructor(config: Config) {
    this.config = config;
    this.mode = !isConfigured(config) ? 'setup' : config.newTabBookmarks ? 'bookmarks' : 'search';
    this.api = isConfigured(config) ? createApi(apiConfig(config)) : null;
    this.favicons = this.api ? new FaviconLoader(this.api) : null;
    document.body.dataset.mode = this.mode;
    this.observer = new IntersectionObserver((entries) => this.onVisible(entries), { rootMargin: '200px' });
    window.addEventListener('pagehide', () => this.favicons?.dispose());
  }

  async start(): Promise<void> {
    this.bindSearch();
    const serverLink = byId<HTMLAnchorElement>('server-link');
    if (this.config.serverUrl) serverLink.href = this.config.serverUrl;
    show(serverLink, Boolean(this.config.serverUrl));
    if (this.mode === 'setup' || !this.api) {
      this.hint.replaceChildren(t('newtabSetup'), ' ', h('a', { href: 'options.html' }, t('openSettings')));
      show(this.hint, true);
      return;
    }
    this.collapsed = (await readCache<Record<string, boolean>>(area, COLLAPSED_KEY)) ?? {};
    this.snapshot = await readSnapshot(area);
    this.render();
    try {
      this.snapshot = await refreshSnapshot(this.api, area);
      show(this.banner, false);
      this.render();
    } catch (err) {
      this.showProblem(err);
    }
  }

  private showProblem(err: unknown): void {
    // The search-only page stays quiet when offline; local search still works.
    if (this.mode === 'search' && isOfflineError(err)) return;
    let text = describeError(err, t, { accessTokenSet: hasAccessToken(this.config) });
    if (isOfflineError(err)) {
      text = this.snapshot
        ? t('newtabOffline', [new Date(this.snapshot.fetchedAt).toLocaleString()])
        : t('newtabOfflineEmpty');
    }
    this.banner.replaceChildren(text, ' ', h('a', { href: 'options.html' }, t('openSettings')));
    show(this.banner, true);
  }

  private applyTheme(): void {
    const theme = this.snapshot?.settings?.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  private render(): void {
    this.applyTheme();
    if (this.mode !== 'bookmarks' || !this.snapshot) return;
    show(byId('search-form'), true);
    const groups = buildGroups(this.snapshot);
    this.observer.disconnect();
    this.content.replaceChildren(...groups.map((g) => this.renderGroup(g)));
    show(this.hint, groups.length === 0);
    if (!groups.length) this.hint.textContent = t('newtabEmpty');
  }

  private renderGroup(g: Group): HTMLElement {
    const collapsed = this.collapsed[g.id] ?? g.collapsed;
    const body = h('div', { class: `entries ${g.layout}` }, g.entries.map((e) => this.renderEntry(e, g.layout)));
    body.hidden = collapsed;
    const toggle = h(
      'button',
      { type: 'button', class: 'group-toggle', 'aria-expanded': String(!collapsed) },
      h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
      g.title,
    );
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      this.collapsed[g.id] = body.hidden;
      void writeCache(area, COLLAPSED_KEY, this.collapsed);
    });
    return h('section', { class: 'group', dataset: { id: g.id } }, h('h2', null, toggle), body);
  }

  private renderEntry(e: Entry, layout: 'grid' | 'list'): HTMLElement {
    if (e.kind === 'link') return this.renderLink(e.link);
    return h(
      'details',
      { class: 'folder' },
      h('summary', null, e.title),
      h('div', { class: `entries ${layout}` }, e.entries.map((x) => this.renderEntry(x, layout))),
    );
  }

  private renderLink(link: Link, extra?: string): HTMLAnchorElement {
    const icon = h('span', { class: 'icon', 'aria-hidden': 'true' }, (link.title || link.url).trim().charAt(0).toUpperCase() || '•');
    if (link.faviconId) {
      icon.dataset.favicon = link.faviconId;
      this.observer.observe(icon);
    }
    const a = h(
      'a',
      {
        class: 'tile',
        href: link.url,
        title: `${link.title}\n${link.url}`,
        ...(this.snapshot?.settings?.openInNewTab ? { target: '_blank', rel: 'noopener' } : {}),
      },
      icon,
      h('span', { class: 'label' }, link.title || link.url),
      extra ? h('span', { class: 'path' }, extra) : null,
    );
    const visit = () => void this.api?.recordVisit(link.library, link.id).catch(() => undefined);
    a.addEventListener('click', visit);
    a.addEventListener('auxclick', (e) => {
      if (e.button === 1) visit();
    });
    return a;
  }

  private onVisible(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      this.observer.unobserve(el);
      const id = el.dataset.favicon;
      if (!id || !this.favicons) continue;
      void this.favicons.load(id).then((url) => {
        if (url) el.replaceChildren(h('img', { src: url, alt: '', width: 16, height: 16 }));
      });
    }
  }

  // --- search box ---

  private bindSearch(): void {
    this.q.addEventListener('input', () => this.updateResults());
    this.q.addEventListener('keydown', (e) => this.onSearchKey(e));
    byId<HTMLFormElement>('search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.openSelection();
    });
    this.q.focus();
  }

  private updateResults(): void {
    const query = this.q.value.trim();
    this.hits = query && this.snapshot ? searchLocal(this.snapshot, query, 12) : [];
    this.active = -1;
    this.renderResults();
    show(this.content, !query);
  }

  private renderResults(): void {
    const query = this.q.value.trim();
    const items = this.hits.map((hit, i) =>
      h('li', { class: i === this.active ? 'active' : '' }, this.renderLink(hit.link, hit.path.join(' / '))),
    );
    if (query && this.api) {
      items.push(
        h(
          'li',
          { class: `server-search${this.active === this.hits.length ? ' active' : ''}` },
          h('a', { href: this.api.webSearchUrl(query) }, t('newtabSearchServer', [query])),
        ),
      );
    }
    this.results.replaceChildren(...items);
    show(this.results, items.length > 0);
    this.results.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  private onSearchKey(e: KeyboardEvent): void {
    const count = this.results.children.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
      e.preventDefault();
      // -1 means "nothing highlighted" (Enter then uses the typed text).
      if (e.key === 'ArrowDown') this.active = this.active + 1 >= count ? -1 : this.active + 1;
      else this.active = this.active - 1 < -1 ? count - 1 : this.active - 1;
      this.renderResults();
    } else if (e.key === 'Escape') {
      this.q.value = '';
      this.updateResults();
    }
  }

  /** Enter: highlighted entry, else a typed address, else the first hit, else the server's search page. */
  private openSelection(): void {
    const query = this.q.value.trim();
    if (!query) return;
    const chosen = this.active >= 0 ? this.results.children[this.active]?.querySelector('a') : null;
    if (chosen) {
      chosen.click();
      return;
    }
    if (looksLikeUrl(query)) {
      location.href = toNavigableUrl(query);
      return;
    }
    this.results.querySelector('a')?.click();
  }
}

async function main(): Promise<void> {
  localize();
  const page = new NewTab(await loadConfig(area));
  await page.start();
}

void main();
