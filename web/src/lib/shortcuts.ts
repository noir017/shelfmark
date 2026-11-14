// 键盘快捷键：全局 / 聚焦搜索；页面通过 useShortcuts 注册自己的按键（在 $effect 里调用，返回清理函数）
type Handler = (e: KeyboardEvent) => void
const stack: Array<Record<string, Handler>> = []

function typing(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null
  if (!e) return false
  return e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)
}

function keyName(e: KeyboardEvent): string {
  const mods = (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Meta+' : '') + (e.altKey ? 'Alt+' : '')
  return mods + e.key
}

export function installShortcuts(globals: Record<string, Handler>) {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return
    const k = keyName(e)
    if (typing(e.target) && e.key !== 'Escape') return
    if (document.querySelector('[role="dialog"]') && e.key !== 'Escape') return
    for (let i = stack.length - 1; i >= 0; i--) {
      const h = stack[i][k]
      if (h) {
        h(e)
        return
      }
    }
    globals[k]?.(e)
  })
}

export function useShortcuts(map: Record<string, Handler>): () => void {
  stack.push(map)
  return () => {
    const i = stack.lastIndexOf(map)
    if (i !== -1) stack.splice(i, 1)
  }
}

export function focusSearch() {
  const el = document.querySelector<HTMLInputElement>('[data-search-input]')
  if (el) {
    el.focus()
    el.select()
    return true
  }
  return false
}
