// 树工具：索引、文件夹列表、祖先判断。只依赖数据，不依赖界面。
import type { Item } from '../api/types'

export interface Node {
  item: Item
  parentId: number
  /** 从根到父文件夹的标题 */
  path: string[]
  pathIds: number[]
  depth: number
}

export interface TreeIndex {
  byId: Map<number, Node>
  /** 父 ID → 子条目（按 position） */
  children: Map<number, Item[]>
}

export function indexTree(roots: Item[]): TreeIndex {
  const byId = new Map<number, Node>()
  const children = new Map<number, Item[]>()
  const walk = (items: Item[], parentId: number, path: string[], pathIds: number[]) => {
    const sorted = [...items].sort((a, b) => a.position - b.position)
    children.set(parentId, sorted)
    for (const it of sorted) {
      byId.set(it.id, { item: it, parentId, path, pathIds, depth: path.length })
      if (it.type === 'folder') walk(it.children ?? [], it.id, [...path, it.title], [...pathIds, it.id])
    }
  }
  walk(roots, 0, [], [])
  return { byId, children }
}

export function childrenOf(idx: TreeIndex, folderId: number): Item[] {
  return idx.children.get(folderId) ?? []
}

/** a 是否为 b 的祖先（或相同） */
export function isAncestorOrSelf(idx: TreeIndex, a: number, b: number): boolean {
  if (a === b) return true
  const n = idx.byId.get(b)
  return !!n && n.pathIds.includes(a)
}

export interface Row {
  item: Item
  depth: number
}

/** 大纲视图：文件夹的子项，展开的子文件夹就地展开 */
export function outlineRows(idx: TreeIndex, folderId: number, expanded: { has(id: number): boolean }): Row[] {
  const out: Row[] = []
  const walk = (parent: number, depth: number) => {
    for (const it of childrenOf(idx, parent)) {
      out.push({ item: it, depth })
      if (it.type === 'folder' && expanded.has(it.id)) walk(it.id, depth + 1)
    }
  }
  walk(folderId, 0)
  return out
}

export interface FolderEntry {
  id: number
  title: string
  path: string[]
  depth: number
}

/** 深度优先的文件夹列表（含根 id=0），给文件夹选择器用 */
export function folderList(idx: TreeIndex, rootLabel: string): FolderEntry[] {
  const out: FolderEntry[] = [{ id: 0, title: rootLabel, path: [], depth: 0 }]
  const walk = (parent: number) => {
    for (const it of childrenOf(idx, parent)) {
      if (it.type !== 'folder') continue
      const n = idx.byId.get(it.id)!
      out.push({ id: it.id, title: it.title, path: [...n.path, it.title], depth: n.depth + 1 })
      walk(it.id)
    }
  }
  walk(0)
  return out
}

/** 折叠视图下可见的文件夹：根的直接子文件夹总是可见，其余要祖先都展开 */
export function visibleFolders(idx: TreeIndex, list: FolderEntry[], open: { has(id: number): boolean }): FolderEntry[] {
  return list.filter((f) => f.id === 0 || (idx.byId.get(f.id)?.pathIds ?? []).every((p) => open.has(p)))
}

export function hasSubfolders(idx: TreeIndex, id: number): boolean {
  return childrenOf(idx, id).some((c) => c.type === 'folder')
}

export function countBookmarks(items: Item[] | undefined): number {
  let n = 0
  for (const it of items ?? []) n += it.type === 'bookmark' ? 1 : countBookmarks(it.children)
  return n
}

/** 去掉祖先也在集合里的条目（移动/删除文件夹时子孙随之而动） */
export function topLevelOnly(idx: TreeIndex, ids: number[]): number[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    const n = idx.byId.get(id)
    return n && !n.pathIds.some((p) => set.has(p))
  })
}

/** 按树中的显示顺序（深度优先）排序 */
export function inTreeOrder(idx: TreeIndex, ids: number[]): number[] {
  const order = new Map<number, number>()
  let i = 0
  const walk = (parent: number) => {
    for (const it of childrenOf(idx, parent)) {
      order.set(it.id, i++)
      if (it.type === 'folder') walk(it.id)
    }
  }
  walk(0)
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

export function allBookmarks(idx: TreeIndex): Node[] {
  return [...idx.byId.values()].filter((n) => n.item.type === 'bookmark')
}
