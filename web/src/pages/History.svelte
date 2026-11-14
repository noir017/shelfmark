<script lang="ts">
  import { client, unwrap } from '../api'
  import type { Revision, RevisionDetail } from '../api/types'
  import DiffView from '../components/DiffView.svelte'
  import Icon from '../components/Icon.svelte'
  import { fmtDateTime, t } from '../lib/i18n/index.svelte'
  import { confirmDialog } from '../lib/overlay.svelte'
  import { app, errorText, refreshLibraries } from '../lib/stores/app.svelte'
  import { loadTree } from '../lib/stores/trees.svelte'
  import { toast } from '../lib/toast.svelte'

  let { params }: { params: Record<string, string>; query: URLSearchParams } = $props()
  const slug = params.slug

  let revs = $state<Revision[]>([])
  let next = $state<number | null>(null)
  let loading = $state(false)
  let error = $state('')
  let open = $state<number | null>(null)
  let details = $state<Record<number, RevisionDetail>>({})

  const lib = $derived(app.libraries.find((l) => l.slug === slug))
  const pending = $derived(app.pending.filter((p) => p.library === slug))

  async function load(more = false) {
    loading = true
    error = ''
    try {
      const r = await unwrap(client.GET('/api/v1/libraries/{slug}/revisions', { params: { path: { slug }, query: { before: more ? (next ?? undefined) : undefined, limit: 30 } } }))
      revs = more ? [...revs, ...r.items] : r.items
      next = r.nextBefore ?? null
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void load()
  })

  async function toggle(rev: number) {
    open = open === rev ? null : rev
    if (open !== null && !details[rev]) {
      try {
        details[rev] = await unwrap(client.GET('/api/v1/libraries/{slug}/revisions/{rev}', { params: { path: { slug, rev } } }))
      } catch (e) {
        toast(errorText(e), { kind: 'error' })
      }
    }
  }

  async function restore(r: Revision) {
    const ok = await confirmDialog({
      title: t('history.restoreTitle', { rev: r.rev }),
      message: t('history.restoreMessage', { time: fmtDateTime(r.createdAt) }),
      confirmLabel: t('history.restore'),
      danger: true,
    })
    if (!ok) return
    try {
      const w = await unwrap(client.POST('/api/v1/libraries/{slug}/revisions/{rev}/restore', { params: { path: { slug, rev: r.rev } } }))
      toast(t('history.restored', { rev: w.revision }), { kind: 'success' })
      await load()
      void loadTree(slug)
      void refreshLibraries()
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  const sourceLabel = (s: Revision['source']) => t(`source.${s}`)
</script>

<div class="page narrow">
  <div class="toolbar">
    <a class="icon-btn" href="/lib/{slug}" aria-label={t('common.back')}><Icon name="arrowLeft" /></a>
    <h1>{t('history.title', { name: lib?.name ?? slug })}</h1>
    <div class="spacer"></div>
    <a class="btn small" href="/deleted/{slug}"><Icon name="restore" size={15} />{t('manager.deletedItems')}</a>
  </div>

  {#each pending as p (p.id)}
    <a class="card pend" href="/pending/{slug}/{p.id}"><Icon name="warn" /> {t('history.pending', { actor: p.actor, n: p.removed })}</a>
  {/each}

  {#if error}<p class="error-text">{error}</p>{/if}
  <ol class="timeline" data-testid="revisions">
    {#each revs as r, i (r.rev)}
      <li class:open={open === r.rev} data-testid="revision">
        <button class="head" onclick={() => toggle(r.rev)} aria-expanded={open === r.rev}>
          <span class="rev">r{r.rev}</span>
          <span class="when">{fmtDateTime(r.createdAt)}</span>
          <span class="badge">{sourceLabel(r.source)}</span>
          <span class="actor ellipsis">{r.actor}</span>
          <span class="counts">
            {#if r.added}<span class="add">+{r.added}</span>{/if}
            {#if r.removed}<span class="del">−{r.removed}</span>{/if}
            {#if r.changed}<span class="chg">~{r.changed}</span>{/if}
            {#if r.moved}<span class="mov">↔{r.moved}</span>{/if}
          </span>
          <span class="hint total">{t('history.total', { n: r.totalBookmarks })}</span>
        </button>
        {#if open === r.rev}
          <div class="detail">
            {#if details[r.rev]}<DiffView diff={details[r.rev].diff} />{:else}<p class="hint">{t('common.loading')}</p>{/if}
            <div class="row actions">
              <span class="hint">{t('history.download')}</span>
              {#each ['html', 'xbel', 'json'] as f (f)}
                <a class="btn small" href="/api/v1/libraries/{slug}/revisions/{r.rev}/export?format={f}" download data-native>{f.toUpperCase()}</a>
              {/each}
              <div class="spacer"></div>
              {#if i > 0}
                <button class="btn small danger" onclick={() => restore(r)} data-testid="restore-revision">{t('history.restoreTo')}</button>
              {:else}
                <span class="hint">{t('history.current')}</span>
              {/if}
            </div>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
  {#if next}<button class="btn" onclick={() => load(true)} disabled={loading}>{t('common.loadMore')}</button>{/if}
  {#if !loading && !revs.length && !error}<p class="hint">{t('history.empty')}</p>{/if}
</div>

<style>
  .toolbar h1 {
    margin: 0;
  }
  .pend {
    display: flex;
    gap: 8px;
    align-items: center;
    background: var(--warn-bg);
    margin-bottom: 12px;
    color: var(--text);
  }
  .timeline {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .timeline li {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 10px 12px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rev {
    font-family: ui-monospace, monospace;
    color: var(--text-3);
  }
  .actor {
    max-width: 220px;
  }
  .counts {
    display: flex;
    gap: 6px;
    font-family: ui-monospace, monospace;
    font-size: 0.88rem;
  }
  .total {
    margin-left: auto;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--danger);
  }
  .chg {
    color: var(--warn);
  }
  .mov {
    color: var(--accent);
  }
  .detail {
    padding: 0 12px 12px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .actions {
    margin-top: 12px;
  }
</style>
