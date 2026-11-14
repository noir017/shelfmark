<script lang="ts">
  import { api } from '../../api'
  import { errorFromResponse } from '../../api/client'
  import type { ImportMode, ImportResult } from '../../api/types'
  import Icon from '../../components/Icon.svelte'
  import { t } from '../../lib/i18n/index.svelte'
  import { app, defaultLibrary, errorText, refreshLibraries } from '../../lib/stores/app.svelte'
  import { loadTree } from '../../lib/stores/trees.svelte'
  import { toast } from '../../lib/toast.svelte'

  let impLib = $state(defaultLibrary() ?? 'bookmarks')
  let mode = $state<ImportMode>('folder')
  let folderName = $state('')
  let file = $state<File | null>(null)
  let busy = $state(false)
  let result = $state<ImportResult | null>(null)
  let error = $state('')

  let expLib = $state(defaultLibrary() ?? 'bookmarks')
  let format = $state<'html' | 'xbel' | 'json'>('html')

  async function doImport(e: Event) {
    e.preventDefault()
    if (!file) return
    error = ''
    result = null
    busy = true
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('mode', mode)
      if (mode === 'folder' && folderName.trim()) fd.append('folderName', folderName.trim())
      const res = await api.fetch(`/api/v1/libraries/${encodeURIComponent(impLib)}/import`, { method: 'POST', body: fd })
      if (!res.ok) throw await errorFromResponse(res)
      result = (await res.json()) as ImportResult
      toast(t('io.imported', { n: result.addedBookmarks }), { kind: 'success' })
      void loadTree(impLib, { force: true })
      void refreshLibraries()
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }
</script>

<form class="card" onsubmit={doImport}>
  <h2><Icon name="upload" size={18} /> {t('io.import')}</h2>
  <p class="hint">{t('io.importHint')}</p>
  <label class="field">
    <span>{t('field.library')}</span>
    <select bind:value={impLib}>{#each app.libraries as l (l.slug)}<option value={l.slug}>{l.name}</option>{/each}</select>
  </label>
  <div class="field">
    <span>{t('io.mode')}</span>
    {#each ['folder', 'merge', 'replace'] as const as m (m)}
      <label class="row opt"><input type="radio" bind:group={mode} value={m} /> <b>{t(`io.mode.${m}`)}</b> <span class="hint">{t(`io.mode.${m}.hint`)}</span></label>
    {/each}
  </div>
  {#if mode === 'folder'}
    <label class="field"><span>{t('io.folderName')}</span><input bind:value={folderName} placeholder={t('io.folderNamePlaceholder')} /></label>
  {/if}
  <label class="field">
    <span>{t('io.file')}</span>
    <input type="file" accept=".html,.htm,.xbel,.xml,.json,text/html,application/json,application/xml" onchange={(e) => (file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} data-testid="import-file" />
  </label>
  {#if mode === 'replace'}<p class="warn">{t('io.replaceWarning')}</p>{/if}
  {#if error}<p class="error-text">{error}</p>{/if}
  {#if result}
    <p class="ok" data-testid="import-result">{t('io.result', { b: result.addedBookmarks, f: result.addedFolders, s: result.skippedDuplicates, format: result.format.toUpperCase() })}</p>
  {/if}
  <button class="btn primary" type="submit" disabled={!file || busy} data-testid="import-submit">{t('io.importButton')}</button>
</form>

<div class="card">
  <h2><Icon name="download" size={18} /> {t('io.export')}</h2>
  <div class="row">
    <select bind:value={expLib} aria-label={t('field.library')}>{#each app.libraries as l (l.slug)}<option value={l.slug}>{l.name}</option>{/each}</select>
    <select bind:value={format} aria-label={t('io.format')}>
      <option value="html">{t('io.format.html')}</option>
      <option value="xbel">{t('io.format.xbel')}</option>
      <option value="json">{t('io.format.json')}</option>
    </select>
    <a class="btn primary" href="/api/v1/libraries/{expLib}/export?format={format}" download data-native data-testid="export-link">{t('io.exportButton')}</a>
  </div>
  <p class="hint">{t('io.exportHint')}</p>
</div>

<style>
  select,
  input:not([type='radio']) {
    max-width: 360px;
    width: 100%;
  }
  .row select {
    width: auto;
  }
  .opt {
    padding: 2px 0;
  }
  .warn {
    color: var(--warn);
  }
  .ok {
    color: var(--ok);
  }
</style>
