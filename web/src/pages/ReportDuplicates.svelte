<script lang="ts">
  import { client, unwrap } from '../api'
  import type { DuplicateGroup, ItemWithPath } from '../api/types'
  import BookmarkLink from '../components/BookmarkLink.svelte'
  import Icon from '../components/Icon.svelte'
  import { fmtDateTime, t } from '../lib/i18n/index.svelte'
  import { confirmDialog } from '../lib/overlay.svelte'
  import { app, errorText, refreshLibraries } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { toast } from '../lib/toast.svelte'

  let { query }: { params: Record<string, string>; query: URLSearchParams } = $props()

  let library = $state(query.get('library') ?? '')
  let groups = $state<DuplicateGroup[]>([])
  let keep = $state<Record<string, string>>({})
  let loading = $state(false)
  let error = $state('')

  const key = (r: ItemWithPath) => `${r.library}:${r.item.id}`

  async function load() {
    loading = true
    error = ''
    try {
      groups = await unwrap(client.GET('/api/v1/reports/duplicates', { params: { query: { library: library || undefined } } }))
      // 默认保留访问最多、其次最早创建的
      const k: Record<string, string> = {}
      for (const g of groups) {
        const best = [...g.items].sort((a, b) => b.item.visitCount - a.item.visitCount || a.item.createdAt.localeCompare(b.item.createdAt))[0]
        k[g.normalizedUrl] = key(best)
      }
      keep = k
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void library
    void load()
  })

  async function resolve(gs: DuplicateGroup[]) {
    const victims = gs.flatMap((g) => g.items.filter((r) => key(r) !== keep[g.normalizedUrl]))
    if (!victims.length) return
    if (!(await confirmDialog({ title: t('dup.confirm', { n: victims.length }), confirmLabel: t('menu.delete'), danger: true }))) return
    try {
      const by = new Map<string, number[]>()
      for (const v of victims) by.set(v.library, [...(by.get(v.library) ?? []), v.item.id])
      for (const [slug, ids] of by) {
        await unwrap(client.POST('/api/v1/libraries/{slug}/items/batch', { params: { path: { slug } }, body: { ops: ids.map((id) => ({ op: 'delete' as const, id })) } }))
        void loadTree(slug)
      }
      toast(t('manager.deletedMany', { n: victims.length }), { kind: 'success' })
      void refreshLibraries()
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }
</script>

<div class="page narrow">
  <div class="toolbar">
    <a class="icon-btn" href="/settings" aria-label={t('common.back')}><Icon name="arrowLeft" /></a>
    <h1>{t('dup.title')}</h1>
    <div class="spacer"></div>
    {#if app.libraries.length > 1}
      <select bind:value={library} aria-label={t('field.library')}>
        <option value="">{t('dup.allLibraries')}</option>
        {#each app.libraries as l (l.slug)}<option value={l.slug}>{l.name}</option>{/each}
      </select>
    {/if}
    <button class="btn danger small" disabled={!groups.length} onclick={() => resolve(groups)} data-testid="dup-resolve-all">{t('dup.resolveAll')}</button>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
  {#each groups as g (g.normalizedUrl)}
    <div class="card" data-testid="dup-group">
      <div class="row head">
        <code class="ellipsis">{g.normalizedUrl}</code>
        <div class="spacer"></div>
        <button class="btn small" onclick={() => resolve([g])}>{t('dup.resolve')}</button>
      </div>
      {#each g.items as r (key(r))}
        <label class="opt">
          <input type="radio" name={g.normalizedUrl} value={key(r)} bind:group={keep[g.normalizedUrl]} />
          <div class="body">
            <BookmarkLink item={r.item} library={r.library}>{r.item.title || r.item.url}</BookmarkLink>
            <div class="hint">{app.libraries.find((l) => l.slug === r.library)?.name ?? r.library} / {r.path.join(' / ') || t('folder.root')} · {fmtDateTime(r.item.createdAt)} · {t('dup.visits', { n: r.item.visitCount })}</div>
          </div>
          {#if keep[g.normalizedUrl] === key(r)}<span class="badge">{t('dup.keep')}</span>{/if}
        </label>
      {/each}
    </div>
  {/each}
  {#if !loading && !groups.length && !error}<p class="hint">{t('dup.empty')}</p>{/if}
</div>

<style>
  .toolbar h1 {
    margin: 0;
  }
  .head {
    margin-bottom: 6px;
  }
  .head code {
    max-width: 70%;
    color: var(--text-3);
  }
  .opt {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 0;
    border-top: 1px dashed var(--border);
  }
  .body {
    flex: 1;
    min-width: 0;
  }
</style>
