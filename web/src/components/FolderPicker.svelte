<script lang="ts">
  import { untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { SaveTarget } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { app } from '../lib/stores/app.svelte'
  import { loadTree, treeEntry } from '../lib/stores/trees.svelte'
  import { folderList, hasSubfolders, isAncestorOrSelf, visibleFolders } from '../lib/tree'
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

  // 默认折叠：只显示根和第一层；选中的文件夹自动展开到它所在的位置。搜索时平铺显示。
  const open = new SvelteSet<number>()
  $effect(() => {
    void library
    untrack(() => open.clear())
  })
  $effect(() => {
    const n = folderId ? entry.index?.byId.get(folderId) : null
    if (n) untrack(() => n.pathIds.forEach((p) => open.add(p)))
  })

  const filtered = $derived.by(() => {
    const idx = entry.index
    if (!idx) return []
    const s = q.trim().toLowerCase()
    const allowed = folders.filter((f) => !exclude.some((x) => f.id !== 0 && isAncestorOrSelf(idx, x, f.id)))
    if (!s) return visibleFolders(idx, allowed, open)
    return allowed.filter((f) => f.path.join(' / ').toLowerCase().includes(s) || f.title.toLowerCase().includes(s))
  })

  function toggle(id: number) {
    if (open.has(id)) open.delete(id)
    else open.add(id)
  }

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
      {@const kids = !q && f.id !== 0 && !!entry.index && hasSubfolders(entry.index, f.id)}
      <div class="opt" class:on={folderId === f.id} style:padding-left="{q ? 4 : 4 + Math.max(0, f.depth - 1) * 16}px">
        {#if kids}
          <button
            type="button"
            class="tw"
            aria-label={open.has(f.id) ? t('tree.collapse') : t('tree.expand')}
            aria-expanded={open.has(f.id)}
            onclick={() => toggle(f.id)}
            data-testid="folder-toggle"
          >
            <Icon name={open.has(f.id) ? 'chevron-down' : 'chevron'} size={14} />
          </button>
        {:else if !q && f.id !== 0}
          <span class="tw" aria-hidden="true"></span>
        {/if}
        <button type="button" class="pick" role="option" aria-selected={folderId === f.id} onclick={() => (folderId = f.id)} data-testid="folder-option">
          <Icon name={f.id === 0 ? 'library' : 'folder'} size={16} />
          <span>{q && f.path.length > 1 ? f.path.join(' / ') : f.title}</span>
        </button>
      </div>
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
  .list > button,
  .pick {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .opt {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .pick {
    flex: 1;
    min-width: 0;
  }
  .list > button:hover,
  .opt:hover {
    background: var(--hover);
  }
  .list > button.on,
  .opt.on {
    background: var(--accent-soft);
  }
  .list > button.on,
  .opt.on .pick {
    color: var(--accent-text);
    font-weight: 600;
  }
  .tw {
    flex: none;
    width: 22px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  button.tw:hover {
    color: var(--text);
  }
  .tw :global(.icon) {
    color: inherit !important;
  }
  @media (hover: none) {
    .tw {
      width: 32px;
      height: 36px;
    }
  }
  .list :global(.icon) {
    color: var(--folder);
  }
  .pad {
    padding: 8px;
  }
</style>
