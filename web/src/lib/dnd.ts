// 拖放与移动的纯逻辑：判断落点区域、生成批量移动操作、生成删除的反向操作（撤销用）。
//
// position 语义（与假后端一致，见汇报的契约问题）：移动时先从原位置取出，再插入到目标父文件夹
// 子列表的第 position 位（即移动后的最终下标）。
import type { BatchCreate, BatchMove, Item } from '../api/types'
import { childrenOf, inTreeOrder, isAncestorOrSelf, topLevelOnly, type TreeIndex } from './tree'

export type Zone = 'before' | 'inside' | 'after'

export interface DropTarget {
  /** 目标条目 ID；0 表示根（只能 inside） */
  id: number
  zone: Zone
}

/** 按指针在目标行内的纵向位置决定区域：文件夹上中下三段，书签上下两段 */
export function dropZone(top: number, height: number, y: number, isFolder: boolean): Zone {
  const r = height > 0 ? (y - top) / height : 0.5
  if (isFolder) {
    if (r < 0.25) return 'before'
    if (r > 0.75) return 'after'
    return 'inside'
  }
  return r < 0.5 ? 'before' : 'after'
}

/** 把拖动的条目放到目标处，返回按序执行的移动操作；非法（放进自己或子孙里）返回 null，无变化返回 [] */
export function planMove(idx: TreeIndex, dragIds: number[], target: DropTarget): BatchMove[] | null {
  const ids = inTreeOrder(idx, topLevelOnly(idx, dragIds.filter((id) => idx.byId.has(id))))
  if (!ids.length) return null

  let parent: number
  let anchor: number | null // 插到哪个兄弟前面；null = 末尾
  if (target.id === 0 || target.zone === 'inside') {
    parent = target.id
    if (parent !== 0) {
      const n = idx.byId.get(parent)
      if (!n || n.item.type !== 'folder') return null
    }
    anchor = null
  } else {
    const t = idx.byId.get(target.id)
    if (!t) return null
    parent = t.parentId
    const sibs = childrenOf(idx, parent)
    const i = sibs.findIndex((s) => s.id === target.id)
    anchor = target.zone === 'before' ? target.id : (sibs[i + 1]?.id ?? null)
    // 锚点本身在拖动集合里时，顺延到下一个不被拖动的兄弟
    const dragged = new Set(ids)
    let j = sibs.findIndex((s) => s.id === anchor)
    while (anchor !== null && dragged.has(anchor)) {
      j++
      anchor = sibs[j]?.id ?? null
    }
  }

  for (const id of ids) {
    if (parent !== 0 && isAncestorOrSelf(idx, id, parent)) return null
  }

  const sim = childrenOf(idx, parent).map((s) => s.id)
  const before = sim.join(',')
  const ops: BatchMove[] = []
  let prev: number | null = null
  for (const id of ids) {
    const at = sim.indexOf(id)
    if (at !== -1) sim.splice(at, 1)
    let pos: number
    if (prev === null) pos = anchor === null ? sim.length : sim.indexOf(anchor)
    else pos = sim.indexOf(prev) + 1
    sim.splice(pos, 0, id)
    ops.push({ op: 'move', id, parentId: parent, position: pos })
    prev = id
  }
  const unchanged = sim.join(',') === before && ids.every((id) => idx.byId.get(id)!.parentId === parent)
  return unchanged ? [] : ops
}

/** 同一文件夹内上移/下移一格（键盘和窄屏用） */
export function planNudge(idx: TreeIndex, id: number, delta: -1 | 1): BatchMove[] {
  const n = idx.byId.get(id)
  if (!n) return []
  const sibs = childrenOf(idx, n.parentId)
  const i = sibs.findIndex((s) => s.id === id)
  const j = i + delta
  if (j < 0 || j >= sibs.length) return []
  return [{ op: 'move', id, parentId: n.parentId, position: j }]
}

/**
 * 删除的反向操作：按原父文件夹和原位置重建（含子孙、备注、标签）。
 * 父文件夹也被删时，它会先被重建，子条目用 parentRef 挂上去。
 */
export function planRecreate(idx: TreeIndex, deletedIds: number[]): BatchCreate[] {
  const tops = topLevelOnly(idx, deletedIds)
    .map((id) => idx.byId.get(id)!)
    .sort((a, b) => a.parentId - b.parentId || a.item.position - b.item.position)
  const ops: BatchCreate[] = []
  let n = 0
  const emit = (it: Item, parent: { parentId?: number; parentRef?: string }, position?: number) => {
    const ref = `r${n++}`
    const op: BatchCreate = { op: 'create', ref, type: it.type, title: it.title, ...parent }
    if (position !== undefined) op.position = position
    if (it.url) op.url = it.url
    if (it.notes) op.notes = it.notes
    if (it.tags.length) op.tags = [...it.tags]
    ops.push(op)
    if (it.type === 'folder') for (const c of it.children ?? []) emit(c, { parentRef: ref })
  }
  // 同一父文件夹内按原位置从小到大插入，下标即最终位置
  for (const node of tops) emit(node.item, { parentId: node.parentId }, node.item.position)
  return ops
}
