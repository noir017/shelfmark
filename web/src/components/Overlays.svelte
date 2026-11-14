<script lang="ts">
  import { t } from '../lib/i18n/index.svelte'
  import { closeDialog, closeMenu, dialogs, menu } from '../lib/overlay.svelte'
  import { dismiss, toasts } from '../lib/toast.svelte'
  import Dialog from './Dialog.svelte'
  import Icon from './Icon.svelte'

  let text = $state('')
  let menuEl: HTMLDivElement | undefined = $state()

  $effect(() => {
    const d = dialogs.current
    text = d?.input?.value ?? ''
  })

  const canConfirm = $derived(
    !dialogs.current?.requireText || text.trim() === dialogs.current.requireText,
  )

  function confirm(e?: Event) {
    e?.preventDefault()
    if (!canConfirm) return
    const d = dialogs.current
    closeDialog(d?.input ? text.trim() || null : true)
  }

  // 菜单位置不超出视口
  let mx = $state(0)
  let my = $state(0)
  $effect(() => {
    if (!menu.open || !menuEl) return
    const r = menuEl.getBoundingClientRect()
    mx = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))
    my = Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))
    menuEl.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  })

  function menuKey(e: KeyboardEvent) {
    const items = [...(menuEl?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(i + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i - 1 + items.length) % items.length]?.focus()
    }
  }
</script>

<svelte:window
  onpointerdown={(e) => menu.open && !menuEl?.contains(e.target as Node) && closeMenu()}
  onscroll={() => menu.open && closeMenu()}
  onresize={() => menu.open && closeMenu()}
/>

{#if dialogs.current}
  {@const d = dialogs.current}
  <Dialog title={d.title} onclose={() => closeDialog(null)} testid="confirm-dialog">
    <form id="confirm-form" onsubmit={confirm}>
      {#if d.message}<p class="msg">{d.message}</p>{/if}
      {#if d.input}
        <label class="field">
          <span>{d.input.label}</span>
          <input bind:value={text} placeholder={d.input.placeholder} autofocus />
        </label>
      {/if}
      {#if d.requireText}
        <label class="field">
          <span>{t('confirm.typeToConfirm', { text: d.requireText })}</span>
          <input bind:value={text} autocomplete="off" autofocus />
        </label>
      {/if}
    </form>
    {#snippet footer()}
      <button type="button" class="btn" onclick={() => closeDialog(null)}>{t('common.cancel')}</button>
      <button type="submit" form="confirm-form" class="btn" class:primary={!d.danger} class:danger={d.danger} disabled={!canConfirm}>
        {d.confirmLabel ?? t('common.ok')}
      </button>
    {/snippet}
  </Dialog>
{/if}

{#if menu.open}
  <div class="menu" role="menu" tabindex="-1" bind:this={menuEl} style:left="{mx}px" style:top="{my}px" onkeydown={menuKey}>
    {#each menu.items as it (it.label)}
      <button
        type="button"
        role="menuitem"
        class:danger={it.danger}
        disabled={it.disabled}
        onclick={() => {
          closeMenu()
          it.run()
        }}
      >
        {#if it.icon}<Icon name={it.icon} size={16} />{/if}
        <span>{it.label}</span>
      </button>
    {/each}
  </div>
{/if}

<div class="toasts" aria-live="polite">
  {#each toasts as tst (tst.id)}
    <div class="toast {tst.kind}" role={tst.kind === 'error' ? 'alert' : 'status'} data-testid="toast">
      <span class="text">{tst.message}</span>
      {#if tst.action}
        {@const action = tst.action}
        <button
          type="button"
          class="link"
          onclick={() => {
            dismiss(tst.id)
            void action.run()
          }}>{action.label}</button
        >
      {/if}
      <button type="button" class="icon-btn" aria-label={t('common.close')} onclick={() => dismiss(tst.id)}><Icon name="close" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .msg {
    margin: 0 0 10px;
    white-space: pre-line;
    color: var(--text-2);
  }
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 180px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .menu button:hover,
  .menu button:focus-visible {
    background: var(--hover);
    outline: none;
  }
  .menu button.danger {
    color: var(--danger);
  }
  .menu button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .toasts {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(16px + var(--bottom-nav-h, 0px) + env(safe-area-inset-bottom));
    z-index: 70;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(520px, calc(100% - 24px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 14px;
    border-radius: var(--radius);
    background: var(--toast-bg);
    color: var(--toast-fg);
    box-shadow: var(--shadow-lg);
  }
  .toast.error {
    background: var(--danger);
    color: #fff;
  }
  .toast.warn {
    background: var(--warn-bg-strong);
    color: #1a1a1a;
  }
  .toast .text {
    flex: 1;
  }
  .toast .link {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
  }
  .toast .icon-btn {
    color: inherit;
  }
</style>
