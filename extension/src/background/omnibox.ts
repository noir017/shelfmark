import type { Api } from '../api/client';
import type { Translate } from '../lib/i18n';
import { looksLikeUrl, toNavigableUrl } from '../lib/server-url';
import type { SearchHit } from '../lib/types';

export interface Suggestion {
  content: string;
  description: string;
  deletable?: boolean;
}

export type Disposition = 'currentTab' | 'newForegroundTab' | 'newBackgroundTab';

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Chrome renders a small XML dialect in descriptions; Firefox shows plain text. */
export function suggestionFor(hit: SearchHit, target: 'chrome' | 'firefox'): Suggestion {
  const url = hit.item.url ?? '';
  const title = hit.item.title || url;
  const path = [hit.library, ...hit.path].join(' / ');
  if (target === 'firefox') return { content: url, description: `${title} — ${path} — ${url}` };
  return {
    content: url,
    description: `<match>${escapeXml(title)}</match> <dim>${escapeXml(path)}</dim> <url>${escapeXml(url)}</url>`,
  };
}

export function buildSuggestions(hits: readonly SearchHit[], target: 'chrome' | 'firefox', max = 8): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const h of hits) {
    const url = h.item.url;
    if (h.item.type !== 'bookmark' || !url || seen.has(url)) continue;
    seen.add(url);
    out.push(suggestionFor(h, target));
    if (out.length >= max) break;
  }
  return out;
}

export interface Visit {
  library: string;
  itemId: number;
}

/** What Enter in the address bar opens: a suggested bookmark, a typed address, or the server's search page. */
export function resolveInput(
  text: string,
  known: ReadonlyMap<string, Visit>,
  webSearchUrl: ((q: string) => string) | null,
): { url: string; visit?: Visit } | null {
  const s = text.trim();
  if (!s) return null;
  const visit = known.get(s);
  if (visit) return { url: s, visit };
  if (/^https?:\/\//i.test(s) || looksLikeUrl(s)) return { url: toNavigableUrl(s) };
  return webSearchUrl ? { url: webSearchUrl(s) } : null;
}

export interface OmniboxDeps {
  getApi(): Promise<Api | null>;
  openUrl(url: string, disposition: Disposition): Promise<void>;
  setDefault(description: string): void;
  target: 'chrome' | 'firefox';
  t: Translate;
  debounceMs?: number;
}

/** Keyword `sm`: search bookmarks while typing, Enter opens the chosen one. */
export class OmniboxController {
  private readonly deps: OmniboxDeps;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle: (() => void) | undefined;
  private known = new Map<string, Visit>();

  constructor(deps: OmniboxDeps) {
    this.deps = deps;
  }

  onInputStarted(): void {
    this.deps.setDefault(this.deps.t('omniboxDefault'));
  }

  onInputChanged(text: string, suggest: (s: Suggestion[]) => void): Promise<void> {
    const seq = ++this.seq;
    clearTimeout(this.timer);
    this.settle?.();
    this.settle = undefined;
    const q = text.trim();
    if (!q) {
      suggest([]);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settle = resolve;
      this.timer = setTimeout(async () => {
        this.settle = undefined;
        try {
          const api = await this.deps.getApi();
          if (!api) {
            this.deps.setDefault(this.deps.t('omniboxNotConfigured'));
            return;
          }
          const res = await api.search(q, 10);
          if (seq !== this.seq) return; // a newer keystroke won
          for (const h of res.results)
            if (h.item.url) this.known.set(h.item.url, { library: h.library, itemId: h.item.id });
          if (this.known.size > 200) this.known = new Map([...this.known].slice(-100));
          suggest(buildSuggestions(res.results, this.deps.target));
        } catch {
          if (seq === this.seq) suggest([]);
        } finally {
          resolve();
        }
      }, this.deps.debounceMs ?? 150);
    });
  }

  async onInputEntered(text: string, disposition: Disposition): Promise<void> {
    const api = await this.deps.getApi();
    const target = resolveInput(text, this.known, api ? api.webSearchUrl : null);
    if (!target) return;
    await this.deps.openUrl(target.url, disposition);
    if (api && target.visit) await api.recordVisit(target.visit.library, target.visit.itemId).catch(() => undefined);
  }
}
