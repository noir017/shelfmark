// 工作区偏好：上次所在文件夹。URL 是库/文件夹的真源，这里只做本地记忆。
import { app, defaultLibrary } from './app.svelte'

export interface FolderRef {
  library: string
  folderId: number
}

function readLast(): FolderRef | null {
  try {
    const v = JSON.parse(localStorage.getItem('shelfmark.lastFolder') ?? 'null')
    return v && typeof v.library === 'string' && typeof v.folderId === 'number' ? v : null
  } catch {
    return null
  }
}

export const workspace = $state<{ last: FolderRef | null }>({ last: readLast() })

export function rememberFolder(library: string, folderId: number) {
  workspace.last = { library, folderId }
  try {
    localStorage.setItem('shelfmark.lastFolder', JSON.stringify(workspace.last))
  } catch {
    /* 隐私模式忽略 */
  }
}

/** `/` 打开的位置：固定文件夹 > 库根 > 上次位置 > 默认库根。 */
export function startFolder(): FolderRef | null {
  const sl = app.settings?.startLocation
  const lib = defaultLibrary()
  if (sl?.kind === 'folder' && sl.library && app.libraries.some((l) => l.slug === sl.library)) {
    return { library: sl.library, folderId: sl.folderId ?? 0 }
  }
  if (sl?.kind === 'root' && lib) return { library: lib, folderId: 0 }
  const last = workspace.last
  if (last && app.libraries.some((l) => l.slug === last.library)) return last
  return lib ? { library: lib, folderId: 0 } : null
}
