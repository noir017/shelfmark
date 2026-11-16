<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLAnchorAttributes } from 'svelte/elements'
  import type { Item } from '../api/types'
  import { opensInNewTab } from '../lib/stores/app.svelte'
  import { recordVisit } from '../lib/visits'

  let {
    item,
    library,
    children,
    class: cls = '',
    ...rest
  }: { item: Pick<Item, 'id' | 'url' | 'title'>; library: string; children: Snippet; class?: string } & Omit<HTMLAnchorAttributes, 'href' | 'class'> = $props()

  const newTab = $derived(opensInNewTab())
  const visit = () => recordVisit(library, item.id)
</script>

<a
  {...rest}
  class={cls}
  href={item.url ?? '#'}
  target={newTab ? '_blank' : undefined}
  rel="noopener noreferrer"
  draggable="false"
  data-native
  onclick={visit}
  onauxclick={(e) => e.button === 1 && visit()}>{@render children()}</a
>
