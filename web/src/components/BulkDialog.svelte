<script lang="ts">
  import type { Item } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { parseTags } from '../lib/tags'
  import Dialog from './Dialog.svelte'
  import FolderPicker from './FolderPicker.svelte'

  let {
    kind,
    slug,
    items,
    onmove,
    ontag,
    onclose,
  }: {
    kind: 'move' | 'tag'
    slug: string
    items: Item[]
    onmove?: (folderId: number) => void
    ontag?: (add: string[], remove: string[]) => void
    onclose: () => void
  } = $props()

  let lib = $state(slug)
  let folder = $state<number | null>(0)
  let add = $state('')
  const existing = $derived([...new Set(items.flatMap((i) => i.tags))].sort())
  let remove = $state<string[]>([])

  function submit(e: Event) {
    e.preventDefault()
    if (kind === 'move') onmove?.(folder ?? 0)
    else ontag?.(parseTags(add), remove)
    onclose()
  }
</script>

<Dialog title={kind === 'move' ? t('move.title', { n: items.length }) : t('tagdlg.title', { n: items.length })} {onclose} testid="{kind}-dialog">
  <form id="bulk-form" onsubmit={submit}>
    {#if kind === 'move'}
      <FolderPicker bind:library={lib} bind:folderId={folder} libraryLocked exclude={items.filter((i) => i.type === 'folder').map((i) => i.id)} />
    {:else}
      <label class="field">
        <span>{t('tagdlg.add')}</span>
        <input bind:value={add} placeholder={t('field.tagsHint')} autofocus />
      </label>
      {#if existing.length}
        <div class="field">
          <span>{t('tagdlg.remove')}</span>
          <div class="row">
            {#each existing as tg (tg)}
              <label class="chip" class:on={remove.includes(tg)}>
                <input type="checkbox" class="sr-only" bind:group={remove} value={tg} />#{tg}
              </label>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>{t('common.cancel')}</button>
    <button type="submit" form="bulk-form" class="btn primary">{kind === 'move' ? t('move.submit') : t('common.save')}</button>
  {/snippet}
</Dialog>
