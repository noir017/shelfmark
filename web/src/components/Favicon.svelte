<script lang="ts">
  import type { Item } from '../api/types'
  import { hostOf } from '../lib/url'
  import Icon from './Icon.svelte'

  let { item, size = 20 }: { item: Pick<Item, 'type' | 'title' | 'url' | 'faviconId'>; size?: number } = $props()
  let failed = $state(false)
  const letter = $derived((hostOf(item.url).replace(/^www\./, '')[0] ?? item.title[0] ?? '?').toUpperCase())
  const hue = $derived([...(hostOf(item.url) || item.title)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7))
</script>

{#if item.type === 'folder'}
  <span class="fav folder" style:width="{size}px" style:height="{size}px"><Icon name="folder" size={size - 2} /></span>
{:else if item.faviconId && !failed}
  <img class="fav" src="/api/v1/favicons/{item.faviconId}" alt="" width={size} height={size} loading="lazy" draggable="false" onerror={() => (failed = true)} />
{:else}
  <span class="fav letter" style:width="{size}px" style:height="{size}px" style:font-size="{Math.round(size * 0.55)}px" style:background="hsl({hue} 55% 46%)">{letter}</span>
{/if}

<style>
  .fav {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    object-fit: contain;
  }
  .folder {
    color: var(--folder);
  }
  .letter {
    color: #fff;
    font-weight: 700;
    line-height: 1;
  }
</style>
