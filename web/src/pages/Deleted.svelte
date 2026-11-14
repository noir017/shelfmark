<script lang="ts">
  import { client, unwrap } from '../api'
  import type { DeletedEntry } from '../api/types'
  import Icon from '../components/Icon.svelte'
  import { fmtDateTime, t } from '../lib/i18n/index.svelte'
  import { app, errorText, refreshLibraries } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { toast } from '../lib/toast.svelte'

  let { params }: { params: Record<string, string>; query: URLSearchParams } = $props()
  const slug = params.slug

  let days = $state(30)
  let list = $state<DeletedEntry[]>([])
  let chosen = $state<string[]>([])
  let loading = $state(false)
  let error = $state('')

  const key = (e: DeletedEntry) => `${e.revision}:${e.item.id}`
  const lib = $derived(app.libraries.find((l) => l.slug === slug))

  async function load() {
    loading = true
    error = ''
    try {
      list = await unwrap(client.GET('/api/v1/libraries/{slug}/deleted', { params: { path: { slug }, query: { days } } }))
      chosen = []
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void days
    void load()
  })

  async function restore() {
    const entries = list.filter((e) => chosen.includes(key(e))).map((e) => ({ revision: e.revision, itemId: e.item.id }))
    if (!entries.length) return
    try {
      const r = await unwrap(client.POST('/api/v1/libraries/{slug}/deleted/restore', { params: { path: { slug } }, body: { entries } }))
      toast(t('deleted.restored', { n: r.restored }), { kind: 'success' })
      void loadTree(slug)
      void refreshLibraries()
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }
</script>

<div class="page narrow">
  <div class="toolbar">
    <a class="icon-btn" href="/lib/{slug}" aria-label={t('common.back')}><Icon name="arrowLeft" /></a>
    <h1>{t('deleted.title', { name: lib?.name ?? slug })}</h1>
  </div>
  <div class="toolbar">
    <label class="field inline">
      <span>{t('deleted.range')}</span>
      <select bind:value={days}>
        {#each [7, 30, 90, 365] as d (d)}<option value={d}>{t('deleted.days', { n: d })}</option>{/each}
      </select>
    </label>
    <div class="spacer"></div>
    <button class="btn" onclick={() => (chosen = chosen.length === list.length ? [] : list.map(key))} disabled={!list.length}>{t('manager.selectAll')}</button>
    <button class="btn primary" onclick={restore} disabled={!chosen.length} data-testid="restore-selected">
      <Icon name="restore" size={16} />{t('deleted.restore', { n: chosen.length })}
    </button>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
  <table class="list" data-testid="deleted-list">
    <tbody>
      {#each list as e (key(e))}
        <tr data-testid="deleted-row">
          <td><input type="checkbox" bind:group={chosen} value={key(e)} aria-label={e.item.title} /></td>
          <td>
            <div class="row">
              <Icon name={e.item.type === 'folder' ? 'folder' : 'link'} size={15} />
              <b>{e.item.title || e.item.url}</b>
              {#if e.item.type === 'folder' && e.item.childCount}<span class="badge">{t('diff.childCount', { n: e.item.childCount })}</span>{/if}
            </div>
            {#if e.item.url}<div class="hint ellipsis">{e.item.url}</div>{/if}
            <div class="hint">{e.item.path.join(' / ') || t('folder.root')}</div>
          </td>
          <td class="hint right">{fmtDateTime(e.deletedAt)}<br />{t(`source.${e.source}`)} · {e.actor}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !loading && !list.length && !error}<p class="hint">{t('deleted.empty')}</p>{/if}
</div>

<style>
  .toolbar h1 {
    margin: 0;
  }
  .right {
    text-align: right;
    white-space: nowrap;
  }
  td .ellipsis {
    max-width: 420px;
  }
</style>
