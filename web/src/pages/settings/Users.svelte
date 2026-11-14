<script lang="ts">
  import { client, unwrap } from '../../api'
  import type { User } from '../../api/types'
  import Dialog from '../../components/Dialog.svelte'
  import Icon from '../../components/Icon.svelte'
  import { fmtDateTime, t } from '../../lib/i18n/index.svelte'
  import { confirmDialog } from '../../lib/overlay.svelte'
  import { app, errorText } from '../../lib/stores/app.svelte'
  import { toast } from '../../lib/toast.svelte'

  let users = $state<User[]>([])
  let error = $state('')
  let creating = $state<null | { username: string; isAdmin: boolean; error: string }>(null)

  async function load() {
    try {
      users = await unwrap(client.GET('/api/v1/users'))
    } catch (e) {
      error = errorText(e)
    }
  }
  $effect(() => {
    void load()
  })

  async function create(e: Event) {
    e.preventDefault()
    const cur = creating
    if (!cur) return
    try {
      await unwrap(client.POST('/api/v1/users', { body: { username: cur.username.trim(), isAdmin: cur.isAdmin } }))
      toast(t('users.created'), { kind: 'success' })
      creating = null
      await load()
    } catch (err) {
      cur.error = errorText(err)
    }
  }

  async function toggleAdmin(u: User) {
    try {
      await unwrap(client.PATCH('/api/v1/users/{userId}', { params: { path: { userId: u.id } }, body: { isAdmin: !u.isAdmin } }))
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  async function remove(u: User) {
    if (!(await confirmDialog({ title: t('users.deleteTitle', { name: u.username }), message: t('users.deleteMessage'), requireText: u.username, confirmLabel: t('menu.delete'), danger: true }))) return
    try {
      await unwrap(client.DELETE('/api/v1/users/{userId}', { params: { path: { userId: u.id } } }))
      toast(t('users.deleted'), { kind: 'success' })
      await load()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }
</script>

<div class="card">
  <div class="row">
    <p class="hint spacer">{t('users.intro')}</p>
    <button class="btn primary" onclick={() => (creating = { username: '', isAdmin: false, error: '' })} data-testid="new-user"><Icon name="plus" size={16} />{t('users.new')}</button>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
  <table class="list" data-testid="user-list">
    <tbody>
      {#each users as u (u.id)}
        <tr data-testid="user-row">
          <td><b>{u.username}</b> {#if u.isAdmin}<span class="badge">{t('users.admin')}</span>{/if}{#if u.id === app.me?.user.id}<span class="badge">{t('users.you')}</span>{/if}</td>
          <td class="hint wide-only">{fmtDateTime(u.createdAt)}</td>
          <td class="actions">
            <button class="btn small" onclick={() => toggleAdmin(u)} disabled={u.id === app.me?.user.id}>{u.isAdmin ? t('users.revokeAdmin') : t('users.makeAdmin')}</button>
            <button class="btn small" onclick={() => remove(u)} disabled={u.id === app.me?.user.id}>{t('menu.delete')}</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

{#if creating}
  <Dialog title={t('users.new')} onclose={() => (creating = null)} testid="user-dialog">
    <form id="user-form" onsubmit={create}>
      <label class="field"><span>{t('field.username')}</span><input name="username" bind:value={creating.username} required autocomplete="off" /></label>
      <label class="field inline"><input type="checkbox" bind:checked={creating.isAdmin} /><span>{t('users.admin')}</span></label>
      {#if creating.error}<p class="error-text">{creating.error}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn" onclick={() => (creating = null)}>{t('common.cancel')}</button>
      <button class="btn primary" type="submit" form="user-form">{t('common.create')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .actions {
    text-align: right;
    white-space: nowrap;
  }
  .actions .btn {
    margin-left: 4px;
  }
  input:not([type='checkbox']) {
    width: 100%;
  }
  @media (max-width: 699px) {
    .actions {
      white-space: normal;
    }
  }
</style>
