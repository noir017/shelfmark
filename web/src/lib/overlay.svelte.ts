// 全局对话框与右键菜单服务：页面里 await confirmDialog(...) 即可，不用各自管理弹窗状态
export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  danger?: boolean
  /** 需要输入指定文字才能确认（如删除库要输入 slug） */
  requireText?: string
  /** 普通输入框（如新建文件夹名） */
  input?: { label: string; value?: string; placeholder?: string }
}

interface Pending extends ConfirmOptions {
  resolve: (v: string | boolean | null) => void
}

export const dialogs = $state<{ current: Pending | null }>({ current: null })

export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialogs.current = { ...o, resolve: (v) => resolve(v !== null && v !== false) }
  })
}

export function promptDialog(o: ConfirmOptions & { input: NonNullable<ConfirmOptions['input']> }): Promise<string | null> {
  return new Promise((resolve) => {
    dialogs.current = { ...o, resolve: (v) => resolve(typeof v === 'string' ? v : null) }
  })
}

export function closeDialog(v: string | boolean | null) {
  const c = dialogs.current
  dialogs.current = null
  c?.resolve(v)
}

export interface MenuItem {
  label: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  run: () => void
}

export const menu = $state<{ open: boolean; x: number; y: number; items: MenuItem[] }>({ open: false, x: 0, y: 0, items: [] })

export function openMenu(x: number, y: number, items: MenuItem[]) {
  menu.x = x
  menu.y = y
  menu.items = items
  menu.open = true
}

export function closeMenu() {
  menu.open = false
}
