<script lang="ts">
  import { client, unwrap } from '../api'
  import { AccessExpiredError, NetworkError } from '../api/client'
  import type { AiSuggestion, ItemWithPath, QuickSaveRequest, QuickSaveResult } from '../api/types'
  import Dialog from './Dialog.svelte'
  import FolderPicker from './FolderPicker.svelte'
  import Icon from './Icon.svelte'
  import { t } from '../lib/i18n/index.svelte'
  import { enqueueSave } from '../lib/offline/queue'
  import { app, defaultLibrary, errorText, refreshQueueCount } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { parseTags } from '../lib/tags'
  import { extractUrl, isHttpUrl } from '../lib/url'

  let {
    initialUrl = '',
    initialTitle = '',
    initialText = '',
    initialLibrary = '',
    initialFolderId = null,
    onclose,
    onsaved,
  }: {
    initialUrl?: string
    initialTitle?: string
    initialText?: string
    initialLibrary?: string
    initialFolderId?: number | null
    onclose: () => void
    onsaved?: (r: QuickSaveResult) => void
  } = $props()

  const found = initialUrl.trim() || extractUrl(initialText) || extractUrl(initialTitle) || ''
  const textRest = initialText.replace(found, '').trim()
  const def = app.settings?.defaultSave ?? null

  let url = $state(found)
  let title = $state(initialTitle && initialTitle !== found ? initialTitle : textRest)
  let lib = $state(initialLibrary || def?.library || defaultLibrary() || 'bookmarks')
  let folderId = $state<number | null>(initialFolderId ?? def?.folderId ?? null)
  let tags = $state('')
  let notes = $state('')
  let existing = $state<ItemWithPath[]>([])
  let ai = $state<AiSuggestion | null>(null)
  let aiLoading = $state(false)
  let status = $state<'idle' | 'saving' | 'saved' | 'existed' | 'queued'>('idle')
  let result = $state<QuickSaveResult | null>(null)
  let error = $state('')

  const recent = $derived(app.settings?.recentSaveTargets ?? [])

  let lookupTimer: ReturnType<typeof setTimeout>
  $effect(() => {
    const u = url.trim()
    clearTimeout(lookupTimer)
    existing = []
    if (!isHttpUrl(u) || !app.online) return
    lookupTimer = setTimeout(async () => {
      try {
        existing = (await unwrap(client.GET('/api/v1/lookup', { params: { query: { url: u } } }))).matches
      } catch {
        /* ignore */
      }
    }, 300)
  })

  async function suggest() {
    if (!app.info?.features.ai || !app.online || !isHttpUrl(url.trim())) return
    aiLoading = true
    try {
      ai = await unwrap(client.POST('/api/v1/ai/suggest', { body: { library: lib, url: url.trim(), title: title || undefined } }))
      void loadTree(lib)
    } catch {
      ai = null
    } finally {
      aiLoading = false
    }
  }
  $effect(() => {
    if (found && app.info?.features.ai) void suggest()
  })

  function addTag(tg: string) {
    const cur = parseTags(tags)
    if (!cur.some((x) => x.toLowerCase() === tg.toLowerCase())) tags = [...cur, tg].join(', ')
  }

  async function save(e: Event) {
    e.preventDefault()
    error = ''
    const u = url.trim()
    if (!isHttpUrl(u) && !/^[a-z][a-z0-9+.-]*:/i.test(u)) return (error = t('share.badUrl'))
    const req: QuickSaveRequest = { url: u, library: lib }
    if (title.trim()) req.title = title.trim()
    if (folderId !== null) req.parentId = folderId
    if (notes.trim()) req.notes = notes.trim()
    const tg = parseTags(tags)
    if (tg.length) req.tags = tg
    status = 'saving'
    try {
      result = await unwrap(client.POST('/api/v1/quick-save', { body: req }))
      status = result.existed ? 'existed' : 'saved'
      onsaved?.(result)
    } catch (err) {
      if (err instanceof NetworkError) {
        await enqueueSave(req)
        await refreshQueueCount()
        status = 'queued'
      } else {
        status = 'idle'
        error = errorText(err)
        if (err instanceof AccessExpiredError) return
      }
    }
  }

  function reset() {
    url = ''
    title = ''
    tags = ''
    notes = ''
    ai = null
    result = null
    status = 'idle'
  }

  const libName = (s: string) => app.libraries.find((l) => l.slug === s)?.name ?? s
</script>

<Dialog title={t('share.title')} {onclose} wide testid="save-sheet">
  {#if status === 'saved' || status === 'existed' || status === 'queued'}
    <div class="done" data-testid="share-result">
      {#if status === 'queued'}
        <p><Icon name="offline" /> {t('share.queued')}</p>
      {:else if result}
        <p>
          <Icon name="check" />
          {status === 'existed' ? t('share.existed') : t('share.saved')}
          <b>{libName(result.library)}{result.path.length ? ' / ' + result.path.join(' / ') : ''}</b>
        </p>
      {/if}
      <div class="row">
        {#if result}
          <a class="btn" href="/lib/{result.library}{result.item.parentId ? '/f/' + result.item.parentId : ''}" onclick={onclose}>{t('share.view')}</a>
        {/if}
        <button class="btn" onclick={reset}>{t('share.another')}</button>
        <button class="btn primary" onclick={onclose}>{t('common.close')}</button>
      </div>
    </div>
  {:else}
    <form class="form" onsubmit={save} data-testid="share-form">
      {#if existing.length}
        <div class="exists" role="status" data-testid="already-saved">
          <Icon name="info" />
          <div>
            <b>{t('share.alreadySaved')}</b>
            {#each existing as m (m.library + m.item.id)}
              <div><a href="/lib/{m.library}{m.item.parentId ? '/f/' + m.item.parentId : ''}" onclick={onclose}>{libName(m.library)}{m.path.length ? ' / ' + m.path.join(' / ') : ''}</a> · {m.item.title}</div>
            {/each}
          </div>
        </div>
      {/if}
      <label class="field">
        <span>{t('field.url')}</span>
        <input name="url" bind:value={url} inputmode="url" required autofocus={!found} data-testid="share-url" />
      </label>
      <label class="field">
        <span>{t('field.title')}</span>
        <input name="title" bind:value={title} placeholder={t('share.titleHint')} data-testid="share-title" />
      </label>

      {#if app.info?.features.ai && app.online}
        <div class="ai" data-testid="ai-suggest">
          <div class="row">
            <Icon name="sparkle" size={16} /><b>{t('share.ai')}</b>
            {#if aiLoading}<span class="hint">{t('ai.thinking')}</span>{:else}<button type="button" class="link" onclick={suggest}>{t('share.aiRefresh')}</button>{/if}
          </div>
          {#if ai}
            {#if ai.title && ai.title !== title}
              <div class="row"><span class="hint">{t('field.title')}</span><button type="button" class="chip" onclick={() => (title = ai!.title!)}>{ai.title}</button></div>
            {/if}
            {#if ai.folders.length}
              <div class="row">
                <span class="hint">{t('field.folder')}</span>
                {#each ai.folders as f (f.folderId)}
                  <button type="button" class="chip" class:on={folderId === f.folderId} onclick={() => (folderId = f.folderId)}>{f.path.join(' / ')}</button>
                {/each}
              </div>
            {/if}
            {#if ai.tags.length}
              <div class="row">
                <span class="hint">{t('field.tags')}</span>
                {#each ai.tags as tg (tg)}<button type="button" class="chip" onclick={() => addTag(tg)}>#{tg}</button>{/each}
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      <div class="field">
        <span>{t('share.location')}</span>
        <FolderPicker bind:library={lib} bind:folderId inboxOption {recent} />
      </div>
      <label class="field">
        <span>{t('field.tags')}</span>
        <input name="tags" bind:value={tags} placeholder={t('field.tagsHint')} />
      </label>
      <label class="field">
        <span>{t('field.notes')}</span>
        <textarea name="notes" bind:value={notes}></textarea>
      </label>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      {#if !app.online}<p class="hint">{t('share.offlineHint')}</p>{/if}
      <button class="btn primary full" type="submit" disabled={status === 'saving'} data-testid="share-save">{t('share.save')}</button>
    </form>
  {/if}
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  input,
  textarea {
    width: 100%;
  }
  .full {
    width: 100%;
  }
  .exists {
    display: flex;
    gap: 10px;
    background: var(--warn-bg);
    border-radius: var(--radius);
    padding: 10px 12px;
    font-size: 0.92rem;
  }
  .ai {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 10px 12px;
  }
  .done p {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
</style>
