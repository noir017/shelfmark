<script lang="ts">
  import { onMount } from 'svelte'
  import { client, unwrap } from '../api'
  import { AccessExpiredError } from '../api/client'
  import Icon from '../components/Icon.svelte'
  import { t } from '../lib/i18n/index.svelte'
  import { afterLogin, app, errorText } from '../lib/stores/app.svelte'

  let username = $state('')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)
  let sso = $state(false)

  onMount(async () => {
    if (!app.info?.features.cfAccessSso || app.me) return
    sso = true
    try {
      const me = await unwrap(client.POST('/api/v1/auth/access'))
      await afterLogin(me)
    } catch (e) {
      if (e instanceof AccessExpiredError) error = errorText(e)
      // 401/503：Access 身份没有映射，退回密码登录
    } finally {
      sso = false
    }
  })

  async function submit(e: Event) {
    e.preventDefault()
    error = ''
    busy = true
    try {
      const me = await unwrap(client.POST('/api/v1/auth/login', { body: { username: username.trim(), password } }))
      await afterLogin(me)
    } catch (err) {
      error = errorText(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="auth">
  <div class="card">
    <h1><Icon name="bookmark" size={22} /> shelfmark</h1>
    {#if sso}
      <p class="hint" data-testid="sso-trying">{t('login.sso')}</p>
    {:else}
      <form onsubmit={submit}>
        <label class="field">
          <span>{t('field.username')}</span>
          <input name="username" autocomplete="username" bind:value={username} required autofocus />
        </label>
        <label class="field">
          <span>{t('field.password')}</span>
          <input name="password" type="password" autocomplete="current-password" bind:value={password} required />
        </label>
        {#if error}<p class="error-text" role="alert">{error}</p>{/if}
        <button class="btn primary full" type="submit" disabled={busy}>{t('login.submit')}</button>
      </form>
    {/if}
  </div>
</div>

<style>
  .auth {
    min-height: 80vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .card {
    width: min(380px, 100%);
  }
  h1 {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
  }
  input {
    width: 100%;
  }
  .full {
    width: 100%;
  }
</style>
