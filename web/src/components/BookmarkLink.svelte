<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Item } from '../api/types'
  import { app } from '../lib/stores/app.svelte'
  import { recordVisit } from '../lib/visits'

  let {
    item,
    library,
    children,
    class: cls = '',
  }: { item: Pick<Item, 'id' | 'url' | 'title'>; library: string; children: Snippet; class?: string } = $props()

  const newTab = $derived(!!app.settings?.openInNewTab)
  const visit = () => recordVisit(library, item.id)
</script>

<a
  class={cls}
  href={item.url ?? '#'}
  target={newTab ? '_blank' : undefined}
  rel="noopener noreferrer"
  draggable="false"
  data-native
  onclick={visit}
  onauxclick={(e) => e.button === 1 && visit()}>{@render children()}</a
>
