// 触屏长按：按住不动约 450ms 触发；触发后吞掉随后的点击和系统长按菜单。鼠标不处理。
export function longpress(node: HTMLElement, cb: () => void) {
  let handler = cb
  let timer: ReturnType<typeof setTimeout> | undefined
  let start: { x: number; y: number } | null = null
  let fired = false

  const cancel = () => {
    clearTimeout(timer)
    start = null
  }
  const onDown = (e: PointerEvent) => {
    fired = false
    if (e.pointerType === 'mouse' || e.button !== 0) return
    start = { x: e.clientX, y: e.clientY }
    timer = setTimeout(() => {
      fired = true
      start = null
      navigator.vibrate?.(10)
      handler()
    }, 450)
  }
  const onMove = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel()
  }
  const swallow = (e: Event) => {
    if (!fired) return
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'click') fired = false
  }

  node.addEventListener('pointerdown', onDown)
  node.addEventListener('pointermove', onMove)
  node.addEventListener('pointerup', cancel)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('click', swallow, true)
  node.addEventListener('contextmenu', swallow, true)
  return {
    update(next: () => void) {
      handler = next
    },
    destroy() {
      cancel()
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerup', cancel)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('click', swallow, true)
      node.removeEventListener('contextmenu', swallow, true)
    },
  }
}
