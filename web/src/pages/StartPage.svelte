<script lang="ts">
  import { client, unwrap } from '../api'
  import type { Item, ItemWithPath, StartSection } from '../api/types'
  import BookmarkLink from '../components/BookmarkLink.svelte'
  import Favicon from '../components/Favicon.svelte'
  import Icon from '../components/Icon.svelte'
  import { t } from '../lib/i18n/index.svelte'
  import { navigate } from '../lib/router.svelte'
  import { app, defaultLibrary, saveSettings } from '../lib/stores/app.svelte'
  import { loadTree, treeEntry } from '../lib/stores/trees.svelte'
  import { childrenOf, allBookmarks } from '../lib/tree'
  import { hostOf, looksLikeUrl } from '../lib/url'

  let q = $state('')
  let recent = $state<ItemWithPath[]>([])
  let frequent = $state<ItemWithPath[]>([])

  const sp = $derived(app.settings?.startPage)
  const defLib = $derived(defaultLibrary())
  // 先把各库的 TreeEntry 建出来：tree/index 是 $state/$derived，若在某个派生里
  // 首次创建，Svelte 不会把同一派生里随后对它的读取记为依赖，树加载完也不会重算。
  for (const l of app.libraries) treeEntry(l.slug)
  /** 没配置分组时，用默认库的顶层文件夹 */
  const sections = $derived.by((): StartSection[] => {
    if (sp?.sections.length) return sp.sections
    if (!defLib) return []
    const idx = treeEntry(defLib).index
    if (!idx) return []
    return childrenOf(idx, 0)
      .filter((i) => i.type === 'folder')
      .slice(0, 8)
      .map((f) => ({ id: 'auto-' + f.id, library: defLib, folderId: f.id, title: null, layout: 'grid', collapsed: false }))
  })
  const auto = $derived(!sp?.sections.length)

  $effect(() => {
    const libs = new Set([...(sp?.sections ?? []).map((s) => s.library), ...(defLib ? [defLib] : [])])
    for (const l of libs) void loadTree(l)
  })

  async function loadLists() {
    if (!sp) return
    const libs = app.libraries.map((l) => l.slug)
    if (app.online) {
      try {
        if (sp.showRecent) recent = await unwrap(client.GET('/api/v1/recent', { params: { query: { limit: sp.recentCount } } }))
        if (sp.showFrequent) frequent = await unwrap(client.GET('/api/v1/frequent', { params: { query: { limit: sp.frequentCount } } }))
        return
      } catch {
        /* 离线：下面用缓存的树算 */
      }
    }
    const nodes: ItemWithPath[] = []
    for (const slug of libs) {
      const e = await loadTree(slug)
      if (e.index) for (const n of allBookmarks(e.index)) nodes.push({ library: slug, item: n.item, path: n.path, pathIds: n.pathIds })
    }
    recent = [...nodes].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt)).slice(0, sp.recentCount)
    frequent = nodes.filter((n) => n.item.visitCount > 0).sort((a, b) => b.item.visitCount - a.item.visitCount).slice(0, sp.frequentCount)
  }

  $effect(() => {
    void sp?.recentCount
    void sp?.frequentCount
    void app.libraries.length
    void loadLists()
  })

  function submit(e: Event) {
    e.preventDefault()
    const s = q.trim()
    if (!s) return
    const url = looksLikeUrl(s)
    if (url) location.assign(url)
    else navigate('/search?q=' + encodeURIComponent(s))
  }

  async function toggle(sec: StartSection) {
    if (!sp || auto) return
    const sections = sp.sections.map((s) => (s.id === sec.id ? { ...s, collapsed: !s.collapsed } : s))
    app.settings!.startPage = { ...sp, sections }
    try {
      await saveSettings({ startPage: { ...$state.snapshot(sp), sections } })
    } catch {
      /* 离线时只在本地生效 */
    }
  }

  function folderOf(sec: StartSection): { title: string; items: Item[] } | null {
    const e = treeEntry(sec.library)
    if (!e.index) return null
    const f = sec.folderId === 0 ? null : e.index.byId.get(sec.folderId)
    if (sec.folderId !== 0 && !f) return { title: sec.title ?? t('start.missingFolder'), items: [] }
    return { title: sec.title || (f ? f.item.title : app.libraries.find((l) => l.slug === sec.library)?.name ?? sec.library), items: childrenOf(e.index, sec.folderId) }
  }
</script>

<div class="page start">
  {#if sp?.showSearch !== false}
    <form class="bigsearch" role="search" onsubmit={submit}>
      <Icon name="search" size={20} />
      <!-- svelte-ignore a11y_autofocus -->
      <input data-search-input type="search" bind:value={q} placeholder={t('start.searchPlaceholder')} aria-label={t('nav.search')} autofocus data-testid="start-search" />
    </form>
  {/if}

  {#each sections as sec (sec.id)}
    {@const f = folderOf(sec)}
    {#if f}
      <section class="group" data-testid="start-section">
        <header>
          <button class="toggle" onclick={() => toggle(sec)} aria-expanded={!sec.collapsed} disabled={auto}>
            <Icon name={sec.collapsed ? 'chevron' : 'chevron-down'} size={16} />
            <h2>{f.title}</h2>
          </button>
          <a class="hint" href="/lib/{sec.library}{sec.folderId ? '/f/' + sec.folderId : ''}">{t('start.manage')}</a>
        </header>
        {#if !sec.collapsed}
          {#if !f.items.length}<p class="hint">{t('start.emptyFolder')}</p>{/if}
          <div class={sec.layout === 'grid' ? 'grid' : 'rows'}>
            {#each f.items as it (it.id)}
              {#if it.type === 'folder'}
                <a class="card-item folder" href="/lib/{sec.library}/f/{it.id}">
                  <Favicon item={it} size={sec.layout === 'grid' ? 28 : 18} />
                  <span class="t ellipsis">{it.title}</span>
                </a>
              {:else}
                <BookmarkLink item={it} library={sec.library} class="card-item">
                  <Favicon item={it} size={sec.layout === 'grid' ? 28 : 18} />
                  <span class="t ellipsis">{it.title || it.url}</span>
                  {#if sec.layout === 'list'}<span class="host hint ellipsis">{hostOf(it.url)}</span>{/if}
                </BookmarkLink>
              {/if}
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/each}

  {#if auto && app.libraries.length}
    <p class="hint center">{t('start.autoHint')} <a href="/settings/startpage">{t('start.configure')}</a></p>
  {/if}

  <div class="lists">
    {#if sp?.showRecent && recent.length}
      <section class="group">
        <header><h2><Icon name="clock" size={17} /> {t('start.recent')}</h2></header>
        <div class="rows">
          {#each recent as r (r.library + r.item.id)}
            <BookmarkLink item={r.item} library={r.library} class="card-item">
              <Favicon item={r.item} size={18} /><span class="t ellipsis">{r.item.title || r.item.url}</span>
              <span class="host hint ellipsis">{r.path.join(' / ')}</span>
            </BookmarkLink>
          {/each}
        </div>
      </section>
    {/if}
    {#if sp?.showFrequent && frequent.length}
      <section class="group">
        <header><h2><Icon name="star" size={17} /> {t('start.frequent')}</h2></header>
        <div class="rows">
          {#each frequent as r (r.library + r.item.id)}
            <BookmarkLink item={r.item} library={r.library} class="card-item">
              <Favicon item={r.item} size={18} /><span class="t ellipsis">{r.item.title || r.item.url}</span>
              <span class="host hint">{r.item.visitCount}</span>
            </BookmarkLink>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .start {
    max-width: 1000px;
  }
  .bigsearch {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4vh auto 24px;
    max-width: 640px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 18px;
    box-shadow: var(--shadow);
    color: var(--text-3);
  }
  .bigsearch input {
    flex: 1;
    border: 0;
    background: none;
    font-size: 1.05rem;
    min-height: 44px;
  }
  .bigsearch input:focus {
    outline: none;
  }
  .group {
    margin-bottom: 22px;
  }
  .group header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .group h2 {
    margin: 0;
    font-size: 1rem;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: 0;
    color: var(--text);
    cursor: pointer;
    padding: 0;
  }
  .toggle:disabled {
    cursor: default;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
  }
  .grid :global(.card-item) {
    flex-direction: column;
    text-align: center;
    padding: 14px 8px 10px;
    gap: 8px;
  }
  .grid :global(.card-item .t) {
    max-width: 100%;
    font-size: 0.88rem;
  }
  .rows {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 6px;
  }
  .rows :global(.card-item) {
    padding: 8px 10px;
  }
  .rows :global(.card-item .t) {
    flex: 1;
  }
  .rows :global(.card-item .host) {
    max-width: 40%;
    font-size: 0.8rem;
  }
  :global(.card-item) {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    text-decoration: none !important;
    min-width: 0;
  }
  :global(.card-item:hover) {
    border-color: var(--accent);
    box-shadow: var(--shadow);
  }
  .lists {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 0 20px;
  }
  .lists .rows {
    grid-template-columns: 1fr;
  }
  .center {
    text-align: center;
  }
</style>
