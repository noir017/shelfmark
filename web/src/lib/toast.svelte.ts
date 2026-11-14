// 全局提示：普通提示、错误、可撤销操作（默认 8 秒）
export interface ToastAction {
  label: string
  run: () => void | Promise<void>
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error' | 'warn'
  action?: ToastAction
  /** 同 key 的提示会被替换（如 423 重试进度） */
  key?: string
}

export const toasts = $state<Toast[]>([])
let seq = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function dismiss(id: number) {
  const i = toasts.findIndex((t) => t.id === id)
  if (i !== -1) toasts.splice(i, 1)
  clearTimeout(timers.get(id))
  timers.delete(id)
}

export function toast(message: string, opts: { kind?: Toast['kind']; action?: ToastAction; timeout?: number; key?: string } = {}): number {
  if (opts.key) for (const t of toasts.filter((x) => x.key === opts.key)) dismiss(t.id)
  const id = seq++
  toasts.push({ id, message, kind: opts.kind ?? 'info', action: opts.action, key: opts.key })
  const timeout = opts.timeout ?? (opts.action ? 8000 : opts.kind === 'error' ? 6000 : 3500)
  if (timeout > 0) timers.set(id, setTimeout(() => dismiss(id), timeout))
  while (toasts.length > 5) dismiss(toasts[0].id)
  return id
}

export function dismissKey(key: string) {
  for (const t of toasts.filter((x) => x.key === key)) dismiss(t.id)
}
