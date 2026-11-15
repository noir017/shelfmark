<script lang="ts">
  import { client, unwrap } from '../api'
  import { NetworkError } from '../api/client'
  import type { SearchHit } from '../api/types'
  import BookmarkLink from '../components/BookmarkLink.svelte'
  import Favicon from '../components/Favicon.svelte'
  import Icon from '../components/Icon.svelte'
  import { t } from '../lib/i18n/index.svelte'
  import { escapeHtml, highlight, isEmptyQuery, matches, parseQuery, score } from '../lib/search/query'
  import { app, errorText } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { allBookmarks } from '../lib/tree'
  import { normalizeUrl } from '../lib/url'

  let { q, library = '', onback }: { q: string; library?: string; onback: () => void } = $props()

  let results = $state<SearchHit[]>([])
  let total = $state(0)
  let loading = $state(false)
  let error = $state('')
  let local = $state(false)
  let showHelp = $state(false)
  const PAGE = 50

  /** 离线时在缓存的树上本地搜索 */
  async function localSearch(qs: string): Promise<SearchHit[]> {
    const p = parseQuery(qs)
    const libs = app.libraries.map((l) => l.slug).filter((s) => !library || s === library)
    const entries = await Promise.all(libs.map((s) => loadTree(s)))
    const urlCount = new Map<string, number>()
    for (const e of entries) for (const n of e.index ? allBookmarks(e.index) : []) if (n.item.url) urlCount.set(normalizeUrl(n.item.url), (urlCount.get(normalizeUrl(n.item.url)) ?? 0) + 1)
    const hits: Array<{ s: number; h: SearchHit }> = []
    for (const e of entries) {
      if (!e.index) continue
      for (const n of e.index.byId.values()) {
        const it = n.item
        const sv = {
          library: e.slug, title: it.title, url: it.url ?? null, notes: it.notes ?? null, tags: it.tags, path: n.path,
          broken: !!it.health && ['broken', 'unreachable'].includes(it.health.status),
          duplicate: !!it.url && (urlCount.get(normalizeUrl(it.url)) ?? 0) > 1,
        }
        if (!matches(p, sv)) continue
        hits.push({
          s: score(p, sv, it.visitCount) + (it.type === 'bookmark' ? 1 : 0),
          h: { library: e.slug, item: it, path: n.path, pathIds: n.pathIds, highlights: { title: highlight(it.title, p.terms), url: highlight(it.url ?? '', p.terms) } },
        })
      }
    }
    return hits.sort((a, b) => b.s - a.s).map((x) => x.h)
  }

  async function run(more = false) {
    const qs = q.trim()
    error = ''
    if (!qs || isEmptyQuery(parseQuery(qs))) {
      results = []
      total = 0
      return
    }
    loading = true
    try {
      if (!app.online) throw new NetworkError()
      const r = await unwrap(
        client.GET('/api/v1/search', { params: { query: { q: qs, library: library || undefined, limit: PAGE, offset: more ? results.length : 0 } } }),
      )
      results = more ? [...results, ...r.results] : r.results
      total = r.total
      local = false
    } catch (e) {
      if (e instanceof NetworkError) {
        results = await localSearch(qs)
        total = results.length
        local = true
      } else error = errorText(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void q
    void library
    void run()
  })

  const libName = (s: string) => app.libraries.find((l) => l.slug === s)?.name ?? s
  const examples = ['svelte', '"go blog"', '#dev', 'site:github.com', 'in:工具', 'lib:work', 'is:broken', 'is:duplicate', 'react -vue']
</script>

<div class="search-results" data-testid="search-results">
  <div class="row head">
    <button class="btn small" onclick={onback}><Icon name="arrowLeft" size={15} />{t('search.backFolder')}</button>
    {#if local}<span class="badge warn" data-testid="local-search">{t('search.local')}</span>{/if}
    {#if q.trim() && !loading}<span class="hint">{t('search.total', { n: total })}</span>{/if}
    <div class="spacer"></div>
    <button class="link" onclick={() => (showHelp = !showHelp)}>{t('search.syntax')}</button>
  </div>
  {#if showHelp}
    <div class="card help">
      <p>{t('search.help')}</p>
      <div class="row">
        {#each examples as ex (ex)}<span class="chip"><code>{ex}</code></span>{/each}
      </div>
    </div>
  {/if}

  {#if error}<p class="error-text">{error}</p>{/if}

  <ul class="results">
    {#each results as r (r.library + ':' + r.item.id)}
      <li data-testid="search-hit">
        <Favicon item={r.item} size={20} />
        <div class="body">
          {#if r.item.type === 'folder'}
            <a class="title" href="/lib/{r.library}/f/{r.item.id}">{@html r.highlights?.title || escapeHtml(r.item.title)}</a>
          {:else}
            <BookmarkLink item={r.item} library={r.library} class="title">{@html r.highlights?.title || escapeHtml(r.item.title || r.item.url || '')}</BookmarkLink>
            <div class="url ellipsis">{@html r.highlights?.url || escapeHtml(r.item.url ?? '')}</div>
          {/if}
          {#if r.highlights?.notes && r.highlights.notes.includes('<mark>')}<div class="notes">{@html r.highlights.notes}</div>{/if}
          <div class="where">
            <a href="/lib/{r.library}{r.pathIds?.length ? '/f/' + r.pathIds[r.pathIds.length - 1] : ''}">
              {libName(r.library)}{r.path.length ? ' / ' + r.path.join(' / ') : ''}
            </a>
            {#each r.item.tags as tg (tg)}<a class="tag" href="/search?q={encodeURIComponent('#' + tg)}">#{tg}</a>{/each}
            {#if r.item.health && ['broken', 'unreachable'].includes(r.item.health.status)}<span class="badge danger">{t('health.broken')}</span>{/if}
          </div>
        </div>
      </li>
    {/each}
  </ul>
  {#if !local && results.length < total}
    <button class="btn" onclick={() => run(true)} disabled={loading}>{t('common.loadMore')}</button>
  {/if}
  {#if q.trim() && !loading && !results.length && !error}<p class="hint">{t('search.none')}</p>{/if}
</div>

<style>
  .head {
    margin-bottom: 8px;
  }
  .help {
    margin: 8px 0;
  }
  .help p {
    margin-top: 0;
  }
  .results {
    list-style: none;
    padding: 0;
    margin: 12px 0;
  }
  .results li {
    display: flex;
    gap: 12px;
    padding: 12px 4px;
    border-bottom: 1px solid var(--border);
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .body :global(.title) {
    font-weight: 600;
    font-size: 1.02rem;
  }
  .url {
    color: var(--ok);
    font-size: 0.85rem;
  }
  .notes {
    font-size: 0.88rem;
    color: var(--text-2);
  }
  .where {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 0.82rem;
    margin-top: 2px;
  }
  .where a:first-child {
    color: var(--text-3);
  }
</style>
