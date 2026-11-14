<script lang="ts">
  import { t, type Key } from '../lib/i18n/index.svelte'
  import Dialog from './Dialog.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const keys: Array<[string, Key]> = [
    ['/', 'help.search'],
    ['j / k', 'help.move'],
    ['Enter', 'help.open'],
    ['e', 'help.edit'],
    ['Delete', 'help.delete'],
    ['n', 'help.new'],
    ['x', 'help.select'],
    ['Esc', 'help.escape'],
    ['?', 'help.help'],
  ]
</script>

<Dialog title={t('help.title')} {onclose}>
  <table class="list">
    <tbody>
      {#each keys as [k, label] (k)}
        <tr><td><kbd>{k}</kbd></td><td>{t(label)}</td></tr>
      {/each}
    </tbody>
  </table>
</Dialog>

<style>
  kbd {
    font-family: ui-monospace, monospace;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
  }
</style>
