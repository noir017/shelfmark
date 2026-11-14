<script lang="ts">
  import type { Diff } from '../api/types'
  import { t } from '../lib/i18n/index.svelte'
  import Icon from './Icon.svelte'

  let { diff }: { diff: Diff } = $props()
  const path = (p: string[]) => (p.length ? p.join(' / ') : t('folder.root'))
  const empty = $derived(!diff.added.length && !diff.removed.length && !diff.changed.length && !diff.moved.length)
</script>

<div class="diff" data-testid="diff">
  {#if empty}
    <p class="hint">{diff.reorderedCount ? t('diff.onlyReordered', { n: diff.reorderedCount }) : t('diff.empty')}</p>
  {/if}
  {#if diff.added.length}
    <section>
      <h4 class="add">+ {t('diff.added')} ({diff.added.length})</h4>
      <ul>
        {#each diff.added as it (it.id)}
          <li>
            <Icon name={it.type === 'folder' ? 'folder' : 'link'} size={15} />
            <span class="title">{it.title || it.url}</span>
            {#if it.type === 'folder' && it.childCount}<span class="badge">{t('diff.childCount', { n: it.childCount })}</span>{/if}
            <span class="path">{path(it.path)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if diff.removed.length}
    <section>
      <h4 class="del">− {t('diff.removed')} ({diff.removed.length})</h4>
      <ul>
        {#each diff.removed as it (it.id)}
          <li>
            <Icon name={it.type === 'folder' ? 'folder' : 'link'} size={15} />
            <span class="title">{it.title || it.url}</span>
            {#if it.type === 'folder' && it.childCount}<span class="badge">{t('diff.childCount', { n: it.childCount })}</span>{/if}
            <span class="path">{path(it.path)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if diff.changed.length}
    <section>
      <h4 class="chg">~ {t('diff.changed')} ({diff.changed.length})</h4>
      <ul>
        {#each diff.changed as c (c.id)}
          <li class="col">
            <span class="path">{path(c.path)}</span>
            {#if c.before.title !== c.after.title}
              <span><s>{c.before.title}</s> → <b>{c.after.title}</b></span>
            {/if}
            {#if c.before.url !== c.after.url}
              <span class="url"><s>{c.before.url}</s> → {c.after.url}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if diff.moved.length}
    <section>
      <h4 class="mov">↔ {t('diff.moved')} ({diff.moved.length})</h4>
      <ul>
        {#each diff.moved as m (m.id)}
          <li>
            <Icon name={m.type === 'folder' ? 'folder' : 'link'} size={15} />
            <span class="title">{m.title}</span>
            <span class="path">{path(m.fromPath)} → {path(m.toPath)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if diff.reorderedCount && !empty}<p class="hint">{t('diff.reordered', { n: diff.reorderedCount })}</p>{/if}
</div>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h4 {
    margin: 0 0 4px;
    font-size: 0.9rem;
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
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px dashed var(--border);
    min-width: 0;
    flex-wrap: wrap;
  }
  li.col {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .title {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .path,
  .url {
    color: var(--text-3);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
</style>
