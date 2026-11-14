<script lang="ts">
  import type { Component } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import { t, type Key } from '../lib/i18n/index.svelte'
  import { app, logout } from '../lib/stores/app.svelte'

  let { params }: { params: Record<string, string>; query: URLSearchParams } = $props()

  type Section = { id: string; icon: string; label: Key; load: () => Promise<{ default: Component<any> }>; admin?: boolean }
  const SECTIONS: Section[] = [
    { id: 'account', icon: 'user', label: 'settings.account', load: () => import('./settings/Account.svelte') },
    { id: 'devices', icon: 'devices', label: 'settings.devices', load: () => import('./settings/Devices.svelte') },
    { id: 'libraries', icon: 'library', label: 'settings.libraries', load: () => import('./settings/Libraries.svelte') },
    { id: 'startpage', icon: 'home', label: 'settings.startpage', load: () => import('./settings/StartPageSettings.svelte') },
    { id: 'import-export', icon: 'upload', label: 'settings.importExport', load: () => import('./settings/ImportExport.svelte') },
    { id: 'integrations', icon: 'puzzle', label: 'settings.integrations', load: () => import('./settings/Integrations.svelte') },
    { id: 'users', icon: 'key', label: 'settings.users', load: () => import('./settings/Users.svelte'), admin: true },
    { id: 'about', icon: 'info', label: 'settings.about', load: () => import('./settings/About.svelte') },
  ]

  const visible = $derived(SECTIONS.filter((s) => !s.admin || app.me?.user.isAdmin))
  let wide = $state(typeof matchMedia !== 'undefined' ? matchMedia('(min-width: 900px)').matches : true)
  $effect(() => {
    const mq = matchMedia('(min-width: 900px)')
    const on = () => (wide = mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  })
  const current = $derived(visible.find((s) => s.id === params.section) ?? (wide || params.section ? visible[0] : null))
  let Comp = $state<Component<any> | null>(null)
  let compFor = $state('')
  $effect(() => {
    const s = current
    if (!s) return
    let cancelled = false
    s.load().then((m) => {
      if (!cancelled) {
        Comp = m.default
        compFor = s.id
      }
    })
    return () => {
      cancelled = true
    }
  })
</script>

<div class="page settings">
  {#if wide || !current}
    <nav class="side" aria-label={t('nav.settings')}>
      <h1 class="narrow-only">{t('nav.settings')}</h1>
      {#each visible as s (s.id)}
        <a href="/settings/{s.id}" class:on={current?.id === s.id}><Icon name={s.icon} size={17} /> {t(s.label)}</a>
      {/each}
      <hr />
      <a href="/reports/broken"><Icon name="broken" size={17} /> {t('broken.title')}</a>
      <a href="/reports/duplicates"><Icon name="duplicate" size={17} /> {t('dup.title')}</a>
      <hr />
      <button class="logout" onclick={logout} data-testid="logout"><Icon name="logout" size={17} /> {t('settings.logout')}</button>
    </nav>
  {/if}
  {#if current}
    <section class="content">
      <div class="toolbar">
        {#if !wide}<a class="icon-btn" href="/settings" aria-label={t('common.back')}><Icon name="arrowLeft" /></a>{/if}
        <h1>{t(current.label)}</h1>
      </div>
      {#if Comp && compFor === current.id}
        <Comp />
      {/if}
    </section>
  {/if}
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 24px;
    align-items: start;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: calc(var(--topbar-h) + 12px);
  }
  .side a,
  .logout {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 7px;
    color: var(--text-2);
    text-decoration: none;
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .side a:hover,
  .logout:hover {
    background: var(--hover);
  }
  .side a.on {
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--border);
    width: 100%;
    margin: 6px 0;
  }
  .content {
    min-width: 0;
  }
  .content h1 {
    margin: 0;
  }
  @media (max-width: 899px) {
    .settings {
      grid-template-columns: 1fr;
    }
    .side {
      position: static;
    }
    .side a,
    .logout {
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
      border-radius: 0;
    }
  }
</style>
