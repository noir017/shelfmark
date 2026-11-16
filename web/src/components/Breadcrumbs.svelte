<script lang="ts">
  import { t } from '../lib/i18n/index.svelte'
  import { childrenOf, type TreeIndex } from '../lib/tree'
  import FolderMenu from './FolderMenu.svelte'
  import Icon from './Icon.svelte'

  // 面包屑：每个分隔符点开列出左边那一级的子文件夹，直接跳到同级目录
  let { slug, name, idx, folderId }: { slug: string; name: string; idx: TreeIndex; folderId: number } = $props()

  const segs = $derived.by(() => {
    const n = folderId ? idx.byId.get(folderId) : null
    const out = [{ id: 0, title: name }]
    if (n) {
      n.pathIds.forEach((id, i) => out.push({ id, title: n.path[i] }))
      out.push({ id: folderId, title: n.item.title || t('item.untitled') })
    }
    return out
  })

  let root: HTMLElement | undefined = $state()
  let open = $state<{ parent: number; next: number; rect: DOMRect } | null>(null)
  const hover = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches

  $effect(() => {
    void segs
    open = null
    if (root) root.scrollLeft = root.scrollWidth
  })

  function toggle(e: MouseEvent, parent: number, next: number) {
    open = open?.parent === parent ? null : { parent, next, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }
  }
</script>

<svelte:window onpointerdown={(e) => open && !root?.contains(e.target as Node) && (open = null)} onkeydown={(e) => open && e.key === 'Escape' && (open = null)} />

<nav class="crumbs" aria-label={t('manager.breadcrumb')} bind:this={root} data-testid="breadcrumbs">
  {#each segs as s, i (s.id)}
    {#if i > 0}
      {@const p = segs[i - 1]}
      <button
        class="sep"
        aria-label={t('crumbs.siblings', { title: p.title })}
        aria-haspopup="menu"
        aria-expanded={open?.parent === p.id}
        data-testid="crumb-sep"
        onclick={(e) => toggle(e, p.id, s.id)}
      >
        <Icon name="chevron" size={14} />
      </button>
    {/if}
    {#if i === segs.length - 1}
      <span class="cur">{s.title}</span>
    {:else}
      <a href={s.id ? `/lib/${slug}/f/${s.id}` : `/lib/${slug}`}>{s.title}</a>
    {/if}
  {/each}
  {#if open}
    {@const o = open}
    <FolderMenu
      {slug}
      {idx}
      items={childrenOf(idx, o.parent)}
      anchor={o.rect}
      current={o.next}
      foldersOnly
      cascade={hover}
      autofocus
      onclose={() => (open = null)}
    />
  {/if}
</nav>

<style>
  .crumbs {
    display: flex;
    align-items: center;
    gap: 1px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
    color: var(--text-3);
    font-size: 0.92rem;
  }
  .crumbs::-webkit-scrollbar {
    display: none;
  }
  .crumbs a,
  .cur {
    flex: none;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .crumbs a {
    color: var(--text-2);
    text-decoration: none;
  }
  .crumbs a:hover {
    background: var(--hover);
  }
  .cur {
    color: var(--text);
    font-weight: 600;
  }
  .sep {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  .sep:hover,
  .sep[aria-expanded='true'] {
    background: var(--hover);
    color: var(--text);
  }
  @media (hover: none) {
    .sep {
      width: 26px;
      height: 32px;
    }
  }
</style>
