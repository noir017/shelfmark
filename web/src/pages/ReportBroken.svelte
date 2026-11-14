<script lang="ts">
  import { client, unwrap } from '../api'
  import type { BatchOp, HealthStatus, ItemWithPath } from '../api/types'
  import BookmarkLink from '../components/BookmarkLink.svelte'
  import Favicon from '../components/Favicon.svelte'
  import Icon from '../components/Icon.svelte'
  import { fmtRelative, t } from '../lib/i18n/index.svelte'
  import { confirmDialog } from '../lib/overlay.svelte'
  import { app, errorText, refreshLibraries } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { toast } from '../lib/toast.svelte'

  let { query }: { params: Record<string, string>; query: URLSearchParams } = $props()

  const ALL: HealthStatus[] = ['broken', 'unreachable', 'redirect', 'unknown', 'skipped']
  let statuses = $state<HealthStatus[]>(['broken', 'unreachable', 'redirect'])
  let library = $state(query.get('library') ?? '')
  let list = $state<ItemWithPath[]>([])
  let chosen = $state<string[]>([])
  let loading = $state(false)
  let error = $state('')

  const key = (r: ItemWithPath) => `${r.library}:${r.item.id}`

  async function load() {
    loading = true
    error = ''
    try {
      list = await unwrap(client.GET('/api/v1/reports/broken', { params: { query: { library: library || undefined, status: statuses.length ? statuses : undefined } } }))
      chosen = chosen.filter((k) => list.some((r) => key(r) === k))
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void library
    void statuses.length
    void load()
  })

  function byLibrary(rows: ItemWithPath[]): Map<string, ItemWithPath[]> {
    const m = new Map<string, ItemWithPath[]>()
    for (const r of rows) m.set(r.library, [...(m.get(r.library) ?? []), r])
    return m
  }
  const selectedRows = $derived(list.filter((r) => chosen.includes(key(r))))
  const redirectable = $derived(selectedRows.filter((r) => r.item.health?.finalUrl && r.item.health.finalUrl !== r.item.url))

  async function perLibrary(rows: ItemWithPath[], op: (r: ItemWithPath) => BatchOp) {
    for (const [slug, rs] of byLibrary(rows)) {
      await unwrap(client.POST('/api/v1/libraries/{slug}/items/batch', { params: { path: { slug } }, body: { ops: rs.map(op) } }))
      void loadTree(slug)
    }
    void refreshLibraries()
  }

  async function del() {
    const rows = selectedRows
    if (!(await confirmDialog({ title: t('broken.deleteTitle', { n: rows.length }), confirmLabel: t('menu.delete'), danger: true }))) return
    try {
      await perLibrary(rows, (r) => ({ op: 'delete', id: r.item.id }))
      toast(t('manager.deletedMany', { n: rows.length }), { kind: 'success' })
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  async function useFinal() {
    const rows = redirectable
    try {
      await perLibrary(rows, (r) => ({ op: 'update', id: r.item.id, url: r.item.health!.finalUrl! }))
      toast(t('broken.updated', { n: rows.length }), { kind: 'success' })
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  async function recheck() {
    try {
      for (const [slug, rs] of byLibrary(selectedRows)) {
        await unwrap(client.POST('/api/v1/reports/broken/recheck', { body: { library: slug, itemIds: rs.map((r) => r.item.id) } }))
      }
      toast(t('broken.queued'), { kind: 'success' })
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }
</script>

<div class="page">
  <div class="toolbar">
    <a class="icon-btn" href="/settings" aria-label={t('common.back')}><Icon name="arrowLeft" /></a>
    <h1>{t('broken.title')}</h1>
  </div>
  <div class="toolbar">
    {#each ALL as s (s)}
      <label class="chip" class:on={statuses.includes(s)}><input type="checkbox" class="sr-only" bind:group={statuses} value={s} />{t(`health.${s}`)}</label>
    {/each}
    {#if app.libraries.length > 1}
      <select bind:value={library} aria-label={t('field.library')}>
        <option value="">{t('search.allLibraries')}</option>
        {#each app.libraries as l (l.slug)}<option value={l.slug}>{l.name}</option>{/each}
      </select>
    {/if}
  </div>
  <div class="toolbar">
    <button class="btn small" onclick={() => (chosen = chosen.length === list.length ? [] : list.map(key))} disabled={!list.length}>{t('manager.selectAll')}</button>
    <span class="hint">{t('manager.selected', { n: chosen.length })}</span>
    <div class="spacer"></div>
    <button class="btn small" onclick={recheck} disabled={!chosen.length}><Icon name="sync" size={15} />{t('broken.recheck')}</button>
    <button class="btn small" onclick={useFinal} disabled={!redirectable.length} data-testid="use-final"><Icon name="link" size={15} />{t('broken.useFinal', { n: redirectable.length })}</button>
    <button class="btn small danger" onclick={del} disabled={!chosen.length} data-testid="broken-delete"><Icon name="trash" size={15} />{t('menu.delete')}</button>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
  <table class="list" data-testid="broken-list">
    <tbody>
      {#each list as r (key(r))}
        {@const h = r.item.health}
        <tr data-testid="broken-row">
          <td><input type="checkbox" bind:group={chosen} value={key(r)} aria-label={r.item.title} /></td>
          <td><Favicon item={r.item} /></td>
          <td class="main">
            <BookmarkLink item={r.item} library={r.library}>{r.item.title || r.item.url}</BookmarkLink>
            <div class="hint ellipsis">{r.item.url}</div>
            {#if h?.finalUrl && h.finalUrl !== r.item.url}<div class="hint ellipsis">→ {h.finalUrl}</div>{/if}
            <div class="hint">{r.library} / {r.path.join(' / ')}</div>
          </td>
          <td>
            <span class="badge" class:danger={h?.status === 'broken' || h?.status === 'unreachable'} class:warn={h?.status === 'redirect'}>{h ? t(`health.${h.status}`) : '—'}</span>
            {#if h?.httpStatus}<span class="hint">{h.httpStatus}</span>{/if}
            {#if h?.error}<div class="hint">{h.error}</div>{/if}
          </td>
          <td class="hint">{fmtRelative(h?.checkedAt)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !loading && !list.length && !error}<p class="hint">{t('broken.empty')}</p>{/if}
</div>

<style>
  .toolbar h1 {
    margin: 0;
  }
  .main {
    max-width: 520px;
    min-width: 0;
  }
  .main .ellipsis {
    max-width: 480px;
  }
  @media (max-width: 699px) {
    td:last-child {
      display: none;
    }
    .main .ellipsis {
      max-width: 200px;
    }
  }
</style>
