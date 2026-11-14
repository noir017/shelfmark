<script lang="ts">
  import type { Component } from 'svelte'
  import Icon from './components/Icon.svelte'
  import Overlays from './components/Overlays.svelte'
  import { t } from './lib/i18n/index.svelte'
  import { navigate, router } from './lib/router.svelte'
  import { focusSearch, installShortcuts } from './lib/shortcuts'
  import { app, refreshLibraries, refreshPending } from './lib/stores/app.svelte'
  import { prefetchAllTrees } from './lib/stores/trees.svelte'

  let Page = $state<Component<any> | null>(null)
  let pageFor = $state<string | null>(null)
  let showHelp = $state(false)
  let q = $state('')

  const def = $derived(router.current.def)
  const bare = $derived(!!def.bare)

  // 懒加载页面
  $effect(() => {
    const d = def
    let cancelled = false
    d.load().then((m) => {
      if (cancelled) return
      Page = m.default
      pageFor = d.pattern
    })
    return () => {
      cancelled = true
    }
  })

  const pageKey = $derived(['manager', 'settings'].includes(def.name) ? def.name : router.current.path + '?' + router.current.query)

  // 窗口重新获得焦点时刷新；定时检查待确认的上传
  let lastRefresh = 0
  function refresh() {
    if (!app.me || Date.now() - lastRefresh < 4000) return
    lastRefresh = Date.now()
    void refreshLibraries()
    void refreshPending()
    window.dispatchEvent(new CustomEvent('sm:refresh'))
  }
  $effect(() => {
    if (!app.me) return
    const timer = setInterval(() => void refreshPending(), 60_000)
    const idle = setTimeout(() => void prefetchAllTrees(), 1500)
    return () => {
      clearInterval(timer)
      clearTimeout(idle)
    }
  })

  installShortcuts({
    '/': (e) => {
      e.preventDefault()
      if (!focusSearch()) navigate('/search')
    },
    '?': () => (showHelp = true),
    Escape: () => (showHelp = false),
  })

  function search(e: Event) {
    e.preventDefault()
    if (!q.trim()) return
    navigate('/search?q=' + encodeURIComponent(q.trim()))
    q = ''
  }

  const firstPending = $derived(app.pending[0])
  const navItems = $derived([
    { href: '/', icon: 'home', label: t('nav.start'), on: def.name === 'start' },
    { href: '/lib', icon: 'library', label: t('nav.manager'), on: ['manager', 'history', 'deleted', 'pending'].includes(def.name) },
    { href: '/search', icon: 'search', label: t('nav.search'), on: def.name === 'search', narrow: true },
    { href: '/add', icon: 'bookmark-plus', label: t('nav.add'), on: def.name === 'share' },
    { href: '/settings', icon: 'settings', label: t('nav.settings'), on: def.name === 'settings' || def.name === 'broken' || def.name === 'duplicates' },
  ])
</script>

<svelte:window onfocus={refresh} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'visible' && refresh()} />

<div class="banners">
  {#if app.accessExpired}
    <div class="banner warn" role="alert" data-testid="access-expired">
      <Icon name="lock" />
      <span>{t('banner.accessExpired')}</span>
      <button class="btn small" onclick={() => location.reload()}>{t('banner.reload')}</button>
    </div>
  {/if}
  {#if !app.online && app.booted}
    <div class="banner" role="status" data-testid="offline-banner">
      <Icon name="offline" />
      <span>{t('banner.offline')}{app.queueCount ? ' · ' + t('banner.queued', { n: app.queueCount }) : ''}</span>
    </div>
  {/if}
  {#if app.me && firstPending}
    <div class="banner danger" role="alert" data-testid="pending-banner">
      <Icon name="warn" />
      <span>{t('banner.pending', { n: app.pending.length, actor: firstPending.actor })}</span>
      <a class="btn small" href="/pending/{firstPending.library}/{firstPending.id}">{t('banner.review')}</a>
    </div>
  {/if}
</div>

{#if !app.booted}
  <div class="boot"><span class="hint">{t('common.loading')}</span></div>
{:else if app.bootError}
  <div class="boot">
    <p class="error-text">{app.bootError}</p>
    <button class="btn" onclick={() => location.reload()}>{t('banner.reload')}</button>
  </div>
{:else}
  {#if !bare}
    <header class="topbar">
      <a class="brand" href="/"><Icon name="bookmark" size={20} /><span>shelfmark</span></a>
      {#if def.name !== 'start' && def.name !== 'search'}
        <form class="search wide-only" role="search" onsubmit={search}>
          <Icon name="search" size={16} />
          <input data-search-input type="search" bind:value={q} placeholder={t('search.placeholderShort')} aria-label={t('nav.search')} />
        </form>
      {:else}
        <div class="spacer"></div>
      {/if}
      <nav class="topnav wide-only">
        {#each navItems.filter((n) => !n.narrow) as n (n.href)}
          <a href={n.href} class:on={n.on}><Icon name={n.icon} size={17} /><span>{n.label}</span></a>
        {/each}
      </nav>
    </header>
  {/if}
  <main class:bare>
    {#if Page && pageFor === def.pattern}
      {#key pageKey}
        <Page params={router.current.params} query={router.current.query} />
      {/key}
    {/if}
  </main>
  {#if !bare}
    <nav class="bottomnav narrow-only" aria-label={t('nav.main')}>
      {#each navItems as n (n.href)}
        <a href={n.href} class:on={n.on}><Icon name={n.icon} size={20} /><span>{n.label}</span></a>
      {/each}
    </nav>
  {/if}
{/if}

{#if showHelp}
  {#await import('./components/ShortcutHelp.svelte') then m}
    <m.default onclose={() => (showHelp = false)} />
  {/await}
{/if}

<Overlays />

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--topbar-h);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    color: var(--text);
    text-decoration: none;
  }
  .brand :global(.icon) {
    color: var(--accent);
  }
  .search {
    flex: 1;
    max-width: 460px;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-2);
    border-radius: 8px;
    padding: 0 10px;
    color: var(--text-3);
  }
  .search input {
    border: 0;
    background: none;
    flex: 1;
    min-height: 34px;
    padding: 4px 2px;
  }
  .search input:focus {
    outline: none;
  }
  .spacer {
    flex: 1;
  }
  .topnav {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  .topnav a {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 6px 10px;
    border-radius: 7px;
    color: var(--text-2);
    text-decoration: none;
  }
  .topnav a:hover {
    background: var(--hover);
  }
  .topnav a.on {
    color: var(--accent-text);
    background: var(--accent-soft);
  }
  .bottomnav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    height: calc(var(--bottom-nav-h) + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    display: flex;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .bottomnav a {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-size: 0.72rem;
    color: var(--text-3);
    text-decoration: none;
  }
  .bottomnav a.on {
    color: var(--accent);
  }
  .banners {
    position: sticky;
    top: 0;
    z-index: 30;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    background: var(--info-bg);
    color: var(--text);
    font-size: 0.92rem;
  }
  .banner.warn {
    background: var(--warn-bg-strong);
    color: #1a1a1a;
  }
  .banner.danger {
    background: var(--warn-bg);
    color: var(--text);
    border-bottom: 1px solid var(--warn-bg-strong);
  }
  .banner span {
    flex: 1;
  }
  .boot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 60vh;
  }
</style>
