<script lang="ts">
  import { client, unwrap } from '../../api'
  import type { Library } from '../../api/types'
  import Dialog from '../../components/Dialog.svelte'
  import Icon from '../../components/Icon.svelte'
  import { fmtRelative, t } from '../../lib/i18n/index.svelte'
  import { confirmDialog } from '../../lib/overlay.svelte'
  import { app, errorText, refreshLibraries } from '../../lib/stores/app.svelte'
  import { toast } from '../../lib/toast.svelte'

  let edit = $state<null | { orig: Library | null; slug: string; name: string; error: string }>(null)

  $effect(() => {
    void refreshLibraries()
  })

  async function submit(e: Event) {
    e.preventDefault()
    const cur = edit
    if (!cur) return
    const { orig, slug, name } = cur
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug)) return (cur.error = t('libs.badSlug'))
    if (!name.trim()) return (cur.error = t('item.titleRequired'))
    try {
      if (!orig) {
        await unwrap(client.POST('/api/v1/libraries', { body: { slug, name: name.trim() } }))
        toast(t('libs.created'), { kind: 'success' })
      } else {
        if (slug !== orig.slug && !(await confirmDialog({ title: t('libs.renameSlugTitle'), message: t('libs.renameSlugMessage', { from: orig.davFile, to: slug + '.xbel' }), confirmLabel: t('common.ok') }))) return
        await unwrap(client.PATCH('/api/v1/libraries/{slug}', { params: { path: { slug: orig.slug } }, body: { name: name.trim(), ...(slug !== orig.slug ? { slug } : {}) } }))
        toast(t('common.saved'), { kind: 'success' })
      }
      edit = null
      await refreshLibraries()
    } catch (err) {
      cur.error = errorText(err)
    }
  }

  async function remove(l: Library) {
    const ok = await confirmDialog({
      title: t('libs.deleteTitle', { name: l.name }),
      message: t('libs.deleteMessage', { n: l.bookmarkCount }),
      requireText: l.slug,
      confirmLabel: t('menu.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await unwrap(client.DELETE('/api/v1/libraries/{slug}', { params: { path: { slug: l.slug }, query: { confirm: l.slug } } }))
      toast(t('libs.deleted'), { kind: 'success' })
      await refreshLibraries()
    } catch (err) {
      toast(errorText(err), { kind: 'error' })
    }
  }
</script>

<div class="card">
  <div class="row">
    <p class="hint spacer">{t('libs.intro')}</p>
    <button class="btn primary" onclick={() => (edit = { orig: null, slug: '', name: '', error: '' })} data-testid="new-library"><Icon name="plus" size={16} />{t('libs.new')}</button>
  </div>
  <table class="list" data-testid="library-list">
    <thead><tr><th>{t('libs.name')}</th><th>{t('libs.file')}</th><th class="wide-only">{t('libs.stats')}</th><th class="wide-only">{t('libs.sync')}</th><th></th></tr></thead>
    <tbody>
      {#each app.libraries as l (l.slug)}
        <tr data-testid="library-row">
          <td><a href="/lib/{l.slug}"><b>{l.name}</b></a></td>
          <td><code>{l.davFile}</code></td>
          <td class="hint wide-only">{t('sync.counts', { b: l.bookmarkCount, f: l.folderCount })} · r{l.revision}</td>
          <td class="hint wide-only">{l.lastSyncAt ? `${l.lastSyncActor} · ${fmtRelative(l.lastSyncAt)}` : t('sync.never')}</td>
          <td class="actions">
            <button class="btn small" onclick={() => (edit = { orig: l, slug: l.slug, name: l.name, error: '' })}>{t('menu.edit')}</button>
            <button class="btn small" onclick={() => remove(l)}>{t('menu.delete')}</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

{#if edit}
  <Dialog title={edit.orig ? t('libs.edit') : t('libs.new')} onclose={() => (edit = null)} testid="library-dialog">
    <form id="lib-form" onsubmit={submit}>
      <label class="field"><span>{t('libs.name')}</span><input name="name" bind:value={edit.name} required /></label>
      <label class="field">
        <span>{t('libs.slug')}</span>
        <input name="slug" bind:value={edit.slug} required autocomplete="off" />
        <small class="hint">{t('libs.slugHint', { file: (edit.slug || 'slug') + '.xbel' })}</small>
      </label>
      {#if edit.orig && edit.slug !== edit.orig.slug}<p class="warn">{t('libs.slugWarning')}</p>{/if}
      {#if edit.error}<p class="error-text">{edit.error}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn" onclick={() => (edit = null)}>{t('common.cancel')}</button>
      <button class="btn primary" type="submit" form="lib-form">{t('common.save')}</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .actions {
    white-space: nowrap;
    text-align: right;
  }
  input {
    width: 100%;
  }
  .warn {
    color: var(--warn);
  }
</style>
