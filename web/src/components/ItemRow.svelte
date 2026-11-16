<script lang="ts" module>
  export type ItemPatch = { title?: string; url?: string; tags?: string[] }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import type { Item } from '../api/types'
  import type { DragSourceOptions } from '../lib/dragdrop'
  import { dragSource } from '../lib/dragdrop'
  import { t } from '../lib/i18n/index.svelte'
  import { longpress } from '../lib/longpress'
  import { parseTags } from '../lib/tags'
  import { hostOf } from '../lib/url'
  import BookmarkLink from './BookmarkLink.svelte'
  import Favicon from './Favicon.svelte'
  import Icon from './Icon.svelte'

  let {
    item: it,
    slug,
    depth = 0,
    index,
    count = 0,
    selected = false,
    selecting = false,
    cursor = false,
    editing = false,
    expanded = false,
    readonly = false,
    pinned = false,
    drag,
    onselect,
    ontoggle,
    onmenu,
    onsave,
    oncancel,
    onlongpress,
  }: {
    item: Item
    slug: string
    depth?: number
    index: number
    /** 文件夹的子项数 */
    count?: number
    selected?: boolean
    /** 已有选中项：触屏上点行改为选择 */
    selecting?: boolean
    cursor?: boolean
    editing?: boolean
    expanded?: boolean
    readonly?: boolean
    /** 冻结在列表顶部的那份副本 */
    pinned?: boolean
    drag: DragSourceOptions
    onselect: (e: MouseEvent) => void
    ontoggle: () => void
    onmenu: (e: MouseEvent) => void
    onsave: (patch: ItemPatch) => void
    oncancel: () => void
    onlongpress: () => void
  } = $props()

  let pointer = 'mouse'
  let editTitle = $state('')
  let editUrl = $state('')
  let editTags = $state('')

  $effect(() => {
    if (!editing) return
    untrack(() => {
      editTitle = it.title
      editUrl = it.url ?? ''
      editTags = it.tags.join(', ')
    })
  })

  // 修饰键点击、选择模式下的触屏点击：选择而不是打开。触屏点文件夹：展开/折叠，不进入（进入用 ⋯ 菜单或面包屑）
  function onclick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('input, button, form')) return
    if (e.ctrlKey || e.metaKey || e.shiftKey || (selecting && pointer !== 'mouse')) {
      e.preventDefault()
      e.stopPropagation()
      onselect(e)
    } else if (it.type === 'folder' && pointer !== 'mouse' && e.detail !== 0) {
      e.preventDefault()
      e.stopPropagation()
      ontoggle()
    }
  }

  function oncontextmenu(e: MouseEvent) {
    e.preventDefault()
    if (pointer === 'mouse') onmenu(e)
  }

  function save(e: Event) {
    e.preventDefault()
    const patch: ItemPatch = {}
    if (editTitle.trim() !== it.title) patch.title = editTitle.trim()
    if (it.type === 'bookmark') {
      if (editUrl.trim() !== it.url) patch.url = editUrl.trim()
      const tg = parseTags(editTags)
      if (tg.join(',') !== it.tags.join(',')) patch.tags = tg
    }
    onsave(patch)
  }

  const esc = (e: KeyboardEvent) => e.key === 'Escape' && oncancel()
  const broken = $derived(!!it.health && ['broken', 'unreachable'].includes(it.health.status))
</script>

<div
  class="item"
  class:sel={selected}
  class:selecting
  class:cursor
  class:editing
  class:pinned
  style:--depth={depth}
  role="listitem"
  data-row-index={pinned ? undefined : index}
  data-drop-id={it.id}
  data-drop-folder={it.type === 'folder' ? '1' : '0'}
  data-drop-inside={pinned ? '' : undefined}
  data-testid={pinned ? 'pinned-row' : 'item-row'}
  data-title={it.title}
  data-depth={depth}
  use:dragSource={drag}
  use:longpress={onlongpress}
  onpointerdowncapture={(e) => (pointer = e.pointerType)}
  onclickcapture={onclick}
  {oncontextmenu}
>
  <input class="cb" type="checkbox" checked={selected} onclick={onselect} aria-label={t('manager.select', { title: it.title })} />
  {#if it.type === 'folder'}
    <button class="tw" aria-label={expanded ? t('tree.collapse') : t('tree.expand')} aria-expanded={expanded} onclick={ontoggle} data-testid="row-toggle">
      <Icon name={expanded ? 'chevron-down' : 'chevron'} size={14} />
    </button>
  {:else}
    <span class="tw" aria-hidden="true"></span>
  {/if}
  <Favicon item={it} size={16} />
  {#if editing}
    <form class="edit" onsubmit={save} data-testid="inline-edit">
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={editTitle} aria-label={t('field.title')} autofocus onkeydown={esc} />
      {#if it.type === 'bookmark'}
        <input bind:value={editUrl} aria-label={t('field.url')} onkeydown={esc} />
        <input bind:value={editTags} aria-label={t('field.tags')} placeholder={t('field.tagsHint')} onkeydown={esc} />
      {/if}
      <div class="row">
        <button class="btn small primary" type="submit">{t('common.save')}</button>
        <button class="btn small" type="button" onclick={oncancel}>{t('common.cancel')}</button>
      </div>
    </form>
  {:else}
    {#if it.type === 'folder'}
      <a class="title" href="/lib/{slug}/f/{it.id}" draggable="false">{it.title || t('item.untitled')}</a>
    {:else}
      <BookmarkLink item={it} library={slug} class="title">{it.title || it.url}</BookmarkLink>
      <span class="meta">
        <span class="host">{hostOf(it.url)}</span>
        {#each it.tags as tg (tg)}<a class="tag" href="/search?q={encodeURIComponent('#' + tg)}">#{tg}</a>{/each}
        {#if broken}
          <span class="badge danger" title={it.health?.error ?? ''}>{it.health?.status === 'broken' ? t('health.broken') : t('health.unreachable')}</span>
        {:else if it.health?.status === 'redirect'}
          <span class="badge warn" title={it.health.finalUrl ?? ''}>{t('health.redirect')}</span>
        {/if}
      </span>
    {/if}
    {#if it.type === 'folder'}<span class="fill"></span><span class="count">{count}</span>{/if}
    {#if !readonly}<span class="grip" data-drag-handle aria-hidden="true"><Icon name="grip" size={16} /></span>{/if}
    <button class="more icon-btn" aria-label={t('common.more')} onclick={onmenu} data-testid="row-menu"><Icon name="more" size={16} /></button>
  {/if}
</div>

<style>
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 4px 0 calc(6px + var(--depth) * 18px);
    border-radius: 6px;
    font-size: 0.93rem;
    line-height: 1.3;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.sel {
    background: var(--accent-soft);
  }
  .item.cursor {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .item {
    scroll-margin-top: calc(var(--wtop-h, 0px) + 8px);
  }
  .item.pinned {
    background: var(--surface);
    border-radius: 0;
    box-shadow: 0 1px 0 var(--border), 0 2px 6px rgba(16, 24, 40, 0.08);
  }
  .item.pinned:hover {
    background: var(--hover);
  }
  .item.editing {
    align-items: flex-start;
    padding-top: 6px;
    padding-bottom: 6px;
  }
  /* 整行可点：标题链接铺满整行，其余可交互元素浮在上面 */
  /* 标题先占自然宽度，域名和标签只用剩下的空间 */
  .item :global(.title) {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--text);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item :global(.title)::after {
    content: '';
    position: absolute;
    inset: 0;
  }
  .cb,
  .tw,
  .meta a,
  .grip,
  .more,
  .edit {
    position: relative;
    z-index: 1;
  }
  .cb {
    flex: none;
    margin: 0;
  }
  .tw {
    flex: none;
    width: 18px;
    height: 22px;
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
  .meta {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    gap: 6px;
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--text-3);
  }
  .host {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .meta .tag,
  .meta .badge {
    flex: none;
    line-height: 1.45;
  }
  .fill {
    flex: 1;
  }
  .count {
    flex: none;
    color: var(--text-3);
    font-size: 0.8rem;
    min-width: 1.5em;
    text-align: right;
  }
  .grip {
    display: none;
    color: var(--text-3);
    padding: 8px 4px;
  }
  .more {
    width: 26px;
    height: 24px;
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

  /* 鼠标：复选框和 ⋯ 悬停才出现，整行可拖 */
  @media (hover: hover) {
    button.tw:hover {
      background: var(--border);
      color: var(--text);
    }
    .cb,
    .more {
      opacity: 0;
    }
    .item:hover .cb,
    .item:hover .more,
    .item.sel .cb,
    .item.selecting .cb,
    .cb:focus-visible,
    .more:focus-visible {
      opacity: 1;
    }
  }
  /* 触屏：行高 40px；长按进入多选，多选时才显示复选框和拖动手柄 */
  @media (hover: none) {
    .item {
      min-height: 40px;
      gap: 8px;
      padding-left: calc(4px + var(--depth) * 16px);
      -webkit-touch-callout: none;
      user-select: none;
    }
    .item:hover {
      background: none;
    }
    .item.sel {
      background: var(--accent-soft);
    }
    .tw {
      width: 26px;
      height: 32px;
    }
    .cb {
      display: none;
    }
    .item.selecting .cb {
      display: inline-block;
    }
    .item.selecting .grip {
      display: inline-flex;
    }
    .more {
      width: 32px;
      height: 32px;
      opacity: 0.7;
    }
  }
</style>
