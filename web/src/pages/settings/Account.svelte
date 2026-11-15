<script lang="ts">
  import type { Settings } from '../../api/types'
  import FolderPicker from '../../components/FolderPicker.svelte'
  import { t } from '../../lib/i18n/index.svelte'
  import { app, defaultLibrary, errorText, saveSettings } from '../../lib/stores/app.svelte'
  import { toast } from '../../lib/toast.svelte'

  const s = $derived(app.settings)
  const identity = $derived(
    app.me?.authMethod === 'access'
      ? 'Cloudflare Access' + (app.me.email ? ' · ' + app.me.email : '')
      : t('account.localNetwork'),
  )

  let useDefault = $state(!!app.settings?.defaultSave)
  let defLib = $state(app.settings?.defaultSave?.library ?? defaultLibrary() ?? 'bookmarks')
  let defFolder = $state<number | null>(app.settings?.defaultSave?.folderId ?? 0)

  let startKind = $state<Settings['startLocation']['kind']>(app.settings?.startLocation?.kind ?? 'last')
  let startLib = $state(app.settings?.startLocation?.library ?? defaultLibrary() ?? 'bookmarks')
  let startFolder = $state<number | null>(app.settings?.startLocation?.folderId ?? 0)

  function saveStart() {
    if (startKind === 'folder') patch({ startLocation: { kind: 'folder', library: startLib, folderId: startFolder ?? 0 } })
    else patch({ startLocation: { kind: startKind } })
  }

  async function patch(p: Partial<Settings>) {
    try {
      await saveSettings(p)
      toast(t('common.saved'), { kind: 'success' })
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

</script>

{#if s}
  <div class="card">
    <h2>{t('account.prefs')}</h2>
    <p class="hint">{t('account.signedInAs', { user: app.me?.user.username ?? '' })} · {identity}</p>
    <label class="field">
      <span>{t('account.language')}</span>
      <select value={s.language} onchange={(e) => patch({ language: (e.currentTarget as HTMLSelectElement).value as Settings['language'] })} data-testid="language">
        <option value="auto">{t('account.auto')}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </label>
    <label class="field">
      <span>{t('account.theme')}</span>
      <select value={s.theme} onchange={(e) => patch({ theme: (e.currentTarget as HTMLSelectElement).value as Settings['theme'] })} data-testid="theme">
        <option value="system">{t('account.themeSystem')}</option>
        <option value="light">{t('account.themeLight')}</option>
        <option value="dark">{t('account.themeDark')}</option>
      </select>
    </label>
    <label class="field inline">
      <input type="checkbox" checked={s.openInNewTab} onchange={(e) => patch({ openInNewTab: (e.currentTarget as HTMLInputElement).checked })} />
      <span>{t('account.newTab')}</span>
    </label>
  </div>

  <div class="card">
    <h2>{t('account.startLocation')}</h2>
    <p class="hint">{t('account.startLocationHint')}</p>
    <label class="field">
      <span>{t('account.startLocation')}</span>
      <select bind:value={startKind}>
        <option value="last">{t('account.startLast')}</option>
        <option value="root">{t('account.startRoot')}</option>
        <option value="folder">{t('account.startFolder')}</option>
      </select>
    </label>
    {#if startKind === 'folder'}
      <FolderPicker bind:library={startLib} bind:folderId={startFolder} />
    {/if}
    <div class="row" style="margin-top: 10px">
      <button class="btn primary" onclick={saveStart}>{t('common.save')}</button>
    </div>
  </div>

  <div class="card">
    <h2>{t('account.defaultSave')}</h2>
    <p class="hint">{t('account.defaultSaveHint')}</p>
    <label class="field inline">
      <input type="checkbox" bind:checked={useDefault} />
      <span>{t('account.useDefaultSave')}</span>
    </label>
    {#if useDefault}
      <FolderPicker bind:library={defLib} bind:folderId={defFolder} />
    {/if}
    <div class="row" style="margin-top: 10px">
      <button class="btn primary" onclick={() => patch({ defaultSave: useDefault ? { library: defLib, folderId: defFolder ?? 0 } : null })} data-testid="save-default">{t('common.save')}</button>
    </div>
  </div>

{/if}

<style>
  select,
  input:not([type='checkbox']) {
    max-width: 360px;
    width: 100%;
  }
</style>
