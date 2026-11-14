<script lang="ts">
  import type { Snippet } from 'svelte'
  import { t } from '../lib/i18n/index.svelte'
  import Icon from './Icon.svelte'

  let {
    title,
    onclose,
    children,
    footer,
    wide = false,
    testid,
  }: { title: string; onclose: () => void; children: Snippet; footer?: Snippet; wide?: boolean; testid?: string } = $props()

  let box: HTMLDivElement
  let opener: Element | null = null

  $effect(() => {
    opener = document.activeElement
    const first = box.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), select, textarea, button:not(.x)')
    first?.focus()
    return () => (opener as HTMLElement | null)?.focus?.()
  })

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      onclose()
    } else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]')]
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="dialog" class:wide role="dialog" tabindex="-1" aria-modal="true" aria-label={title} bind:this={box} {onkeydown} data-testid={testid}>
    <header>
      <h2>{title}</h2>
      <button class="x icon-btn" type="button" aria-label={t('common.close')} onclick={onclose}><Icon name="close" /></button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 8vh 12px 12px;
    z-index: 50;
    overflow-y: auto;
  }
  .dialog {
    background: var(--surface);
    color: var(--text);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    width: min(480px, 100%);
    max-height: 84vh;
    display: flex;
    flex-direction: column;
  }
  .dialog.wide {
    width: min(760px, 100%);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 6px;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0;
  }
  .body {
    padding: 8px 16px 12px;
    overflow-y: auto;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid var(--border);
  }
</style>
