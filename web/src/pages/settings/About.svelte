<script lang="ts">
  import { fmtNumber, t } from '../../lib/i18n/index.svelte'
  import { app, refreshLibraries } from '../../lib/stores/app.svelte'

  $effect(() => {
    void refreshLibraries()
  })
  const totals = $derived(app.libraries.reduce((a, l) => ({ b: a.b + l.bookmarkCount, f: a.f + l.folderCount, r: a.r + l.revision }), { b: 0, f: 0, r: 0 }))
  const feats = $derived(app.info ? Object.entries(app.info.features) : [])
</script>

<div class="card" data-testid="about">
  <dl>
    <dt>{t('about.version')}</dt><dd>{app.info?.version} <span class="hint">({app.info?.commit})</span></dd>
    <dt>{t('about.web')}</dt><dd>{__APP_VERSION__}</dd>
    <dt>WebDAV</dt><dd><code>{app.info?.baseUrl ?? location.origin}{app.info?.davPath}</code></dd>
    <dt>{t('about.libraries')}</dt><dd>{app.libraries.length}</dd>
    <dt>{t('about.bookmarks')}</dt><dd>{fmtNumber(totals.b)}</dd>
    <dt>{t('about.folders')}</dt><dd>{fmtNumber(totals.f)}</dd>
    <dt>{t('about.revisions')}</dt><dd>{fmtNumber(totals.r)}</dd>
    <dt>{t('about.features')}</dt>
    <dd class="row">{#each feats as [k, v] (k)}<span class="badge" class:on={v}>{k}: {v ? '✓' : '—'}</span>{/each}</dd>
  </dl>
</div>
<p class="hint">{t('about.shortcuts')}</p>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 18px;
    margin: 0;
  }
  dt {
    color: var(--text-3);
  }
  dd {
    margin: 0;
  }
  .badge.on {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
</style>
