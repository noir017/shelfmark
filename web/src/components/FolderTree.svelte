<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import type { Item } from '../api/types'
  import type { DragSourceOptions } from '../lib/dragdrop'
  import { dragSource } from '../lib/dragdrop'
  import { t } from '../lib/i18n/index.svelte'
  import { childrenOf, type TreeIndex } from '../lib/tree'
  import Icon from './Icon.svelte'

  let {
    slug,
    name,
    idx,
    current,
    expanded,
    readonly,
    drag,
    oncontext,
  }: {
    slug: string
    name: string
    idx: TreeIndex
    current: number
    expanded: SvelteSet<number>
    readonly: boolean
    drag: (id: number) => DragSourceOptions
    oncontext: (e: MouseEvent, it: Item) => void
  } = $props()

  const subfolders = (id: number) => childrenOf(idx, id).filter((c) => c.type === 'folder')
</script>

{#snippet node(f: Item, depth: number)}
  {@const kids = subfolders(f.id)}
  {@const open = expanded.has(f.id)}
  <li role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={current === f.id}>
    <div
      class="node"
      class:on={current === f.id}
      style:padding-left="{6 + depth * 14}px"
      data-drop-id={f.id}
      data-drop-folder="1"
      data-testid="tree-node"
      data-title={f.title}
      use:dragSource={drag(f.id)}
      oncontextmenu={(e) => oncontext(e, f)}
    >
      <button
        class="tw"
        class:hidden={!kids.length}
        tabindex="-1"
        aria-label={open ? t('tree.collapse') : t('tree.expand')}
        onclick={() => (open ? expanded.delete(f.id) : expanded.add(f.id))}
      >
        <Icon name={open ? 'chevron-down' : 'chevron'} size={14} />
      </button>
      {#if !readonly}<span class="grip" data-drag-handle aria-hidden="true"><Icon name="grip" size={14} /></span>{/if}
      <a href="/lib/{slug}/f/{f.id}" class="ellipsis"><Icon name={open ? 'folder-open' : 'folder'} size={16} /> {f.title || t('item.untitled')}</a>
    </div>
    {#if open && kids.length}
      <ul role="group">
        {#each kids as k (k.id)}{@render node(k, depth + 1)}{/each}
      </ul>
    {/if}
  </li>
{/snippet}

<nav class="tree" aria-label={t('tree.label')}>
  <ul role="tree">
    <li role="treeitem" aria-selected={current === 0}>
      <div class="node root" class:on={current === 0} data-drop-id="0" data-drop-inside data-testid="tree-root">
        <a href="/lib/{slug}" class="ellipsis"><Icon name="library" size={16} /> {name}</a>
      </div>
      <ul role="group">
        {#each subfolders(0) as f (f.id)}{@render node(f, 0)}{/each}
      </ul>
    </li>
  </ul>
</nav>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
    padding: 0 6px;
    min-height: 28px;
  }
  .node:hover {
    background: var(--hover);
  }
  .node.on {
    background: var(--accent-soft);
  }
  .node.on a {
    color: var(--accent-text);
    font-weight: 600;
  }
  .node a {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    text-decoration: none;
    padding: 3px 2px;
    font-size: 0.92rem;
  }
  .node a :global(.icon) {
    color: var(--folder);
  }
  .root a :global(.icon) {
    color: var(--accent);
  }
  .tw {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 0;
  }
  .tw.hidden {
    visibility: hidden;
  }
  .grip {
    color: var(--text-3);
    opacity: 0;
    display: inline-flex;
  }
  .node:hover .grip {
    opacity: 1;
  }
  @media (hover: none) {
    .grip {
      opacity: 0.6;
    }
  }
</style>
