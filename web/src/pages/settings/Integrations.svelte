<script lang="ts">
  import { client, unwrap } from '../../api'
  import type { Job, JobName } from '../../api/types'
  import Icon from '../../components/Icon.svelte'
  import { fmtRelative, t } from '../../lib/i18n/index.svelte'
  import { app, errorText } from '../../lib/stores/app.svelte'
  import { toast } from '../../lib/toast.svelte'

  let ai = $state<{ enabled: boolean; model?: string | null } | null>(null)
  let jobs = $state<Job[]>([])
  let jobsError = $state('')

  // 插件包文件名由服务端决定，这里按约定列出（见汇报的契约问题）
  const downloads = [
    { file: 'shelfmark-chrome.zip', label: 'Chrome / Edge / Brave' },
    { file: 'shelfmark-firefox.zip', label: 'Firefox' },
  ]

  const origin = typeof location !== 'undefined' ? location.origin : ''
  const bookmarklet = $derived(
    `javascript:(function(){var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);window.open('${origin}/add?url='+u+'&title='+t,'shelfmark','width=560,height=720');})();`,
  )

  async function loadJobs() {
    try {
      jobs = await unwrap(client.GET('/api/v1/jobs'))
    } catch (e) {
      jobsError = errorText(e)
    }
  }

  $effect(() => {
    unwrap(client.GET('/api/v1/ai/status')).then((s) => (ai = s), () => (ai = null))
    void loadJobs()
  })

  async function run(name: JobName) {
    try {
      await unwrap(client.POST('/api/v1/jobs/{name}/run', { params: { path: { name } } }))
      toast(t('jobs.started', { name: t(`jobs.${name}`) }), { kind: 'success' })
      await loadJobs()
      setTimeout(loadJobs, 1500)
    } catch (e) {
      toast(errorText(e), { kind: 'error' })
    }
  }

  const adminOnly = (n: JobName) => ['backup', 'retention', 'cleanup'].includes(n)
</script>

<div class="card">
  <h2><Icon name="puzzle" size={18} /> {t('int.extension')}</h2>
  <p class="hint">{t('int.extensionHint')}</p>
  <div class="row">
    {#each downloads as d (d.file)}
      <a class="btn" href="/downloads/{d.file}" download data-native><Icon name="download" size={16} />{d.label}</a>
    {/each}
  </div>
  <ol class="hint steps">
    <li>{t('int.step1')}</li>
    <li>{t('int.step2')}</li>
    <li>{t('int.step3')}</li>
  </ol>
</div>

<div class="card">
  <h2><Icon name="bookmark-plus" size={18} /> {t('int.bookmarklet')}</h2>
  <p class="hint">{t('int.bookmarkletHint')}</p>
  <!-- svelte-ignore a11y_invalid_attribute -->
  <a class="btn bm" href={bookmarklet} data-native onclick={(e) => e.preventDefault()} data-testid="bookmarklet">{t('int.bookmarkletName')}</a>
</div>

<div class="card">
  <h2><Icon name="sparkle" size={18} /> {t('int.ai')}</h2>
  {#if ai}
    <p data-testid="ai-status">
      {#if ai.enabled}<span class="badge ok">{t('int.aiOn')}</span> {ai.model}{:else}<span class="badge">{t('int.aiOff')}</span>{/if}
    </p>
    <p class="hint">{ai.enabled ? t('int.aiOnHint') : t('int.aiOffHint')}</p>
  {:else}
    <p class="hint">{t('common.loading')}</p>
  {/if}
</div>

<div class="card">
  <div class="row">
    <h2 class="spacer"><Icon name="clock" size={18} /> {t('int.jobs')}</h2>
    <button class="btn small" onclick={loadJobs}><Icon name="sync" size={14} />{t('common.refresh')}</button>
  </div>
  {#if jobsError}<p class="error-text">{jobsError}</p>{/if}
  <table class="list" data-testid="jobs">
    <tbody>
      {#each jobs as j (j.name)}
        <tr data-testid="job-row">
          <td><b>{t(`jobs.${j.name}`)}</b><div class="hint">{j.enabled ? t('jobs.next', { time: fmtRelative(j.nextRunAt) }) : t('jobs.disabled')}</div></td>
          <td class="hint">
            {#if j.running}<span class="badge warn">{t('jobs.running')}</span>{:else if j.lastOk === false}<span class="badge danger">{t('jobs.failed')}</span>{/if}
            {fmtRelative(j.lastFinishedAt)}{j.lastSummary ? ' · ' + j.lastSummary : ''}
          </td>
          <td>
            <button class="btn small" onclick={() => run(j.name)} disabled={j.running || !j.enabled || (adminOnly(j.name) && !app.me?.user.isAdmin)}>{t('jobs.run')}</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .steps {
    margin: 10px 0 0;
    padding-left: 20px;
  }
  .bm {
    cursor: grab;
    border-style: dashed;
  }
  .badge.ok {
    background: var(--ok);
    color: #fff;
  }
</style>
