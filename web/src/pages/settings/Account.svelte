<script lang="ts">
  import { client, unwrap } from '../../api'
  import type { Settings } from '../../api/types'
  import FolderPicker from '../../components/FolderPicker.svelte'
  import { t } from '../../lib/i18n/index.svelte'
  import { app, defaultLibrary, errorText, saveSettings } from '../../lib/stores/app.svelte'
  import { toast } from '../../lib/toast.svelte'

  const s = $derived(app.settings)
  let cur = $state('')
  let next = $state('')
  let next2 = $state('')
  let pwError = $state('')

  let useDefault = $state(!!app.settings?.defaultSave)
  let defLib = $state(app.settings?.defaultSave?.library ?? defaultLibrary() ?? 'bookmarks')
  let defFolder = $state<number | null>(app.settings?.defaultSave?.folderId ?? 0)

  async function patch(p: Partial<Settings>) {
    try {
      await saveSettings(p)
      toast(t('common.saved'), { kind: 'success' })
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  async function changePassword(e: Event) {
    e.preventDefault()
    pwError = ''
    if (next.length < 8) return (pwError = t('setup.shortPassword'))
    if (next !== next2) return (pwError = t('setup.mismatch'))
    try {
      await unwrap(client.POST('/api/v1/auth/password', { body: { currentPassword: cur, newPassword: next } }))
      cur = next = next2 = ''
      toast(t('account.passwordChanged'), { kind: 'success' })
    } catch (err) {
      pwError = errorText(err)
    }
  }
</script>

{#if s}
  <div class="card">
    <h2>{t('account.prefs')}</h2>
    <p class="hint">{t('account.signedInAs', { user: app.me?.user.username ?? '' })}{app.me?.authMethod === 'access' ? ' · Cloudflare Access' : ''}</p>
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

  {#if app.me?.authMethod !== 'token'}
    <form class="card" onsubmit={changePassword}>
      <h2>{t('account.password')}</h2>
      <label class="field"><span>{t('account.currentPassword')}</span><input type="password" autocomplete="current-password" bind:value={cur} required /></label>
      <label class="field"><span>{t('account.newPassword')}</span><input type="password" autocomplete="new-password" bind:value={next} required /></label>
      <label class="field"><span>{t('field.passwordConfirm')}</span><input type="password" autocomplete="new-password" bind:value={next2} required /></label>
      {#if pwError}<p class="error-text">{pwError}</p>{/if}
      <button class="btn" type="submit">{t('account.changePassword')}</button>
    </form>
  {/if}
{/if}

<style>
  select,
  input:not([type='checkbox']) {
    max-width: 360px;
    width: 100%;
  }
</style>
