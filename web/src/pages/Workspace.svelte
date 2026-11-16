<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { client, unwrap } from '../api'
  import { ApiError } from '../api/client'
  import type { BatchOp, Item } from '../api/types'
  import AiOrganizeDialog from '../components/AiOrganizeDialog.svelte'
  import BookmarkBar from '../components/BookmarkBar.svelte'
  import Breadcrumbs from '../components/Breadcrumbs.svelte'
  import BulkDialog from '../components/BulkDialog.svelte'
  import FolderTree from '../components/FolderTree.svelte'
  import Icon from '../components/Icon.svelte'
  import ItemDialog, { type ItemDraft } from '../components/ItemDialog.svelte'
  import ItemRow, { type ItemPatch } from '../components/ItemRow.svelte'
  import SaveSheet from '../components/SaveSheet.svelte'
  import SearchResults from '../components/SearchResults.svelte'
  import { planMove, planNudge, planRecreate, type DropTarget } from '../lib/dnd'
  import type { DragSourceOptions } from '../lib/dragdrop'
  import { dragSource } from '../lib/dragdrop'
  import { fmtRelative, t } from '../lib/i18n/index.svelte'
  import { confirmDialog, openMenu, promptDialog, type MenuItem } from '../lib/overlay.svelte'
  import { navigate, router } from '../lib/router.svelte'
  import { useShortcuts } from '../lib/shortcuts'
  import { app, defaultLibrary, errorText, opensInNewTab, refreshLibraries } from '../lib/stores/app.svelte'
  import { loadTree, treeEntry } from '../lib/stores/trees.svelte'
  import { rememberFolder, startFolder, workspace } from '../lib/stores/workspace.svelte'
  import { toast } from '../lib/toast.svelte'
  import { childrenOf, isAncestorOrSelf, outlineRows, topLevelOnly, type Row } from '../lib/tree'
  import { recordVisit } from '../lib/visits'

  let { params, query }: { params: Record<string, string>; query: URLSearchParams } = $props()

  const start = $derived(startFolder())
  const slug = $derived(params.slug ?? start?.library ?? '')
  const folderId = $derived(params.folderId ? Number(params.folderId) : params.slug ? 0 : (start?.folderId ?? 0))

  $effect(() => {
    if (router.current.path === '/lib') {
      const d = defaultLibrary()
      if (d) navigate(`/lib/${d}`, { replace: true })
    } else if (router.current.path === '/add') {
      navigate('/share' + location.search, { replace: true })
    }
  })

  $effect(() => {
    if (!slug || !router.current.path.startsWith('/lib')) return
    const last = workspace.last
    if (last?.library === slug && last.folderId === folderId) return
    rememberFolder(slug, folderId)
  })

  const entry = $derived(slug ? treeEntry(slug) : null)
  const idx = $derived(entry?.index ?? null)
  const lib = $derived(app.libraries.find((l) => l.slug === slug))
  const readonly = $derived(!app.online || !!entry?.stale)
  const folderNode = $derived(folderId && idx ? idx.byId.get(folderId) : null)
  const items = $derived(idx ? childrenOf(idx, folderId) : [])

  let q = $state('')
  let searchMode = $state(false)
  let returnFolder = $state<{ library: string; folderId: number } | null>(null)
  let saveOpen = $state(false)
  let saveInit = $state({ url: '', title: '', text: '', library: '', folderId: null as number | null })
  let searchOpen = $state(false)
  let headH = $state(0)

  // 路由变化：搜索/分享进入对应模式，普通文件夹退出。
  $effect(() => {
    const path = router.current.path
    if (path === '/search') {
      searchMode = true
      q = query.get('q') ?? ''
    } else if (path === '/share') {
      searchMode = false
      saveInit = {
        url: query.get('url') ?? '',
        title: query.get('title') ?? '',
        text: query.get('text') ?? '',
        library: app.settings?.defaultSave?.library ?? start?.library ?? '',
        folderId: app.settings?.defaultSave?.folderId ?? null,
      }
      saveOpen = true
    } else {
      searchMode = false
      q = ''
    }
  })

  const selected = new SvelteSet<number>()
  let cursor = $state(-1)
  let anchor: number | null = null
  let editing = $state<number | null>(null)
  let dialog = $state<
    | { kind: 'new'; type: 'bookmark' | 'folder' }
    | { kind: 'edit'; item: Item }
    | { kind: 'move' | 'tag'; ids: number[] }
    | { kind: 'ai' }
    | null
  >(null)

  // 文件夹树展开状态（按库记在 localStorage）
  const expanded = new SvelteSet<number>()
  $effect(() => {
    expanded.clear()
    try {
      for (const id of JSON.parse(localStorage.getItem(`shelfmark.expanded.${slug}`) ?? '[]')) expanded.add(id)
    } catch {
      /* ignore */
    }
  })
  $effect(() => {
    if (folderNode) for (const p of [...folderNode.pathIds, folderId]) expanded.add(p)
  })
  $effect(() => {
    const ids = [...expanded]
    localStorage.setItem(`shelfmark.expanded.${slug}`, JSON.stringify(ids))
  })

  // 列表是大纲视图：展开的子文件夹就地展开，展开状态和侧栏树共用。筛选时只看当前文件夹的直接子项。
  const rows = $derived.by((): Row[] => {
    if (searchMode || !idx) return []
    const s = q.trim().toLowerCase()
    if (!s) return outlineRows(idx, folderId, expanded)
    return items
      .filter((i) => [i.title, i.url ?? '', i.tags.join(' '), i.notes ?? ''].join(' ').toLowerCase().includes(s))
      .map((item) => ({ item, depth: 0 }))
  })
  const selecting = $derived(selected.size > 0)

  function toggleExpand(id: number) {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
  }

  // 选择栏浮在底部时，把提示条也往上推
  $effect(() => {
    document.documentElement.style.setProperty('--bottom-nav-h', selecting && !searchMode ? '56px' : '0px')
    return () => document.documentElement.style.removeProperty('--bottom-nav-h')
  })

  $effect(() => {
    if (slug) void loadTree(slug)
  })
  // 上次文件夹被删了：回库根，避免停在空内容上。
  $effect(() => {
    if (!idx || !folderId || router.current.path !== '/') return
    if (!idx.byId.get(folderId)) navigate(`/lib/${slug}`, { replace: true })
  })
  $effect(() => {
    void folderId
    selected.clear()
    cursor = -1
    editing = null
  })
  $effect(() => {
    const onRefresh = () => slug && void loadTree(slug)
    window.addEventListener('sm:refresh', onRefresh)
    return () => window.removeEventListener('sm:refresh', onRefresh)
  })

  // ---------- 写操作 ----------

  async function write<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (readonly) {
      toast(t('manager.readonly'), { kind: 'warn' })
      return undefined
    }
    try {
      const r = await fn()
      await loadTree(slug)
      void refreshLibraries()
      return r
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
      if (e instanceof ApiError && e.code === 'locked') void refreshLibraries()
      await loadTree(slug)
      return undefined
    }
  }

  const batch = (ops: BatchOp[]) => write(() => unwrap(client.POST('/api/v1/libraries/{slug}/items/batch', { params: { path: { slug } }, body: { ops } })))

  async function moveTo(ids: number[], target: DropTarget) {
    if (!idx) return
    const ops = planMove(idx, ids, target)
    if (ops === null) return toast(t('manager.badMove'), { kind: 'warn' })
    if (!ops.length) return
    if (await batch(ops)) {
      selected.clear()
      toast(t('manager.moved', { n: ops.length }), { kind: 'success' })
    }
  }

  async function remove(ids: number[]) {
    if (!idx || !ids.length) return
    const top = topLevelOnly(idx, ids)
    const recreate = planRecreate(idx, top)
    const label = top.length === 1 ? idx.byId.get(top[0])!.item.title : String(top.length)
    if (!(await batch(top.map((id) => ({ op: 'delete' as const, id }))))) return
    selected.clear()
    editing = null
    toast(top.length === 1 ? t('manager.deletedOne', { title: label }) : t('manager.deletedMany', { n: top.length }), {
      action: {
        label: t('common.undo'),
        run: async () => {
          if (await batch(recreate)) toast(t('manager.undone'), { kind: 'success' })
        },
      },
      timeout: 8000,
    })
  }

  async function create(d: ItemDraft): Promise<boolean> {
    const body = { type: d.type, title: d.title || d.url, parentId: d.parentId, ...(d.type === 'bookmark' ? { url: d.url, tags: d.tags, notes: d.notes || undefined } : {}) }
    const r = await write(() => unwrap(client.POST('/api/v1/libraries/{slug}/items', { params: { path: { slug } }, body })))
    if (r) toast(t('manager.created', { title: r.item.title }), { kind: 'success' })
    return !!r
  }

  async function update(id: number, body: { title?: string; url?: string; tags?: string[]; notes?: string | null }): Promise<boolean> {
    return !!(await write(() => unwrap(client.PATCH('/api/v1/libraries/{slug}/items/{itemId}', { params: { path: { slug, itemId: id } }, body }))))
  }

  async function newFolder() {
    const name = await promptDialog({ title: t('item.newFolder'), input: { label: t('field.title'), placeholder: t('item.folderPlaceholder') }, confirmLabel: t('common.create') })
    if (name) await create({ type: 'folder', title: name, url: '', tags: [], notes: '', parentId: folderId })
  }

  function toggleSearch() {
    searchOpen = !searchOpen
    if (searchOpen) queueMicrotask(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.focus())
    else if (searchMode) exitSearch()
    else q = ''
  }

  function submitSearch() {
    const s = q.trim()
    if (!s) return
    returnFolder = { library: slug, folderId }
    navigate('/search?q=' + encodeURIComponent(s))
  }

  function exitSearch() {
    const r = returnFolder ?? { library: slug, folderId }
    q = ''
    searchOpen = false
    navigate(r.folderId ? `/lib/${r.library}/f/${r.folderId}` : `/lib/${r.library}`)
  }

  function openSave() {
    saveInit = { url: '', title: '', text: '', library: slug, folderId }
    saveOpen = true
  }

  function closeSave() {
    saveOpen = false
    if (router.current.path === '/share') navigate(folderId ? `/lib/${slug}/f/${folderId}` : `/lib/${slug}`, { replace: true })
  }

  function onSaved() {
    void loadTree(slug)
    void refreshLibraries()
  }

  function newMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    openMenu(r.left, r.bottom + 4, [
      { label: t('manager.newBookmark'), icon: 'bookmark-plus', disabled: readonly, run: openSave },
      { label: t('manager.newFolder'), icon: 'folder', disabled: readonly, run: () => void newFolder() },
    ])
  }

  function goUp() {
    if (folderNode) navigate(folderNode.parentId ? `/lib/${slug}/f/${folderNode.parentId}` : `/lib/${slug}`)
  }

  async function rename(it: Item) {
    const name = await promptDialog({ title: t('item.rename'), input: { label: t('field.title'), value: it.title }, confirmLabel: t('common.save') })
    if (name && name !== it.title) await update(it.id, { title: name })
  }

  async function forceUnlock() {
    const ok = await confirmDialog({ title: t('lock.forceTitle'), message: t('lock.forceMessage', { actor: lib?.lock?.actor ?? '' }), confirmLabel: t('lock.force'), danger: true })
    if (!ok) return
    try {
      await unwrap(client.POST('/api/v1/libraries/{slug}/lock/release', { params: { path: { slug } } }))
      toast(t('lock.released'), { kind: 'success' })
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
    void refreshLibraries()
  }

  // ---------- 选择、编辑 ----------

  function dragIds(id: number): number[] {
    return selected.has(id) ? [...selected] : [id]
  }

  function dragOpts(id: number): DragSourceOptions {
    return {
      ids: () => dragIds(id),
      label: () => {
        const ids = dragIds(id)
        return ids.length > 1 ? t('manager.dragMany', { n: ids.length }) : (idx?.byId.get(id)?.item.title ?? '')
      },
      onDrop: (target, ids) => void moveTo(ids, target),
      accept: (target, ids) => {
        if (!idx) return false
        const dest = target.zone === 'inside' ? target.id : (idx.byId.get(target.id)?.parentId ?? 0)
        return !ids.some((x) => x === target.id || (dest !== 0 && isAncestorOrSelf(idx, x, dest)))
      },
      disabled: () => readonly || editing !== null,
    }
  }

  function toggleSelect(id: number, e: MouseEvent) {
    const list = rows.map((r) => r.item.id)
    if (e.shiftKey && anchor !== null) {
      const a = list.indexOf(anchor)
      const b = list.indexOf(id)
      if (a !== -1 && b !== -1) for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(x)
    } else if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    anchor = id
  }

  function longPressSelect(id: number) {
    selected.add(id)
    anchor = id
  }

  function startEdit(it: Item) {
    if (readonly) return
    editing = it.id
  }

  async function saveEdit(id: number, body: ItemPatch) {
    if (Object.keys(body).length && !(await update(id, body))) return
    editing = null
  }

  function open(it: Item, newTab = false) {
    if (it.type === 'folder') return navigate(`/lib/${slug}/f/${it.id}`)
    if (!it.url) return
    recordVisit(slug, it.id)
    if (newTab || opensInNewTab()) window.open(it.url, '_blank', 'noopener')
    else location.assign(it.url)
  }

  function menuFor(it: Item): MenuItem[] {
    const ids = selected.has(it.id) && selected.size > 1 ? [...selected] : [it.id]
    const many = ids.length > 1
    const ro = readonly
    const inList = rows.some((r) => r.item.id === it.id)
    const items: MenuItem[] = []
    if (!many) {
      items.push({ label: t('menu.open'), icon: it.type === 'folder' ? 'folder-open' : 'link', run: () => open(it) })
      if (it.type === 'bookmark') {
        items.push({ label: t('menu.openNewTab'), icon: 'external', run: () => open(it, true) })
        items.push({ label: t('menu.copyUrl'), icon: 'copy', run: () => navigator.clipboard?.writeText(it.url ?? '').then(() => toast(t('common.copied'))) })
        if (inList) items.push({ label: t('menu.edit'), icon: 'edit', disabled: ro, run: () => startEdit(it) })
        items.push({ label: t('menu.editDetails'), icon: 'edit', disabled: ro, run: () => (dialog = { kind: 'edit', item: it }) })
      } else {
        items.push({ label: t('menu.rename'), icon: 'edit', disabled: ro, run: () => rename(it) })
        if (app.info?.features.ai) items.push({ label: t('menu.aiOrganize'), icon: 'sparkle', disabled: ro, run: () => navigate(`/lib/${slug}/f/${it.id}?ai=1`) })
      }
      items.push({ label: t('menu.moveUp'), icon: 'up', disabled: ro, run: () => idx && void batch(planNudge(idx, it.id, -1)) })
    }
    items.push({ label: many ? t('menu.moveManyTo', { n: ids.length }) : t('menu.moveTo'), icon: 'move', disabled: ro, run: () => (dialog = { kind: 'move', ids }) })
    items.push({ label: t('menu.tags'), icon: 'tag', disabled: ro, run: () => (dialog = { kind: 'tag', ids }) })
    items.push({ label: many ? t('menu.deleteMany', { n: ids.length }) : t('menu.delete'), icon: 'trash', danger: true, disabled: ro, run: () => remove(ids) })
    return items
  }

  function context(e: MouseEvent, it: Item) {
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.type === 'contextmenu' && e.clientX ? e.clientX : r.right - 190
    const y = e.type === 'contextmenu' && e.clientY ? e.clientY : r.bottom
    openMenu(x, y, menuFor(it))
  }

  function moreMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: MenuItem[] = [
      { label: t('nav.settings'), icon: 'settings', run: () => navigate('/settings') },
      { label: t('manager.history'), icon: 'history', run: () => navigate(`/history/${slug}`) },
      { label: t('manager.deletedItems'), icon: 'restore', run: () => navigate(`/deleted/${slug}`) },
      { label: t('pending.title'), icon: 'warn', run: () => navigate(`/history/${slug}`) },
      { label: t('manager.reportBroken'), icon: 'broken', run: () => navigate(`/reports/broken?library=${slug}`) },
      { label: t('manager.reportDuplicates'), icon: 'duplicate', run: () => navigate(`/reports/duplicates?library=${slug}`) },
      { label: t('manager.export'), icon: 'download', run: () => navigate('/settings/import-export') },
    ]
    if (app.info?.features.ai) items.splice(1, 0, { label: t('menu.aiOrganize'), icon: 'sparkle', disabled: readonly, run: () => (dialog = { kind: 'ai' }) })
    openMenu(r.left, r.bottom + 4, items)
  }

  // ?ai=1 打开 AI 整理
  $effect(() => {
    if (query.get('ai') === '1' && app.info?.features.ai && idx) {
      dialog = { kind: 'ai' }
      navigate(location.pathname, { replace: true })
    }
  })

  // ---------- 键盘 ----------

  function cursorItem(): Item | undefined {
    return rows[cursor]?.item
  }
  function selectAll(e: KeyboardEvent) {
    e.preventDefault()
    for (const r of rows) selected.add(r.item.id)
  }
  function focusRow() {
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  $effect(() =>
    useShortcuts({
      j: () => {
        cursor = Math.min(rows.length - 1, cursor + 1)
        focusRow()
      },
      k: () => {
        cursor = Math.max(0, cursor - 1)
        focusRow()
      },
      ArrowDown: (e) => {
        e.preventDefault()
        cursor = Math.min(rows.length - 1, cursor + 1)
        focusRow()
      },
      ArrowUp: (e) => {
        e.preventDefault()
        cursor = Math.max(0, cursor - 1)
        focusRow()
      },
      ArrowRight: () => {
        const it = cursorItem()
        if (it?.type === 'folder') expanded.add(it.id)
      },
      ArrowLeft: () => {
        const it = cursorItem()
        if (it?.type === 'folder') expanded.delete(it.id)
      },
      'Ctrl+a': selectAll,
      'Meta+a': selectAll,
      Enter: () => {
        const it = cursorItem()
        if (it) open(it)
      },
      e: () => {
        const it = cursorItem()
        if (it) startEdit(it)
      },
      x: () => {
        const it = cursorItem()
        if (it) selected.has(it.id) ? selected.delete(it.id) : selected.add(it.id)
      },
      Delete: () => {
        const ids = selected.size ? [...selected] : cursorItem() ? [cursorItem()!.id] : []
        void remove(ids)
      },
      n: () => !readonly && openSave(),
      Backspace: () => folderNode && navigate(folderNode.parentId ? `/lib/${slug}/f/${folderNode.parentId}` : `/lib/${slug}`),
      Escape: () => {
        if (searchMode) exitSearch()
        else if (editing !== null) editing = null
        else selected.clear()
      },
    }),
  )

  const syncTitle = $derived(
    lib ? `${lib.lastSyncAt ? t('sync.last', { actor: lib.lastSyncActor ?? '?', time: fmtRelative(lib.lastSyncAt) }) : t('sync.never')} · ${t('sync.counts', { b: lib.bookmarkCount, f: lib.folderCount })}${lib.pendingCount ? ' · ' + t('sync.pending', { n: lib.pendingCount }) : ''}` : '',
  )
  const dialogItems = $derived(
    dialog && (dialog.kind === 'move' || dialog.kind === 'tag') ? dialog.ids.map((id) => idx?.byId.get(id)?.item).filter((x): x is Item => !!x) : [],
  )
</script>

<div class="workspace" style:--wtop-h="{headH}px">
  <header class="wtop" bind:clientHeight={headH}>
    <div class="wtop-row">
      {#if folderId !== 0}
        <button class="icon-btn narrow-only" aria-label={t('common.back')} onclick={goUp}><Icon name="arrowLeft" /></button>
      {/if}
      <a class="brand wide-only" href="/lib/{slug}"><Icon name="bookmark" size={20} /><span>shelfmark</span></a>
      {#if idx}
        <Breadcrumbs {slug} name={lib?.name ?? slug} {idx} {folderId} />
      {:else}
        <span class="crumbs-ph">{lib?.name ?? slug}</span>
      {/if}
      <div class="spacer"></div>
      {#if lib}
        <a class="icon-btn wide-only sync-ic" class:warn={lib.pendingCount} href="/history/{slug}" title={syncTitle} aria-label={syncTitle} data-testid="sync-icon">
          <Icon name="sync" size={17} />
        </a>
      {/if}
      <button class="icon-btn narrow-only" class:on={searchOpen || searchMode} aria-label={t('nav.search')} onclick={toggleSearch} data-testid="search-toggle"><Icon name="search" /></button>
      <form class="wsearch" class:open={searchOpen || searchMode} role="search" onsubmit={(e) => { e.preventDefault(); if (!searchMode) submitSearch() }}>
        <Icon name="search" size={16} />
        <input
          bind:value={q}
          type="search"
          data-search-input
          placeholder={searchMode ? t('search.placeholder') : t('manager.filter')}
          aria-label={t('nav.search')}
          data-testid="workspace-search"
        />
        {#if searchMode}
          <button class="icon-btn" type="button" aria-label={t('common.cancel')} onclick={exitSearch}><Icon name="close" size={16} /></button>
        {:else if q.trim()}
          <button class="btn small" type="submit">{t('search.all')}</button>
        {/if}
      </form>
      <button class="btn primary new" onclick={newMenu} disabled={readonly} aria-label={t('manager.newBookmark')} data-testid="new-bookmark">
        <Icon name="plus" size={16} /><span class="wide-only">{t('manager.newBookmark')}</span>
      </button>
      <button class="icon-btn" aria-label={t('common.more')} onclick={moreMenu} data-testid="manager-more"><Icon name="more" /></button>
    </div>
    {#if idx && lib}
      <div class="wide-only"><BookmarkBar {slug} {idx} current={folderId} oncontext={context} /></div>
    {/if}
    {#if lib?.lock?.fresh || entry?.stale}
      <div class="status" data-testid="sync-status">
        {#if lib?.lock?.fresh}
          <span class="locked"><Icon name="lock" size={15} /> {t('lock.syncing', { actor: lib.lock.actor, time: fmtRelative(lib.lock.since) })}</span>
          <button class="btn small" onclick={forceUnlock} data-testid="force-unlock">{t('lock.force')}</button>
        {/if}
        {#if entry?.stale}<span class="badge">{t('manager.cached')}</span>{/if}
      </div>
    {/if}
  </header>

  {#if entry?.error && !idx}
    <p class="error-text">{entry.error}</p>
  {/if}

  {#if idx && lib}
    <div class="cols">
      <aside class="side wide-only" data-scroll-container>
        <FolderTree {slug} name={lib.name} {idx} current={folderId} {expanded} {readonly} drag={dragOpts} oncontext={context} />
      </aside>

      <section class="main">
        {#if searchMode}
          <SearchResults q={q} onback={exitSearch} />
        {:else}
          <div class="rows" role="list" data-testid="item-list">
            {#if !rows.length}
              <p class="hint empty">{q.trim() ? t('manager.noMatch') : t('manager.emptyFolder')}</p>
            {/if}
            {#each rows as r, i (r.item.id)}
              {@const it = r.item}
              <ItemRow
                item={it}
                {slug}
                depth={r.depth}
                index={i}
                count={it.type === 'folder' ? childrenOf(idx, it.id).length : 0}
                selected={selected.has(it.id)}
                {selecting}
                cursor={cursor === i}
                editing={editing === it.id}
                expanded={expanded.has(it.id)}
                {readonly}
                drag={dragOpts(it.id)}
                onselect={(e) => toggleSelect(it.id, e)}
                ontoggle={() => toggleExpand(it.id)}
                onmenu={(e) => context(e, it)}
                onsave={(patch) => void saveEdit(it.id, patch)}
                oncancel={() => (editing = null)}
                onlongpress={() => longPressSelect(it.id)}
              />
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {:else if entry?.loading}
    <p class="hint">{t('common.loading')}</p>
  {/if}
</div>

{#if selecting && !searchMode}
  <div class="selbar" role="toolbar" data-testid="selection-bar">
    <span class="n">{t('manager.selected', { n: selected.size })}</span>
    <button class="btn small ghost" onclick={() => rows.forEach((r) => selected.add(r.item.id))}>{t('manager.selectAll')}</button>
    <span class="spacer"></span>
    <button class="btn small" disabled={readonly} onclick={() => (dialog = { kind: 'move', ids: [...selected] })}><Icon name="move" size={15} /><span>{t('manager.moveTo')}</span></button>
    <button class="btn small" disabled={readonly} onclick={() => (dialog = { kind: 'tag', ids: [...selected] })}><Icon name="tag" size={15} /><span>{t('menu.tags')}</span></button>
    <button class="btn small" disabled={readonly} onclick={() => remove([...selected])} data-testid="bulk-delete"><Icon name="trash" size={15} /><span>{t('menu.delete')}</span></button>
    <button class="icon-btn" aria-label={t('common.cancel')} onclick={() => selected.clear()}><Icon name="close" size={16} /></button>
  </div>
{/if}

{#if saveOpen}
  <SaveSheet
    initialUrl={saveInit.url}
    initialTitle={saveInit.title}
    initialText={saveInit.text}
    initialLibrary={saveInit.library || slug}
    initialFolderId={saveInit.folderId}
    onclose={closeSave}
    onsaved={onSaved}
  />
{/if}

{#if dialog?.kind === 'new'}
  <ItemDialog {slug} mode="new" initial={{ type: dialog.type, parentId: folderId }} onsubmit={create} onclose={() => (dialog = null)} />
{:else if dialog?.kind === 'edit'}
  {@const it = dialog.item}
  <ItemDialog
    {slug}
    mode="edit"
    initial={it}
    onsubmit={(d) => update(it.id, { title: d.title, url: d.url || undefined, tags: d.tags, notes: d.notes || null })}
    onclose={() => (dialog = null)}
  />
{:else if dialog?.kind === 'move' || dialog?.kind === 'tag'}
  {@const ids = dialog.ids}
  <BulkDialog
    kind={dialog.kind}
    {slug}
    items={dialogItems}
    onmove={(fid) => moveTo(ids, { id: fid, zone: 'inside' })}
    ontag={(add, rm) => {
      if (add.length || rm.length) void batch(ids.map((id) => ({ op: 'tag' as const, id, add, remove: rm }))).then((r) => r && toast(t('manager.tagged'), { kind: 'success' }))
    }}
    onclose={() => (dialog = null)}
  />
{:else if dialog?.kind === 'ai'}
  <AiOrganizeDialog
    {slug}
    {folderId}
    onapply={async (ops) => {
      if (await batch(ops)) toast(t('ai.applied'), { kind: 'success' })
    }}
    onclose={() => (dialog = null)}
  />
{/if}

<style>
  .workspace {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 16px calc(40px + var(--bottom-nav-h));
  }
  .wtop {
    position: sticky;
    top: 0;
    z-index: 20;
    margin: 0 -16px;
    padding: 6px 16px 4px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .wtop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    color: var(--text);
    text-decoration: none;
    margin-right: 6px;
  }
  .brand :global(.icon) {
    color: var(--accent);
  }
  .crumbs-ph {
    color: var(--text-2);
    font-size: 0.92rem;
  }
  .sync-ic {
    position: relative;
    color: var(--text-3);
  }
  .sync-ic.warn::after {
    content: '';
    position: absolute;
    top: 6px;
    right: 6px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
  }
  .wsearch {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 180px;
    max-width: 340px;
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0 8px;
    color: var(--text-3);
  }
  .wsearch input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    min-height: 30px;
    padding: 4px 6px;
  }
  .wsearch input:focus {
    outline: none;
  }
  .new {
    min-height: 32px;
    padding: 4px 12px;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: var(--text-2);
    margin: 4px 0 2px;
  }
  .locked {
    color: var(--warn);
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .cols {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 12px;
    align-items: start;
    margin-top: 10px;
  }
  .side {
    position: sticky;
    top: calc(var(--wtop-h) + 10px);
    max-height: calc(100vh - var(--wtop-h) - 20px);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 4px;
  }
  .main {
    min-width: 0;
  }
  .rows {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 4px;
  }
  .empty {
    padding: 24px;
    text-align: center;
  }
  .selbar {
    position: fixed;
    z-index: 25;
    left: 50%;
    bottom: calc(10px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    width: min(640px, calc(100% - 20px));
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 6px 6px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .selbar .n {
    font-weight: 600;
    white-space: nowrap;
  }
  @media (max-width: 899px) {
    .workspace {
      padding: 0 8px calc(30px + var(--bottom-nav-h));
    }
    .wtop {
      margin: 0 -8px;
      padding: 4px 6px;
    }
    .wtop-row {
      flex-wrap: wrap;
      gap: 2px;
    }
    .wtop-row > :global(.crumbs),
    .crumbs-ph {
      flex: 1;
    }
    .wsearch {
      display: none;
      order: 10;
      flex-basis: 100%;
      max-width: none;
      min-width: 0;
      margin: 4px 2px 2px;
    }
    .wsearch.open {
      display: flex;
    }
    .icon-btn.on {
      color: var(--accent);
    }
    .new {
      width: 32px;
      min-height: 32px;
      padding: 0;
      margin: 0 2px;
    }
    .cols {
      grid-template-columns: 1fr;
      margin-top: 6px;
    }
    .rows {
      padding: 2px 4px;
    }
    .selbar {
      bottom: 0;
      width: 100%;
      border-radius: 0;
      border-width: 1px 0 0;
      padding: 6px 8px calc(6px + env(safe-area-inset-bottom)) 12px;
    }
    .selbar .btn span {
      display: none;
    }
  }
</style>
