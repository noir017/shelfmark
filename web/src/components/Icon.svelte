<script lang="ts" module>
  // 线条图标（24×24，stroke）
  const P: Record<string, string> = {
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
    'folder-open': 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h8A1.5 1.5 0 0 1 20 9.5V11M3 7.5v10L5.5 11h17L20 18.5H4.5',
    link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
    home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5',
    settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    plus: 'M12 5v14M5 12h14',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
    check: 'M5 12l5 5 9-10',
    close: 'M6 6l12 12M18 6L6 18',
    chevron: 'M9 6l6 6-6 6',
    'chevron-down': 'M6 9l6 6 6-6',
    up: 'M12 19V5M5 12l7-7 7 7',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
    tag: 'M3 12V4h8l9 9-8 8zM7.5 7.5h.01',
    lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
    unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
    sync: 'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
    warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
    offline: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.1-1.6M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 10.7 5M12 20h.01',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
    upload: 'M12 20V8M7 13l5-5 5 5M4 4h16',
    star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    menu: 'M4 6h16M4 12h16M4 18h16',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    key: 'M15 7a3 3 0 1 1-3 3M14.5 9.5L4 20M7 17l2 2M9 15l2 2',
    devices: 'M3 5h14v10H3zM1 19h18M19 9h4v10h-4z',
    library: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-1 3 15.5L19 20z',
    puzzle: 'M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    bookmark: 'M6 3h12v18l-6-4.5L6 21z',
    'bookmark-plus': 'M6 3h12v18l-6-4.5L6 21zM12 7v6M9 10h6',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
    broken: 'M9 15l6-6M10 6l1-1a4 4 0 0 1 5.7 5.7l-1 1M14 18l-1 1a4 4 0 0 1-5.7-5.7l1-1M4 4l2 2M18 18l2 2',
    duplicate: 'M8 8h12v12H8zM4 16V4h12',
    arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  }
  export const ICON_NAMES = Object.keys(P)
</script>

<script lang="ts">
  let { name, size = 18, title }: { name: string; size?: number; title?: string } = $props()
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={title ? undefined : 'true'}
  role={title ? 'img' : undefined}
>
  {#if title}<title>{title}</title>{/if}
  <path d={P[name] ?? P.link} />
</svg>

<style>
  .icon {
    flex: none;
    display: inline-block;
    vertical-align: middle;
  }
</style>
