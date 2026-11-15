<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { client, unwrap } from '../api'
  import { ApiError } from '../api/client'
  import type { BatchOp, Item } from '../api/types'
  import AiOrganizeDialog from '../components/AiOrganizeDialog.svelte'
  import BookmarkLink from '../components/BookmarkLink.svelte'
  import BulkDialog from '../components/BulkDialog.svelte'
  import Dialog from '../components/Dialog.svelte'
  import Favicon from '../components/Favicon.svelte'
  import FolderTree from '../components/FolderTree.svelte'
  import Icon from '../components/Icon.svelte'
  import ItemDialog, { type ItemDraft } from '../components/ItemDialog.svelte'
  import SaveSheet from '../components/SaveSheet.svelte'
  import SearchResults from '../components/SearchResults.svelte'
  import { planMove, planNudge, planRecreate, type DropTarget } from '../lib/dnd'
  import type { DragSourceOptions } from '../lib/dragdrop'
  import { dragSource } from '../lib/dragdrop'
  import { fmtRelative, t } from '../lib/i18n/index.svelte'
  import { confirmDialog, openMenu, promptDialog, type MenuItem } from '../lib/overlay.svelte'
  import { navigate, router } from '../lib/router.svelte'
  import { useShortcuts } from '../lib/shortcuts'
  import { app, defaultLibrary, errorText, refreshLibraries } from '../lib/stores/app.svelte'
  import { loadTree, treeEntry } from '../lib/stores/trees.svelte'
  import { rememberFolder, startFolder, workspace } from '../lib/stores/workspace.svelte'
  import { parseTags } from '../lib/tags'
  import { toast } from '../lib/toast.svelte'
  import { childrenOf, isAncestorOrSelf, topLevelOnly } from '../lib/tree'
  import { hostOf } from '../lib/url'
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
  let treeOpen = $state(false)
  let treeAt = $state('')

  function openTree() {
    treeAt = `${slug}:${folderId}`
    treeOpen = true
  }

  $effect(() => {
    if (treeOpen && treeAt && treeAt !== `${slug}:${folderId}`) treeOpen = false
  })

  const shown = $derived.by(() => {
    if (searchMode) return []
    const s = q.trim().toLowerCase()
    if (!s) return items
    return items.filter((i) => [i.title, i.url ?? '', i.tags.join(' '), i.notes ?? ''].join(' ').toLowerCase().includes(s))
  })

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
  let editTitle = $state('')
  let editUrl = $state('')
  let editTags = $state('')
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

  function submitSearch() {
    const s = q.trim()
    if (!s) return
    returnFolder = { library: slug, folderId }
    navigate('/search?q=' + encodeURIComponent(s))
  }

  function exitSearch() {
    const r = returnFolder ?? { library: slug, folderId }
    q = ''
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
    const list = shown.map((i) => i.id)
    if (e.shiftKey && anchor !== null) {
      const a = list.indexOf(anchor)
      const b = list.indexOf(id)
      if (a !== -1 && b !== -1) for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(x)
    } else if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    anchor = id
  }

  function startEdit(it: Item) {
    if (readonly) return
    editing = it.id
    editTitle = it.title
    editUrl = it.url ?? ''
    editTags = it.tags.join(', ')
  }

  async function saveEdit(e?: Event) {
    e?.preventDefault()
    const id = editing
    if (id === null) return
    const it = idx?.byId.get(id)?.item
    if (!it) return
    const body: { title?: string; url?: string; tags?: string[] } = {}
    if (editTitle.trim() !== it.title) body.title = editTitle.trim()
    if (it.type === 'bookmark') {
      if (editUrl.trim() !== it.url) body.url = editUrl.trim()
      const tg = parseTags(editTags)
      if (tg.join(',') !== it.tags.join(',')) body.tags = tg
    }
    if (Object.keys(body).length && !(await update(id, body))) return
    editing = null
  }

  function open(it: Item, newTab = false) {
    if (it.type === 'folder') return navigate(`/lib/${slug}/f/${it.id}`)
    if (!it.url) return
    recordVisit(slug, it.id)
    if (newTab || app.settings?.openInNewTab) window.open(it.url, '_blank', 'noopener')
    else location.assign(it.url)
  }

  function menuFor(it: Item): MenuItem[] {
    const ids = selected.has(it.id) && selected.size > 1 ? [...selected] : [it.id]
    const many = ids.length > 1
    const ro = readonly
    const items: MenuItem[] = []
    if (!many) {
      items.push({ label: t('menu.open'), icon: it.type === 'folder' ? 'folder-open' : 'link', run: () => open(it) })
      if (it.type === 'bookmark') {
        items.push({ label: t('menu.openNewTab'), icon: 'external', run: () => open(it, true) })
        items.push({ label: t('menu.copyUrl'), icon: 'copy', run: () => navigator.clipboard?.writeText(it.url ?? '').then(() => toast(t('common.copied'))) })
        items.push({ label: t('menu.edit'), icon: 'edit', disabled: ro, run: () => startEdit(it) })
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
    return shown[cursor]
  }
  function focusRow() {
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  $effect(() =>
    useShortcuts({
      j: () => {
        cursor = Math.min(shown.length - 1, cursor + 1)
        focusRow()
      },
      k: () => {
        cursor = Math.max(0, cursor - 1)
        focusRow()
      },
      ArrowDown: (e) => {
        e.preventDefault()
        cursor = Math.min(shown.length - 1, cursor + 1)
        focusRow()
      },
      ArrowUp: (e) => {
        e.preventDefault()
        cursor = Math.max(0, cursor - 1)
        focusRow()
      },
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

  const selectedItems = $derived([...selected].map((id) => idx?.byId.get(id)?.item).filter((x): x is Item => !!x))
  const allChecked = $derived(shown.length > 0 && shown.every((i) => selected.has(i.id)))
  const dialogItems = $derived(
    dialog && (dialog.kind === 'move' || dialog.kind === 'tag') ? dialog.ids.map((id) => idx?.byId.get(id)?.item).filter((x): x is Item => !!x) : [],
  )
</script>

<div class="workspace">
  <header class="wtop">
    <div class="wtop-row">
      {#if folderId !== 0}
        <button class="icon-btn narrow-only" aria-label={t('common.back')} onclick={goUp}><Icon name="arrowLeft" /></button>
      {/if}
      <a class="brand wide-only" href="/lib/{slug}"><Icon name="bookmark" size={20} /><span>shelfmark</span></a>
      <nav class="crumbs" aria-label={t('manager.breadcrumb')}>
        <button class="icon-btn narrow-only" aria-label={t('tree.label')} onclick={openTree}><Icon name="folder" size={18} /></button>
        <a href="/lib/{slug}">{lib?.name ?? slug}</a>
        {#if folderNode}
          {#each folderNode.pathIds as pid, i (pid)}
            <Icon name="chevron" size={14} />
            <a href="/lib/{slug}/f/{pid}">{folderNode.path[i]}</a>
          {/each}
          <Icon name="chevron" size={14} />
          <span class="cur">{folderNode.item.title}</span>
        {/if}
      </nav>
      <div class="spacer"></div>
      <form class="wsearch" role="search" onsubmit={(e) => { e.preventDefault(); if (!searchMode) submitSearch() }}>
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
      <button class="btn primary" onclick={newMenu} disabled={readonly} data-testid="new-bookmark">
        <Icon name="plus" size={16} /><span class="wide-only">{t('manager.newBookmark')}</span>
      </button>
      <button class="icon-btn" aria-label={t('common.more')} onclick={moreMenu} data-testid="manager-more"><Icon name="more" /></button>
    </div>
    {#if lib}
      <div class="sync" data-testid="sync-status">
        {#if lib.lock?.fresh}
          <span class="locked"><Icon name="lock" size={15} /> {t('lock.syncing', { actor: lib.lock.actor, time: fmtRelative(lib.lock.since) })}</span>
          <button class="btn small" onclick={forceUnlock} data-testid="force-unlock">{t('lock.force')}</button>
        {:else}
          <Icon name="sync" size={15} />
          <span>{lib.lastSyncAt ? t('sync.last', { actor: lib.lastSyncActor ?? '?', time: fmtRelative(lib.lastSyncAt) }) : t('sync.never')}</span>
        {/if}
        <span class="hint">· {t('sync.counts', { b: lib.bookmarkCount, f: lib.folderCount })}</span>
        {#if lib.pendingCount}<a href="/history/{slug}" class="badge warn">{t('sync.pending', { n: lib.pendingCount })}</a>{/if}
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
          <div class="listbar">
            <input type="checkbox" checked={allChecked} aria-label={t('manager.selectAll')} onchange={() => (allChecked ? selected.clear() : shown.forEach((i) => selected.add(i.id)))} />
            {#if selected.size}
              <div class="selbar" data-testid="selection-bar">
                <span>{t('manager.selected', { n: selected.size })}</span>
                <button class="btn small" disabled={readonly} onclick={() => (dialog = { kind: 'move', ids: [...selected] })}><Icon name="move" size={15} />{t('manager.moveTo')}</button>
                <button class="btn small" disabled={readonly} onclick={() => (dialog = { kind: 'tag', ids: [...selected] })}><Icon name="tag" size={15} />{t('menu.tags')}</button>
                <button class="btn small" disabled={readonly} onclick={() => remove([...selected])} data-testid="bulk-delete"><Icon name="trash" size={15} />{t('menu.delete')}</button>
                <button class="btn small ghost" onclick={() => selected.clear()}>{t('common.cancel')}</button>
              </div>
            {:else}
              <span class="hint">{t('manager.items', { n: shown.length })}</span>
            {/if}
          </div>

          <div class="rows" role="list" data-testid="item-list">
          {#if !shown.length}
            <p class="hint empty">{q.trim() ? t('manager.noMatch') : t('manager.emptyFolder')}</p>
          {/if}
          {#each shown as it, i (it.id)}
            <div
              class="item"
              class:sel={selected.has(it.id)}
              class:cursor={cursor === i}
              role="listitem"
              data-row-index={i}
              data-drop-id={it.id}
              data-drop-folder={it.type === 'folder' ? '1' : '0'}
              data-testid="item-row"
              data-title={it.title}
              use:dragSource={dragOpts(it.id)}
              oncontextmenu={(e) => context(e, it)}
              ondblclick={(e) => !(e.target as HTMLElement).closest('a,input,button') && startEdit(it)}
            >
              <input type="checkbox" checked={selected.has(it.id)} onclick={(e) => toggleSelect(it.id, e)} aria-label={t('manager.select', { title: it.title })} />
              {#if !readonly}<span class="grip" data-drag-handle aria-hidden="true"><Icon name="grip" size={16} /></span>{/if}
              <Favicon item={it} size={20} />
              {#if editing === it.id}
                <form class="edit" onsubmit={saveEdit} data-testid="inline-edit">
                  <!-- svelte-ignore a11y_autofocus -->
                  <input bind:value={editTitle} aria-label={t('field.title')} autofocus onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
                  {#if it.type === 'bookmark'}
                    <input bind:value={editUrl} aria-label={t('field.url')} onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
                    <input bind:value={editTags} aria-label={t('field.tags')} placeholder={t('field.tagsHint')} onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
                  {/if}
                  <div class="row">
                    <button class="btn small primary" type="submit">{t('common.save')}</button>
                    <button class="btn small" type="button" onclick={() => (editing = null)}>{t('common.cancel')}</button>
                  </div>
                </form>
              {:else}
                <div class="info">
                  {#if it.type === 'folder'}
                    <a class="title ellipsis" href="/lib/{slug}/f/{it.id}" draggable="false">{it.title || t('item.untitled')}</a>
                    <span class="meta hint">{t('manager.folderCount', { n: childrenOf(idx, it.id).length })}</span>
                  {:else}
                    <BookmarkLink item={it} library={slug} class="title ellipsis">{it.title || it.url}</BookmarkLink>
                    <span class="meta">
                      <span class="host hint ellipsis">{hostOf(it.url)}</span>
                      {#each it.tags as tg (tg)}<a class="tag" href="/search?q={encodeURIComponent('#' + tg)}">#{tg}</a>{/each}
                      {#if it.health && ['broken', 'unreachable'].includes(it.health.status)}
                        <span class="badge danger" title={it.health.error ?? ''}>{it.health.status === 'broken' ? t('health.broken') : t('health.unreachable')}</span>
                      {:else if it.health?.status === 'redirect'}
                        <span class="badge warn" title={it.health.finalUrl ?? ''}>{t('health.redirect')}</span>
                      {/if}
                    </span>
                  {/if}
                </div>
                <button class="icon-btn" aria-label={t('common.more')} onclick={(e) => context(e, it)} data-testid="row-menu"><Icon name="more" /></button>
              {/if}
            </div>
          {/each}
          </div>
        {/if}
      </section>
    </div>
  {:else if entry?.loading}
    <p class="hint">{t('common.loading')}</p>
  {/if}
</div>

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

{#if treeOpen}
  <Dialog title={lib?.name ?? ''} onclose={() => (treeOpen = false)} wide>
    {#if idx && lib}
      <FolderTree {slug} name={lib.name} {idx} current={folderId} {expanded} {readonly} drag={dragOpts} oncontext={context} />
    {/if}
  </Dialog>
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
    padding: 0 16px 40px;
  }
  .wtop {
    position: sticky;
    top: 0;
    z-index: 20;
    margin: 0 -16px;
    padding: 8px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .wtop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
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
  .crumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    color: var(--text-3);
    font-size: 0.92rem;
    overflow: hidden;
    white-space: nowrap;
  }
  .crumbs a {
    padding: 2px 4px;
    border-radius: 4px;
    color: var(--text-2);
    text-decoration: none;
  }
  .crumbs .cur {
    color: var(--text);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wsearch {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 180px;
    max-width: 380px;
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
    min-height: 32px;
  }
  .wsearch input:focus {
    outline: none;
  }
  .sync {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--text-2);
    margin: 6px 0 2px;
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
    grid-template-columns: 260px 1fr;
    gap: 16px;
    align-items: start;
  }
  .side {
    position: sticky;
    top: 96px;
    max-height: calc(100vh - 120px);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 6px;
  }
  .main {
    min-width: 0;
  }
  .listbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    min-height: 46px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-bottom: 0;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }
  .selbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .rows {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
  .empty {
    padding: 24px;
    text-align: center;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 12px;
    border-top: 1px solid var(--border);
    min-height: 52px;
  }
  .item:first-of-type {
    border-top: 0;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.sel {
    background: var(--accent-soft);
  }
  .item.cursor {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .grip {
    color: var(--text-3);
    display: inline-flex;
    padding: 6px 2px;
    opacity: 0.35;
  }
  .item:hover .grip {
    opacity: 1;
  }
  @media (hover: none) {
    .grip {
      opacity: 0.8;
      padding: 10px 4px;
    }
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .info :global(.title) {
    color: var(--text);
    font-weight: 500;
    display: block;
  }
  .meta {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 0.8rem;
    min-width: 0;
    flex-wrap: wrap;
  }
  .host {
    max-width: 260px;
  }
  .edit {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .edit input {
    width: 100%;
  }
  @media (max-width: 899px) {
    .workspace {
      padding: 0 10px 30px;
    }
    .wtop {
      margin: 0 -10px;
      padding: 6px 10px;
    }
    .wtop-row {
      flex-wrap: wrap;
      gap: 6px;
    }
    .brand {
      display: none;
    }
    .crumbs {
      flex: 1;
    }
    .wsearch {
      order: 10;
      flex-basis: 100%;
      max-width: none;
      min-width: 0;
    }
    .sync {
      margin: 4px 0 0;
    }
    .cols {
      grid-template-columns: 1fr;
    }
    .item {
      padding-left: 8px;
      gap: 8px;
    }
  }
</style>
