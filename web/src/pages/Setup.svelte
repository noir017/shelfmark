<script lang="ts">
  import { client, unwrap } from '../api'
  import Icon from '../components/Icon.svelte'
  import { t } from '../lib/i18n/index.svelte'
  import { afterLogin, app, errorText } from '../lib/stores/app.svelte'

  let username = $state('')
  let password = $state('')
  let confirm = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(e: Event) {
    e.preventDefault()
    error = ''
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username.trim())) return (error = t('setup.badUsername'))
    if (password.length < 8) return (error = t('setup.shortPassword'))
    if (password !== confirm) return (error = t('setup.mismatch'))
    busy = true
    try {
      const me = await unwrap(client.POST('/api/v1/setup', { body: { username: username.trim(), password } }))
      if (app.info) app.info.needsSetup = false
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
    <h1><Icon name="bookmark" size={22} /> {t('setup.title')}</h1>
    <p class="hint">{t('setup.intro')}</p>
    <form onsubmit={submit}>
      <label class="field">
        <span>{t('field.username')}</span>
        <input name="username" autocomplete="username" bind:value={username} required autofocus />
      </label>
      <label class="field">
        <span>{t('field.password')}</span>
        <input name="password" type="password" autocomplete="new-password" bind:value={password} required minlength="8" />
      </label>
      <label class="field">
        <span>{t('field.passwordConfirm')}</span>
        <input name="confirm" type="password" autocomplete="new-password" bind:value={confirm} required />
      </label>
      {#if error}<p class="error-text" role="alert">{error}</p>{/if}
      <button class="btn primary full" type="submit" disabled={busy}>{t('setup.submit')}</button>
    </form>
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
    width: min(400px, 100%);
  }
  h1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input {
    width: 100%;
  }
  .full {
    width: 100%;
  }
</style>
