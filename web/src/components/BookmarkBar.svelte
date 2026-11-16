<script lang="ts">
  import type { Item } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { childrenOf, type TreeIndex } from '../lib/tree'
  import BookmarkLink from './BookmarkLink.svelte'
  import Favicon from './Favicon.svelte'
  import FolderMenu from './FolderMenu.svelte'
  import Icon from './Icon.svelte'

  // 桌面书签栏：库根的直接子项横排，文件夹悬停弹出级联菜单，放不下的收进 »
  let {
    slug,
    idx,
    current = 0,
    oncontext,
  }: {
    slug: string
    idx: TreeIndex
    current?: number
    oncontext: (e: MouseEvent, it: Item) => void
  } = $props()

  const items = $derived(childrenOf(idx, 0))
  let root: HTMLDivElement | undefined = $state()
  let strip: HTMLDivElement | undefined = $state()
  let fit = $state(Infinity)
  /** key：文件夹 id，或 -1 表示 » 菜单；hover：悬停打开的，指针离开就收 */
  let open = $state<{ key: number; rect: DOMRect; hover: boolean } | null>(null)
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  const menuItems = $derived(!open ? [] : open.key === -1 ? items.slice(fit) : childrenOf(idx, open.key))

  // 量出一行能放下几个，其余进 »
  function measure() {
    if (!strip) return
    const els = [...strip.querySelectorAll<HTMLElement>(':scope > .bi')]
    const total = strip.clientWidth
    const last = els[els.length - 1]
    if (!last || last.offsetLeft + last.offsetWidth <= total) {
      fit = Infinity
      return
    }
    const room = total - 34
    let n = 0
    while (n < els.length && els[n].offsetLeft + els[n].offsetWidth <= room) n++
    fit = n
  }
  $effect(() => {
    if (!strip) return
    void items
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(strip)
    return () => ro.disconnect()
  })
  $effect(() => () => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
  })

  function show(key: number, el: HTMLElement, hover: boolean) {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    open = { key, rect: el.getBoundingClientRect(), hover }
  }
  function close() {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    open = null
  }

  function enter(e: PointerEvent, key: number) {
    if (e.pointerType !== 'mouse') return
    const el = e.currentTarget as HTMLElement
    clearTimeout(openTimer)
    if (open) {
      if (open.key !== key) show(key, el, open.hover)
      return
    }
    openTimer = setTimeout(() => show(key, el, true), 250)
  }
  function enterLink(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    clearTimeout(openTimer)
    if (open) close()
  }

  function click(e: MouseEvent, key: number) {
    e.preventDefault()
    if (open?.key === key && !open.hover) close()
    else show(key, e.currentTarget as HTMLElement, false)
  }
</script>

<svelte:window onpointerdown={(e) => open && !root?.contains(e.target as Node) && close()} onkeydown={(e) => open && e.key === 'Escape' && close()} />

<div
  class="bbar"
  role="toolbar"
  tabindex="-1"
  aria-label={t('bar.label')}
  bind:this={root}
  data-testid="bookmark-bar"
  onpointerleave={(e) => {
    clearTimeout(openTimer)
    if (open?.hover && e.pointerType === 'mouse') closeTimer = setTimeout(close, 400)
  }}
  onpointerenter={() => clearTimeout(closeTimer)}
>
  <div class="strip" bind:this={strip}>
    {#each items as it, i (it.id)}
      {#if it.type === 'folder'}
        <a
          class="bi"
          class:hidden={i >= fit}
          class:on={open?.key === it.id || current === it.id}
          href="/lib/{slug}/f/{it.id}"
          draggable="false"
          aria-haspopup="menu"
          aria-expanded={open?.key === it.id}
          data-title={it.title}
          data-drop-id={it.id}
          data-drop-folder="1"
          data-drop-inside
          data-testid="bar-folder"
          onpointerenter={(e) => enter(e, it.id)}
          onpointerleave={() => clearTimeout(openTimer)}
          onclick={(e) => click(e, it.id)}
          oncontextmenu={(e) => oncontext(e, it)}
        >
          <Icon name="folder" size={15} />
          <span class="label">{it.title || t('item.untitled')}</span>
        </a>
      {:else}
        <BookmarkLink
          item={it}
          library={slug}
          class={'bi' + (i >= fit ? ' hidden' : '')}
          data-title={it.title}
          onpointerenter={enterLink}
          oncontextmenu={(e) => oncontext(e, it)}
        >
          <Favicon item={it} size={15} />
          <span class="label">{it.title || it.url}</span>
        </BookmarkLink>
      {/if}
    {/each}
  </div>
  {#if fit < items.length}
    <button
      class="bi more"
      class:on={open?.key === -1}
      aria-label={t('bar.more')}
      aria-haspopup="menu"
      aria-expanded={open?.key === -1}
      data-testid="bar-more"
      onpointerenter={(e) => enter(e, -1)}
      onpointerleave={() => clearTimeout(openTimer)}
      onclick={(e) => click(e, -1)}
    >
      <Icon name="chevron" size={14} /><Icon name="chevron" size={14} />
    </button>
  {/if}
  {#if open}
    {#key open.key}
      <FolderMenu {slug} {idx} items={menuItems} anchor={open.rect} {current} autofocus={!open.hover} onclose={close} {oncontext} />
    {/key}
  {/if}
</div>

<style>
  .bbar {
    position: relative;
    display: flex;
    align-items: center;
    height: 30px;
    margin-top: 4px;
  }
  .strip {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 2px;
    overflow: hidden;
  }
  .bbar :global(.bi) {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 180px;
    height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 0.86rem;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .bbar :global(.bi:hover),
  .bbar :global(.bi.on) {
    background: var(--hover);
    color: var(--text);
  }
  .bbar :global(.bi.hidden) {
    visibility: hidden;
  }
  .bbar :global(.bi .icon) {
    flex: none;
  }
  .bbar a.bi > :global(.icon) {
    color: var(--folder);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .more {
    position: absolute;
    right: 0;
    gap: 0 !important;
    padding: 0 6px !important;
  }
  .more :global(.icon + .icon) {
    margin-left: -9px;
  }
</style>
