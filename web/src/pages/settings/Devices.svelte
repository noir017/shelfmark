<script lang="ts">
  import { client, unwrap } from '../../api'
  import type { FloccusSetup, Scope, Token, TokenCreated } from '../../api/types'
  import Dialog from '../../components/Dialog.svelte'
  import Icon from '../../components/Icon.svelte'
  import { fmtRelative, t } from '../../lib/i18n/index.svelte'
  import { confirmDialog } from '../../lib/overlay.svelte'
  import { app, defaultLibrary, errorText } from '../../lib/stores/app.svelte'
  import { toast } from '../../lib/toast.svelte'

  let tokens = $state<Token[]>([])
  let error = $state('')
  let wizard = $state<null | { step: 1 | 2; library: string; device: string; result: FloccusSetup | null; busy: boolean }>(null)
  let apiDlg = $state<null | { name: string; scopes: Scope[]; result: TokenCreated | null }>(null)

  async function load() {
    try {
      tokens = await unwrap(client.GET('/api/v1/tokens'))
    } catch (e) {
      error = errorText(e)
    }
  }
  $effect(() => {
    void load()
  })

  async function revoke(tk: Token) {
    if (!(await confirmDialog({ title: t('devices.revokeTitle', { name: tk.name }), message: t('devices.revokeMessage'), confirmLabel: t('devices.revoke'), danger: true }))) return
    try {
      await unwrap(client.DELETE('/api/v1/tokens/{tokenId}', { params: { path: { tokenId: tk.id } } }))
      toast(t('devices.revoked'), { kind: 'success' })
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  function guessDevice(): string {
    const ua = navigator.userAgent
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : ''
    return `Floccus · ${b}${os ? ' · ' + os : ''}`
  }

  async function runWizard(e: Event) {
    e.preventDefault()
    if (!wizard) return
    wizard.busy = true
    try {
      wizard.result = await unwrap(client.POST('/api/v1/floccus/setup', { body: { library: wizard.library, deviceName: wizard.device.trim() || guessDevice() } }))
      wizard.step = 2
      void load()
    } catch (err) {
      toast(errorText(err), { kind: 'error' })
    } finally {
      wizard.busy = false
    }
  }

  async function createApiToken(e: Event) {
    e.preventDefault()
    if (!apiDlg || !apiDlg.name.trim() || !apiDlg.scopes.length) return
    try {
      apiDlg.result = await unwrap(client.POST('/api/v1/tokens', { body: { name: apiDlg.name.trim(), scopes: apiDlg.scopes } }))
      void load()
    } catch (err) {
      toast(errorText(err), { kind: 'error' })
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => toast(t('common.copied')),
      () => toast(t('common.copyFailed'), { kind: 'error' }),
    )
  }

  function downloadProfile(r: FloccusSetup) {
    const blob = new Blob([JSON.stringify(r.profile, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = r.profileFileName ?? `floccus-${r.library}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
</script>

<div class="card">
  <div class="row">
    <button class="btn primary" onclick={() => (wizard = { step: 1, library: defaultLibrary() ?? 'bookmarks', device: '', result: null, busy: false })} data-testid="floccus-wizard">
      <Icon name="sync" size={16} />{t('devices.addFloccus')}
    </button>
    <button class="btn" onclick={() => (apiDlg = { name: '', scopes: ['api'], result: null })} data-testid="api-token"><Icon name="key" size={16} />{t('devices.addToken')}</button>
  </div>
  <p class="hint">{t('devices.intro')}</p>
</div>

<div class="card">
  <h2>{t('devices.list')}</h2>
  {#if error}<p class="error-text">{error}</p>{/if}
  <table class="list" data-testid="token-list">
    <thead><tr><th>{t('devices.name')}</th><th>{t('devices.scopes')}</th><th class="wide-only">{t('devices.lastUsed')}</th><th></th></tr></thead>
    <tbody>
      {#each tokens as tk (tk.id)}
        <tr data-testid="token-row">
          <td><b>{tk.name}</b><div class="hint"><code>{tk.prefix}…</code> · {t('devices.created', { time: fmtRelative(tk.createdAt) })}</div></td>
          <td>{#each tk.scopes as sc (sc)}<span class="badge">{sc}</span> {/each}</td>
          <td class="hint wide-only">{fmtRelative(tk.lastUsedAt)}{tk.lastUsedIp ? ' · ' + tk.lastUsedIp : ''}</td>
          <td><button class="btn small" onclick={() => revoke(tk)}>{t('devices.revoke')}</button></td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !tokens.length}<p class="hint">{t('devices.none')}</p>{/if}
</div>

{#if wizard}
  <Dialog title={t('devices.addFloccus')} onclose={() => (wizard = null)} testid="floccus-dialog">
    {#if wizard.step === 1}
      <form id="wizard-form" onsubmit={runWizard}>
        <p class="hint">{t('devices.wizardIntro')}</p>
        <label class="field">
          <span>{t('field.library')}</span>
          <select bind:value={wizard.library}>
            {#each app.libraries as l (l.slug)}<option value={l.slug}>{l.name} ({l.davFile})</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t('devices.deviceName')}</span>
          <input bind:value={wizard.device} placeholder={guessDevice()} />
        </label>
      </form>
    {:else if wizard.result}
      {@const r = wizard.result}
      <p>{t('devices.wizardDone')}</p>
      <dl class="creds" data-testid="floccus-result">
        {#each [[t('devices.davUrl'), r.davUrl], [t('field.username'), r.username], [t('field.password'), r.token.token], [t('devices.bookmarkFile'), r.bookmarkFile]] as [label, value] (label)}
          <dt>{label}</dt>
          <dd><code>{value}</code><button class="icon-btn" aria-label={t('common.copy')} onclick={() => copy(value)}><Icon name="copy" size={16} /></button></dd>
        {/each}
      </dl>
      <p class="hint">{t('devices.wizardSteps')}</p>
      <p class="warn-text">{t('devices.onlyOnce')}</p>
      {#if r.profile}
        <button class="btn" onclick={() => downloadProfile(r)}><Icon name="download" size={16} />{t('devices.downloadProfile')}</button>
      {/if}
    {/if}
    {#snippet footer()}
      {#if wizard?.step === 1}
        <button class="btn" onclick={() => (wizard = null)}>{t('common.cancel')}</button>
        <button class="btn primary" type="submit" form="wizard-form" disabled={wizard.busy}>{t('devices.generate')}</button>
      {:else}
        <button class="btn primary" onclick={() => (wizard = null)}>{t('common.done')}</button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

{#if apiDlg}
  <Dialog title={t('devices.addToken')} onclose={() => (apiDlg = null)} testid="token-dialog">
    {#if !apiDlg.result}
      <form id="token-form" onsubmit={createApiToken}>
        <label class="field"><span>{t('devices.name')}</span><input bind:value={apiDlg.name} placeholder={t('devices.tokenPlaceholder')} required /></label>
        <div class="field">
          <span>{t('devices.scopes')}</span>
          <label class="row"><input type="checkbox" bind:group={apiDlg.scopes} value="api" /> api — {t('devices.scopeApi')}</label>
          <label class="row"><input type="checkbox" bind:group={apiDlg.scopes} value="dav" /> dav — {t('devices.scopeDav')}</label>
        </div>
      </form>
    {:else}
      {@const tok = apiDlg.result.token}
      <p>{t('devices.tokenCreated')}</p>
      <div class="row"><code class="token" data-testid="new-token">{tok}</code><button class="icon-btn" aria-label={t('common.copy')} onclick={() => copy(tok)}><Icon name="copy" size={16} /></button></div>
      <p class="warn-text">{t('devices.onlyOnce')}</p>
    {/if}
    {#snippet footer()}
      {#if !apiDlg?.result}
        <button class="btn" onclick={() => (apiDlg = null)}>{t('common.cancel')}</button>
        <button class="btn primary" type="submit" form="token-form">{t('common.create')}</button>
      {:else}
        <button class="btn primary" onclick={() => (apiDlg = null)}>{t('common.done')}</button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .creds {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 12px;
    align-items: center;
  }
  dt {
    color: var(--text-3);
    font-size: 0.88rem;
  }
  dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  code {
    overflow-wrap: anywhere;
    background: var(--surface-2);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .token {
    flex: 1;
  }
  .warn-text {
    color: var(--warn);
    font-size: 0.9rem;
  }
  input,
  select {
    width: 100%;
  }
  input[type='checkbox'] {
    width: 16px;
  }
</style>
