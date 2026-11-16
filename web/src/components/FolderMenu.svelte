<script lang="ts">
  import { tick } from 'svelte'
  import FolderMenu from './FolderMenu.svelte'
  import type { Item } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { childrenOf, type TreeIndex } from '../lib/tree'
  import BookmarkLink from './BookmarkLink.svelte'
  import Favicon from './Favicon.svelte'
  import Icon from './Icon.svelte'

  // 级联菜单：列出一组条目，文件夹悬停向右展开下一级，点书签打开、点文件夹进入
  let {
    slug,
    idx,
    items,
    anchor,
    placement = 'below',
    current = 0,
    foldersOnly = false,
    cascade = true,
    autofocus = false,
    onclose,
    onback,
    oncontext,
  }: {
    slug: string
    idx: TreeIndex
    items: Item[]
    anchor: DOMRect
    placement?: 'below' | 'right'
    /** 高亮的文件夹 */
    current?: number
    foldersOnly?: boolean
    /** 悬停展开子菜单（触屏关掉，点文件夹直接进入） */
    cascade?: boolean
    autofocus?: boolean
    /** 关掉整串菜单 */
    onclose: () => void
    /** 子菜单：关掉自己，焦点回上一级 */
    onback?: () => void
    oncontext?: (e: MouseEvent, it: Item) => void
  } = $props()

  let panel: HTMLDivElement | undefined = $state()
  let pos = $state<{ x: number; y: number; maxH: number } | null>(null)
  let sub = $state<{ id: number; rect: DOMRect; focus: boolean } | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  const list = (id: number) => childrenOf(idx, id).filter((c) => !foldersOnly || c.type === 'folder')
  const shown = $derived(foldersOnly ? items.filter((c) => c.type === 'folder') : items)

  $effect(() => {
    if (!panel) return
    void anchor
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = panel.offsetWidth
    const h = panel.scrollHeight
    let x: number
    let y: number
    if (placement === 'below') {
      x = Math.min(anchor.left, vw - w - 4)
      y = anchor.bottom + 2
    } else {
      x = anchor.right + w > vw - 4 ? anchor.left - w : anchor.right - 2
      y = Math.min(anchor.top - 4, vh - Math.min(h, vh - 8) - 4)
    }
    x = Math.max(4, x)
    y = Math.max(4, y)
    pos = { x, y, maxH: vh - y - 8 }
    if (autofocus) void tick().then(() => focusAt(0))
  })

  $effect(() => () => clearTimeout(timer))

  function entries(): HTMLElement[] {
    return [...(panel?.querySelectorAll<HTMLElement>(':scope > .mi') ?? [])]
  }
  function focusAt(i: number) {
    const els = entries()
    els[(i + els.length) % els.length]?.focus()
  }

  function openSub(it: Item, el: HTMLElement, focus = false) {
    clearTimeout(timer)
    sub = it.type === 'folder' && list(it.id).length ? { id: it.id, rect: el.getBoundingClientRect(), focus } : null
  }

  function hover(e: PointerEvent, it: Item) {
    if (!cascade || e.pointerType !== 'mouse') return
    const el = e.currentTarget as HTMLElement
    clearTimeout(timer)
    if (sub?.id === it.id) return
    timer = setTimeout(() => openSub(it, el), 120)
  }

  function menu(e: MouseEvent, it: Item) {
    if (!oncontext) return
    e.preventDefault()
    oncontext(e, it)
  }

  function onkeydown(e: KeyboardEvent) {
    const els = entries()
    const i = els.indexOf(document.activeElement as HTMLElement)
    const it = shown[i]
    let handled = true
    if (e.key === 'ArrowDown') focusAt(i + 1)
    else if (e.key === 'ArrowUp') focusAt(i - 1)
    else if (e.key === 'ArrowRight' && it && cascade) openSub(it, els[i], true)
    else if (e.key === 'ArrowLeft' && onback) onback()
    else if (e.key === 'Escape') onback ? onback() : onclose()
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // 点了任何链接（书签或文件夹）就收起整串菜单；中键开后台标签不收
  function onclick(e: MouseEvent) {
    if ((e.target as Element).closest('a')) onclose()
  }
</script>

<div
  class="fmenu"
  role="menu"
  tabindex="-1"
  bind:this={panel}
  style:left="{pos?.x ?? 0}px"
  style:top="{pos?.y ?? 0}px"
  style:max-height={pos ? `${pos.maxH}px` : undefined}
  style:visibility={pos ? 'visible' : 'hidden'}
  data-testid="folder-menu"
  onscroll={() => (sub = null)}
  {onkeydown}
  {onclick}
>
  {#each shown as it (it.id)}
    {#if it.type === 'folder'}
      {@const kids = list(it.id).length > 0}
      <a
        class="mi"
        class:on={it.id === current}
        class:open={sub?.id === it.id}
        role="menuitem"
        href="/lib/{slug}/f/{it.id}"
        draggable="false"
        data-title={it.title}
        onpointerenter={(e) => hover(e, it)}
        onpointerleave={() => clearTimeout(timer)}
        oncontextmenu={(e) => menu(e, it)}
      >
        <Icon name="folder" size={16} />
        <span class="label">{it.title || t('item.untitled')}</span>
        {#if kids && cascade}<Icon name="chevron" size={14} />{/if}
      </a>
    {:else}
      <BookmarkLink
        item={it}
        library={slug}
        class="mi"
        role="menuitem"
        data-title={it.title}
        onpointerenter={(e) => hover(e, it)}
        onpointerleave={() => clearTimeout(timer)}
        oncontextmenu={(e) => menu(e, it)}
      >
        <Favicon item={it} size={16} />
        <span class="label">{it.title || it.url}</span>
      </BookmarkLink>
    {/if}
  {:else}
    <span class="empty">{t('menu.empty')}</span>
  {/each}
  {#if sub}
    {@const s = sub}
    <FolderMenu
      {slug}
      {idx}
      items={childrenOf(idx, s.id)}
      anchor={s.rect}
      placement="right"
      {current}
      {foldersOnly}
      {cascade}
      autofocus={s.focus}
      {onclose}
      onback={() => {
        const i = shown.findIndex((x) => x.id === s.id)
        sub = null
        focusAt(i)
      }}
      {oncontext}
    />
  {/if}
</div>

<style>
  .fmenu {
    position: fixed;
    z-index: 40;
    min-width: 200px;
    max-width: 360px;
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
  }
  .fmenu > :global(.mi) {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 2px 8px;
    border-radius: 5px;
    color: var(--text);
    text-decoration: none;
    font-size: 0.9rem;
    white-space: nowrap;
  }
  .fmenu > :global(.mi:hover),
  .fmenu > :global(.mi:focus-visible),
  .fmenu > :global(.mi.open) {
    background: var(--hover);
    outline: none;
  }
  .fmenu > :global(.mi.on) {
    color: var(--accent-text);
    font-weight: 600;
  }
  .fmenu > :global(.mi) :global(.icon) {
    flex: none;
  }
  .fmenu > a.mi > :global(.icon:first-child) {
    color: var(--folder);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 4px 10px;
    color: var(--text-3);
    font-size: 0.88rem;
  }
  @media (hover: none) {
    .fmenu > :global(.mi) {
      min-height: 40px;
    }
  }
</style>
