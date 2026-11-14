<script lang="ts">
  import { client, unwrap } from '../api'
  import type { AiOrganizeResult, BatchOp } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import { errorText } from '../lib/stores/app.svelte'
  import Dialog from './Dialog.svelte'

  let {
    slug,
    folderId,
    onapply,
    onclose,
  }: { slug: string; folderId: number; onapply: (ops: BatchOp[]) => Promise<void>; onclose: () => void } = $props()

  let result = $state<AiOrganizeResult | null>(null)
  let error = $state('')
  let chosen = $state<number[]>([])

  $effect(() => {
    unwrap(client.POST('/api/v1/ai/organize', { body: { library: slug, folderId, limit: 100 } }))
      .then((r) => {
        result = r
        chosen = r.suggestions.filter((s) => s.folderId !== folderId).map((s) => s.itemId)
      })
      .catch((e) => (error = errorText(e)))
  })

  async function apply(all: boolean) {
    if (!result) return
    const ops: BatchOp[] = []
    for (const s of result.suggestions) {
      if (!all && !chosen.includes(s.itemId)) continue
      if (s.folderId !== folderId) ops.push({ op: 'move', id: s.itemId, parentId: s.folderId })
      if (s.tags.length) ops.push({ op: 'tag', id: s.itemId, add: s.tags })
    }
    if (ops.length) await onapply(ops)
    onclose()
  }
</script>

<Dialog title={t('ai.organizeTitle')} {onclose} wide testid="ai-dialog">
  {#if error}
    <p class="error-text">{error}</p>
  {:else if !result}
    <p class="hint">{t('ai.thinking')}</p>
  {:else if !result.suggestions.length}
    <p class="hint">{t('ai.nothing')}</p>
  {:else}
    <table class="list">
      <tbody>
        {#each result.suggestions as s (s.itemId)}
          <tr>
            <td><input type="checkbox" bind:group={chosen} value={s.itemId} aria-label={s.title} /></td>
            <td class="ellipsis">{s.title}</td>
            <td class="hint">→ {s.path.join(' / ') || t('folder.root')}</td>
            <td>{#each s.tags as tg (tg)}<span class="tag">#{tg}</span> {/each}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>{t('common.cancel')}</button>
    <button type="button" class="btn" disabled={!result?.suggestions.length} onclick={() => apply(true)}>{t('ai.acceptAll')}</button>
    <button type="button" class="btn primary" disabled={!chosen.length} onclick={() => apply(false)}>{t('ai.acceptSelected')}</button>
  {/snippet}
</Dialog>
