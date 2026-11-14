<script lang="ts">
  import { client, unwrap } from '../api'
  import type { PendingDetail } from '../api/types'
  import DiffView from '../components/DiffView.svelte'
  import Icon from '../components/Icon.svelte'
  import { fmtDateTime, t } from '../lib/i18n/index.svelte'
  import { confirmDialog } from '../lib/overlay.svelte'
  import { errorText, refreshLibraries, refreshPending } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { toast } from '../lib/toast.svelte'

  let { params }: { params: Record<string, string>; query: URLSearchParams } = $props()
  const slug = params.slug
  const id = Number(params.id)

  let detail = $state<PendingDetail | null>(null)
  let error = $state('')
  let done = $state<'approved' | 'discarded' | null>(null)
  let busy = $state(false)

  $effect(() => {
    unwrap(client.GET('/api/v1/libraries/{slug}/pending/{pendingId}', { params: { path: { slug, pendingId: id } } }))
      .then((d) => (detail = d))
      .catch((e) => (error = errorText(e)))
  })

  async function approve() {
    if (!detail) return
    const ok = await confirmDialog({ title: t('pending.approveTitle'), message: t('pending.approveMessage', { n: detail.pending.removed }), confirmLabel: t('pending.approve'), danger: true })
    if (!ok) return
    busy = true
    try {
      await unwrap(client.POST('/api/v1/libraries/{slug}/pending/{pendingId}/approve', { params: { path: { slug, pendingId: id } } }))
      done = 'approved'
      toast(t('pending.approved'), { kind: 'success' })
      void loadTree(slug)
      void refreshLibraries()
      void refreshPending()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    } finally {
      busy = false
    }
  }

  async function discard() {
    const ok = await confirmDialog({ title: t('pending.discardTitle'), message: t('pending.discardMessage'), confirmLabel: t('pending.discard') })
    if (!ok) return
    busy = true
    try {
      await unwrap(client.POST('/api/v1/libraries/{slug}/pending/{pendingId}/discard', { params: { path: { slug, pendingId: id } } }))
      done = 'discarded'
      void refreshLibraries()
      void refreshPending()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    } finally {
      busy = false
    }
  }
</script>

<div class="page narrow">
  <div class="toolbar">
    <a class="icon-btn" href="/history/{slug}" aria-label={t('common.back')}><Icon name="arrowLeft" /></a>
    <h1>{t('pending.title')}</h1>
  </div>

  {#if error}
    <p class="error-text">{error}</p>
  {:else if done === 'approved'}
    <div class="card" data-testid="pending-done"><p><Icon name="check" /> {t('pending.approved')}</p><a class="btn" href="/lib/{slug}">{t('share.view')}</a></div>
  {:else if done === 'discarded'}
    <div class="card" data-testid="pending-done">
      <p><Icon name="check" /> {t('pending.discarded')}</p>
      <p class="hint">{t('pending.floccusHint')}</p>
    </div>
  {:else if detail}
    {@const p = detail.pending}
    <div class="card">
      <p class="reason"><Icon name="warn" /> {p.reason}</p>
      <dl>
        <dt>{t('pending.device')}</dt><dd>{p.actor}</dd>
        <dt>{t('pending.time')}</dt><dd>{fmtDateTime(p.createdAt)}</dd>
        <dt>{t('pending.before')}</dt><dd>{p.totalBefore}</dd>
        <dt>{t('pending.changes')}</dt><dd><span class="add">+{p.added}</span> <span class="del">−{p.removed}</span> ~{p.changed} ↔{p.moved}</dd>
      </dl>
      <div class="row">
        <button class="btn danger" onclick={approve} disabled={busy} data-testid="pending-approve">{t('pending.approve')}</button>
        <button class="btn" onclick={discard} disabled={busy} data-testid="pending-discard">{t('pending.discard')}</button>
      </div>
      <p class="hint">{t('pending.explain')}</p>
    </div>
    <div class="card">
      <h2>{t('pending.diff')}</h2>
      <DiffView diff={detail.diff} />
    </div>
  {:else}
    <p class="hint">{t('common.loading')}</p>
  {/if}
</div>

<style>
  .toolbar h1 {
    margin: 0;
  }
  .reason {
    display: flex;
    gap: 8px;
    align-items: center;
    font-weight: 600;
    color: var(--warn);
    margin-top: 0;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 14px;
  }
  dt {
    color: var(--text-3);
  }
  dd {
    margin: 0;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--danger);
  }
</style>
