<script lang="ts">
  import type { SaveTarget } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { app } from '../lib/stores/app.svelte'
  import { loadTree, treeEntry } from '../lib/stores/trees.svelte'
  import { folderList, isAncestorOrSelf } from '../lib/tree'
  import Icon from './Icon.svelte'

  let {
    library = $bindable(),
    folderId = $bindable(),
    libraryLocked = false,
    inboxOption = false,
    recent = [],
    exclude = [],
  }: {
    library: string
    folderId: number | null
    libraryLocked?: boolean
    /** 允许“默认位置”（不指定文件夹，交给服务端决定） */
    inboxOption?: boolean
    recent?: SaveTarget[]
    /** 不能选的文件夹（及其子孙），如移动文件夹时的自身 */
    exclude?: number[]
  } = $props()

  let q = $state('')
  const entry = $derived(treeEntry(library))
  $effect(() => {
    void loadTree(library)
  })
  const folders = $derived(entry.index ? folderList(entry.index, t('folder.root')) : [])
  const filtered = $derived.by(() => {
    const s = q.trim().toLowerCase()
    return folders.filter((f) => {
      if (entry.index && exclude.some((x) => f.id !== 0 && isAncestorOrSelf(entry.index!, x, f.id))) return false
      return !s || f.path.join(' / ').toLowerCase().includes(s) || f.title.toLowerCase().includes(s)
    })
  })

  function label(tg: SaveTarget): string {
    const lib = app.libraries.find((l) => l.slug === tg.library)
    const e = treeEntry(tg.library)
    const n = e.index?.byId.get(tg.folderId)
    const path = tg.folderId === 0 ? t('folder.root') : n ? [...n.path, n.item.title].join(' / ') : `#${tg.folderId}`
    return `${lib?.name ?? tg.library} · ${path}`
  }

  const recentShown = $derived(recent.filter((r) => !libraryLocked || r.library === library).slice(0, 5))
  $effect(() => {
    for (const r of recentShown) if (r.library !== library) void loadTree(r.library)
  })
</script>

<div class="picker">
  {#if !libraryLocked && app.libraries.length > 1}
    <label class="field">
      <span>{t('field.library')}</span>
      <select
        bind:value={library}
        onchange={() => (folderId = inboxOption ? null : 0)}
        data-testid="picker-library"
      >
        {#each app.libraries as l (l.slug)}<option value={l.slug}>{l.name}</option>{/each}
      </select>
    </label>
  {/if}

  {#if recentShown.length}
    <div class="recent">
      <span class="hint">{t('picker.recent')}</span>
      {#each recentShown as r (r.library + ':' + r.folderId)}
        <button
          type="button"
          class="chip"
          class:on={r.library === library && r.folderId === folderId}
          onclick={() => {
            library = r.library
            folderId = r.folderId
          }}>{label(r)}</button
        >
      {/each}
    </div>
  {/if}

  <input class="filter" type="search" placeholder={t('picker.filter')} bind:value={q} data-testid="picker-filter" />
  <div class="list" role="listbox" aria-label={t('field.folder')}>
    {#if inboxOption && !q}
      <button type="button" role="option" aria-selected={folderId === null} class:on={folderId === null} onclick={() => (folderId = null)}>
        <Icon name="star" size={16} /><span>{t('picker.default')}</span>
      </button>
    {/if}
    {#each filtered as f (f.id)}
      <button
        type="button"
        role="option"
        aria-selected={folderId === f.id}
        class:on={folderId === f.id}
        style:padding-left="{q ? 10 : 10 + f.depth * 16}px"
        onclick={() => (folderId = f.id)}
        data-testid="folder-option"
      >
        <Icon name={f.id === 0 ? 'library' : 'folder'} size={16} />
        <span>{q && f.path.length > 1 ? f.path.join(' / ') : f.title}</span>
      </button>
    {/each}
    {#if entry.loading && !folders.length}<p class="hint pad">{t('common.loading')}</p>{/if}
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .filter {
    width: 100%;
  }
  .list {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px;
  }
  .list button {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .list button:hover {
    background: var(--hover);
  }
  .list button.on {
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
  }
  .list :global(.icon) {
    color: var(--folder);
  }
  .pad {
    padding: 8px;
  }
</style>
