<script lang="ts" module>
  export interface ItemDraft {
    type: 'bookmark' | 'folder'
    title: string
    url: string
    tags: string[]
    notes: string
    parentId: number
  }
</script>

<script lang="ts">
  import { client, unwrap } from '../api'
  import type { Item } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { app, errorText } from '../lib/stores/app.svelte'
  import { parseTags } from '../lib/tags'
  import { isHttpUrl } from '../lib/url'
  import Dialog from './Dialog.svelte'
  import FolderPicker from './FolderPicker.svelte'

  let {
    slug,
    mode,
    initial,
    onsubmit,
    onclose,
  }: {
    slug: string
    mode: 'new' | 'edit'
    initial: Partial<Item> & { type: 'bookmark' | 'folder'; parentId: number }
    onsubmit: (d: ItemDraft) => Promise<boolean>
    onclose: () => void
  } = $props()

  let title = $state(initial.title ?? '')
  let url = $state(initial.url ?? '')
  let tags = $state((initial.tags ?? []).join(', '))
  let notes = $state(initial.notes ?? '')
  let parent = $state<number | null>(initial.parentId)
  let lib = $state(slug)
  let fetching = $state(false)
  let error = $state('')
  let busy = $state(false)
  let lastFetched = ''

  const isBookmark = initial.type === 'bookmark'

  async function fetchMeta() {
    const u = url.trim()
    if (!isBookmark || !isHttpUrl(u) || u === lastFetched || !app.online) return
    lastFetched = u
    fetching = true
    try {
      const m = await unwrap(client.POST('/api/v1/meta/fetch', { body: { url: u } }))
      if (!title.trim() && m.title) title = m.title
    } catch {
      /* 抓不到就算了 */
    } finally {
      fetching = false
    }
  }

  async function submit(e: Event) {
    e.preventDefault()
    error = ''
    if (isBookmark && !url.trim()) return (error = t('item.urlRequired'))
    if (!isBookmark && !title.trim()) return (error = t('item.titleRequired'))
    busy = true
    try {
      const ok = await onsubmit({
        type: initial.type, title: title.trim(), url: url.trim(), tags: parseTags(tags), notes: notes.trim(), parentId: parent ?? 0,
      })
      if (ok) onclose()
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }
</script>

<Dialog
  title={mode === 'new' ? (isBookmark ? t('item.newBookmark') : t('item.newFolder')) : isBookmark ? t('item.editBookmark') : t('item.editFolder')}
  {onclose}
  testid="item-dialog"
>
  <form id="item-form" onsubmit={submit}>
    {#if isBookmark}
      <label class="field">
        <span>{t('field.url')}</span>
        <input name="url" type="url" inputmode="url" bind:value={url} onblur={fetchMeta} onpaste={() => setTimeout(fetchMeta, 0)} placeholder="https://" required autofocus />
      </label>
    {/if}
    <label class="field">
      <span>{t('field.title')}{fetching ? ' · ' + t('item.fetching') : ''}</span>
      <input name="title" bind:value={title} autofocus={!isBookmark} />
    </label>
    {#if isBookmark}
      <label class="field">
        <span>{t('field.tags')}</span>
        <input name="tags" bind:value={tags} placeholder={t('field.tagsHint')} />
      </label>
      <label class="field">
        <span>{t('field.notes')}</span>
        <textarea name="notes" bind:value={notes}></textarea>
      </label>
    {/if}
    {#if mode === 'new'}
      <div class="field">
        <span>{t('field.folder')}</span>
        <FolderPicker bind:library={lib} bind:folderId={parent} libraryLocked />
      </div>
    {/if}
    {#if error}<p class="error-text" role="alert">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>{t('common.cancel')}</button>
    <button type="submit" form="item-form" class="btn primary" disabled={busy}>{t('common.save')}</button>
  {/snippet}
</Dialog>

<style>
  input,
  textarea {
    width: 100%;
  }
</style>
