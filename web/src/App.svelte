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

  const def = $derived(router.current.def)
  const bare = $derived(!!def.bare)
  const workspace = $derived(def.name === 'workspace')

  // 懒加载页面
  $effect(() => {
    const d = def
    let cancelled = false
    d.load().then((m) => {
      if (cancelled) return
      Page = m.default
      pageFor = d.name
    })
    return () => {
      cancelled = true
    }
  })

  // 主工作区在文件夹之间切换时不重建；设置页同理。
  const pageKey = $derived(def.name === 'workspace' ? 'workspace' : def.name === 'settings' ? 'settings' : router.current.path + '?' + router.current.query)

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

  const firstPending = $derived(app.pending[0])
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
  {#if !bare && !workspace}
    <header class="topbar">
      <a class="brand" href="/"><Icon name="bookmark" size={20} /><span>shelfmark</span></a>
      <div class="spacer"></div>
      <a class="btn small" href="/lib">{t('nav.bookmarks')}</a>
    </header>
  {/if}
  <main class:bare>
    {#if Page && pageFor === def.name}
      {#key pageKey}
        <Page params={router.current.params} query={router.current.query} />
      {/key}
    {/if}
  </main>
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
  .spacer {
    flex: 1;
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
