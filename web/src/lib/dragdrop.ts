// 指针拖放（鼠标、触屏、触控笔统一用 Pointer Events）
// - 鼠标：在行内按下并移动超过 5px 开始拖动
// - 触屏/笔：只从拖动手柄 [data-drag-handle] 开始（手柄 touch-action:none，不和页面滚动冲突）
// - 落点：指针下最近的 [data-drop-id]，按纵向位置算 before/inside/after；[data-drop-inside] 只接受放入
import { dropZone, type DropTarget, type Zone } from './dnd'

export interface DragSourceOptions {
  /** 开始拖动时要移动的条目（多选时是整个选区） */
  ids: () => number[]
  label: () => string
  onDrop: (target: DropTarget, ids: number[]) => void
  /** 判断落点是否允许（如不能放进自己里） */
  accept?: (target: DropTarget, ids: number[]) => boolean
  disabled?: () => boolean
}

interface Active {
  ids: number[]
  opts: DragSourceOptions
  ghost: HTMLElement
  target: { el: HTMLElement; t: DropTarget } | null
  scrollTimer: ReturnType<typeof setInterval> | null
  lastX: number
  lastY: number
}

let active: Active | null = null

export function isDragging() {
  return !!active
}

function clearIndicator() {
  if (active?.target) active.target.el.removeAttribute('data-drop-zone')
}

function hitTest(x: number, y: number): { el: HTMLElement; t: DropTarget } | null {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop-id]')
  if (!el) return null
  const id = Number(el.dataset.dropId)
  let zone: Zone
  if (el.dataset.dropInside !== undefined || id === 0) zone = 'inside'
  else {
    const r = el.getBoundingClientRect()
    zone = dropZone(r.top, r.height, y, el.dataset.dropFolder === '1')
  }
  return { el, t: { id, zone } }
}

function update(x: number, y: number) {
  if (!active) return
  active.lastX = x
  active.lastY = y
  active.ghost.style.transform = `translate(${x + 12}px, ${y + 8}px)`
  const hit = hitTest(x, y)
  clearIndicator()
  if (hit && (active.opts.accept?.(hit.t, active.ids) ?? true)) {
    hit.el.setAttribute('data-drop-zone', hit.t.zone)
    active.target = hit
  } else {
    active.target = null
  }
}

function autoScroll() {
  if (!active) return
  const { lastX: x, lastY: y } = active
  const under = document.elementFromPoint(x, y) as HTMLElement | null
  const box = under?.closest<HTMLElement>('[data-scroll-container]')
  const edge = 48
  const step = (d: number) => Math.ceil((edge - d) / 4)
  if (box && box.scrollHeight > box.clientHeight) {
    const r = box.getBoundingClientRect()
    if (y - r.top < edge) box.scrollTop -= step(y - r.top)
    else if (r.bottom - y < edge) box.scrollTop += step(r.bottom - y)
  }
  if (y < edge) window.scrollBy(0, -step(y))
  else if (window.innerHeight - y < edge) window.scrollBy(0, step(window.innerHeight - y))
}

function start(ids: number[], opts: DragSourceOptions, x: number, y: number) {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.textContent = opts.label()
  document.body.appendChild(ghost)
  document.body.classList.add('dragging')
  active = { ids, opts, ghost, target: null, scrollTimer: setInterval(autoScroll, 30), lastX: x, lastY: y }
  update(x, y)
}

function finish(drop: boolean) {
  if (!active) return
  const a = active
  clearIndicator()
  a.ghost.remove()
  if (a.scrollTimer) clearInterval(a.scrollTimer)
  document.body.classList.remove('dragging')
  active = null
  if (drop && a.target) a.opts.onDrop(a.target.t, a.ids)
}

/** Svelte action：把元素变成拖动源 */
export function dragSource(node: HTMLElement, initial: DragSourceOptions) {
  let opts = initial
  let pending: { id: number; x: number; y: number; touch: boolean } | null = null
  let suppressClick = false

  const onMove = (e: PointerEvent) => {
    if (active) {
      e.preventDefault()
      update(e.clientX, e.clientY)
      return
    }
    if (!pending || e.pointerId !== pending.id) return
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > (pending.touch ? 3 : 5)) {
      const ids = opts.ids()
      if (!ids.length) return cleanup()
      start(ids, opts, e.clientX, e.clientY)
    }
  }
  const onUp = (e: PointerEvent) => {
    if (pending && e.pointerId !== pending.id) return
    if (active) {
      suppressClick = true
      setTimeout(() => (suppressClick = false), 0)
      finish(e.type === 'pointerup')
    }
    cleanup()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && active) {
      e.preventDefault()
      finish(false)
      cleanup()
    }
  }
  function cleanup() {
    pending = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey, true)
  }
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || opts.disabled?.()) return
    const target = e.target as HTMLElement
    const handle = target.closest('[data-drag-handle]')
    const touch = e.pointerType !== 'mouse'
    if (touch && !handle) return
    if (!handle && target.closest('input, textarea, select, button, [contenteditable="true"]')) return
    if (handle) e.preventDefault()
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY, touch }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey, true)
  }
  const onClick = (e: MouseEvent) => {
    if (suppressClick) {
      e.preventDefault()
      e.stopPropagation()
      suppressClick = false
    }
  }
  // 阻止链接和图片的原生拖动（否则会和指针拖动打架）
  const onDragStart = (e: DragEvent) => e.preventDefault()

  node.addEventListener('pointerdown', onDown)
  node.addEventListener('click', onClick, true)
  node.addEventListener('dragstart', onDragStart)
  return {
    update(o: DragSourceOptions) {
      opts = o
    },
    destroy() {
      cleanup()
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('click', onClick, true)
      node.removeEventListener('dragstart', onDragStart)
    },
  }
}
