<script lang="ts">
  import type { StartPage, StartSection } from '../../api/types'
  import Dialog from '../../components/Dialog.svelte'
  import FolderPicker from '../../components/FolderPicker.svelte'
  import Icon from '../../components/Icon.svelte'
  import { t } from '../../lib/i18n/index.svelte'
  import { app, defaultLibrary, errorText, saveSettings } from '../../lib/stores/app.svelte'
  import { loadTree, treeEntry } from '../../lib/stores/trees.svelte'
  import { toast } from '../../lib/toast.svelte'

  let sp = $state<StartPage>(structuredClone($state.snapshot(app.settings!.startPage)))
  let adding = $state<null | { library: string; folderId: number | null }>(null)

  $effect(() => {
    for (const s of sp.sections) void loadTree(s.library)
  })

  function where(s: StartSection): string {
    const lib = app.libraries.find((l) => l.slug === s.library)?.name ?? s.library
    if (s.folderId === 0) return lib
    const n = treeEntry(s.library).index?.byId.get(s.folderId)
    return n ? [lib, ...n.path, n.item.title].join(' / ') : `${lib} / #${s.folderId}`
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= sp.sections.length) return
    const arr = sp.sections
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }

  function add(e: Event) {
    e.preventDefault()
    if (!adding) return
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 's' + Date.now().toString(36)
    sp.sections.push({ id, library: adding.library, folderId: adding.folderId ?? 0, title: null, layout: 'grid', collapsed: false })
    adding = null
  }

  async function save() {
    try {
      await saveSettings({ startPage: $state.snapshot(sp) })
      toast(t('common.saved'), { kind: 'success' })
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }
</script>

<div class="card">
  <h2>{t('sp.general')}</h2>
  <label class="field inline"><input type="checkbox" bind:checked={sp.showSearch} /><span>{t('sp.showSearch')}</span></label>
  <div class="row">
    <label class="field inline"><input type="checkbox" bind:checked={sp.showRecent} /><span>{t('sp.showRecent')}</span></label>
    <input type="number" min="1" max="50" bind:value={sp.recentCount} aria-label={t('sp.count')} class="num" />
  </div>
  <div class="row">
    <label class="field inline"><input type="checkbox" bind:checked={sp.showFrequent} /><span>{t('sp.showFrequent')}</span></label>
    <input type="number" min="1" max="50" bind:value={sp.frequentCount} aria-label={t('sp.count')} class="num" />
  </div>
</div>

<div class="card">
  <div class="row">
    <h2 class="spacer">{t('sp.sections')}</h2>
    <button class="btn" onclick={() => (adding = { library: defaultLibrary() ?? 'bookmarks', folderId: 0 })} data-testid="add-section"><Icon name="plus" size={16} />{t('sp.add')}</button>
  </div>
  {#if !sp.sections.length}<p class="hint">{t('sp.none')}</p>{/if}
  <ul class="sections" data-testid="section-list">
    {#each sp.sections as s, i (s.id)}
      <li data-testid="section-row">
        <div class="where"><Icon name="folder" size={16} /> {where(s)}</div>
        <div class="row">
          <input placeholder={t('sp.titlePlaceholder')} value={s.title ?? ''} oninput={(e) => (s.title = (e.currentTarget as HTMLInputElement).value || null)} aria-label={t('field.title')} />
          <select bind:value={s.layout} aria-label={t('sp.layout')}>
            <option value="grid">{t('sp.grid')}</option>
            <option value="list">{t('sp.list')}</option>
          </select>
          <label class="row"><input type="checkbox" bind:checked={s.collapsed} />{t('sp.collapsed')}</label>
          <div class="spacer"></div>
          <button class="icon-btn" aria-label={t('sp.up')} onclick={() => move(i, -1)} disabled={i === 0}><Icon name="up" size={16} /></button>
          <button class="icon-btn" aria-label={t('sp.down')} onclick={() => move(i, 1)} disabled={i === sp.sections.length - 1}><Icon name="chevron-down" size={16} /></button>
          <button class="icon-btn" aria-label={t('menu.delete')} onclick={() => sp.sections.splice(i, 1)}><Icon name="trash" size={16} /></button>
        </div>
      </li>
    {/each}
  </ul>
</div>
<div class="row">
  <button class="btn primary" onclick={save} data-testid="save-startpage">{t('common.save')}</button>
  <a class="btn" href="/">{t('sp.preview')}</a>
</div>

{#if adding}
  <Dialog title={t('sp.add')} onclose={() => (adding = null)} testid="section-dialog">
    <form id="sec-form" onsubmit={add}>
      <FolderPicker bind:library={adding.library} bind:folderId={adding.folderId} />
    </form>
    {#snippet footer()}
      <button class="btn" onclick={() => (adding = null)}>{t('common.cancel')}</button>
      <button class="btn primary" type="submit" form="sec-form">{t('sp.addThis')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .num {
    width: 80px;
    margin-bottom: 12px;
  }
  .sections {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sections li {
    border-top: 1px solid var(--border);
    padding: 10px 0;
  }
  .where {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .where :global(.icon) {
    color: var(--folder);
  }
</style>
