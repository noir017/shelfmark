import { describe, expect, it } from 'vitest'
import type { Item } from '../../src/api/types'
import { dropZone, planMove, planNudge, planRecreate } from '../../src/lib/dnd'
import { childrenOf, indexTree, outlineRows } from '../../src/lib/tree'
import { MockDB } from '../../mock/db'

let nextId = 1
const bm = (title: string, extra: Partial<Item> = {}): Item => ({
  id: nextId++, type: 'bookmark', parentId: 0, position: 0, title, url: `https://example.com/${title}`,
  createdAt: '', updatedAt: '', tags: [], visitCount: 0, ...extra,
})
const folder = (title: string, children: Item[]): Item => ({ ...bm(title), type: 'folder', url: null, children })

function fixRefs(items: Item[], parentId = 0) {
  items.forEach((it, i) => {
    it.parentId = parentId
    it.position = i
    if (it.children) fixRefs(it.children, it.id)
  })
  return items
}

/** 根: A B F1[x y F2[z]] C */
function sample() {
  nextId = 1
  const A = bm('A'), B = bm('B'), x = bm('x'), y = bm('y'), z = bm('z'), C = bm('C')
  const F2 = folder('F2', [z])
  const F1 = folder('F1', [x, y, F2])
  const roots = fixRefs([A, B, F1, C])
  return { roots, idx: indexTree(roots), A, B, C, F1, F2, x, y, z }
}

/** 用假后端的 move 语义执行操作，返回各父文件夹下的标题顺序 */
function apply(roots: Item[], ops: Array<{ id: number; parentId?: number; position?: number }>) {
  const db = new MockDB()
  const lib = db.createLibrary(1, 't', 't')
  const walk = (items: Item[]) => {
    for (const it of items) {
      lib.items.set(it.id, { id: it.id, type: it.type, parentId: it.parentId, position: it.position, title: it.title, url: it.url ?? null, createdAt: '', updatedAt: '', notes: null, tags: [], faviconId: null, health: null, visitCount: 0, lastVisitedAt: null })
      walk(it.children ?? [])
    }
  }
  walk(roots)
  for (const op of ops) db.move(lib, op.id, op.parentId!, op.position)
  const titles = (pid: number) => db.children(lib, pid).map((i) => i.title).join(' ')
  return { titles, db, lib }
}

describe('落点区域', () => {
  it('书签分上下两半，文件夹分三段', () => {
    expect(dropZone(100, 40, 105, false)).toBe('before')
    expect(dropZone(100, 40, 130, false)).toBe('after')
    expect(dropZone(100, 40, 105, true)).toBe('before')
    expect(dropZone(100, 40, 120, true)).toBe('inside')
    expect(dropZone(100, 40, 139, true)).toBe('after')
  })
})

describe('planMove', () => {
  it('同级向后移动：A 放到 C 之后', () => {
    const s = sample()
    const ops = planMove(s.idx, [s.A.id], { id: s.C.id, zone: 'after' })!
    expect(apply(s.roots, ops).titles(0)).toBe('B F1 C A')
  })

  it('同级向前移动：C 放到 A 之前', () => {
    const s = sample()
    const ops = planMove(s.idx, [s.C.id], { id: s.A.id, zone: 'before' })!
    expect(apply(s.roots, ops).titles(0)).toBe('C A B F1')
  })

  it('移入文件夹（追加到末尾）', () => {
    const s = sample()
    const ops = planMove(s.idx, [s.A.id], { id: s.F2.id, zone: 'inside' })!
    const r = apply(s.roots, ops)
    expect(r.titles(s.F2.id)).toBe('z A')
    expect(r.titles(0)).toBe('B F1 C')
  })

  it('跨文件夹放到某条目之前', () => {
    const s = sample()
    const ops = planMove(s.idx, [s.z.id], { id: s.x.id, zone: 'before' })!
    const r = apply(s.roots, ops)
    expect(r.titles(s.F1.id)).toBe('z x y F2')
    expect(r.titles(s.F2.id)).toBe('')
  })

  it('多选保持原有顺序，且跳过拖动集合里的锚点', () => {
    const s = sample()
    // 选中 C 和 A（乱序传入），放到 B 之后 → 锚点 F1
    const ops = planMove(s.idx, [s.C.id, s.A.id], { id: s.B.id, zone: 'after' })!
    expect(apply(s.roots, ops).titles(0)).toBe('B A C F1')
    // 放到 A 之后：锚点 A 的下一个是 B
    const s2 = sample()
    const ops2 = planMove(s2.idx, [s2.A.id, s2.C.id], { id: s2.A.id, zone: 'after' })!
    expect(apply(s2.roots, ops2).titles(0)).toBe('A C B F1')
  })

  it('多选跨层：父文件夹和子条目同时选中时只移动父文件夹', () => {
    const s = sample()
    const ops = planMove(s.idx, [s.F2.id, s.z.id, s.A.id], { id: s.C.id, zone: 'after' })!
    expect(ops.map((o) => o.id)).toEqual([s.A.id, s.F2.id])
    const r = apply(s.roots, ops)
    expect(r.titles(0)).toBe('B F1 C A F2')
    expect(r.titles(s.F2.id)).toBe('z')
  })

  it('不能放进自己或子孙', () => {
    const s = sample()
    expect(planMove(s.idx, [s.F1.id], { id: s.F2.id, zone: 'inside' })).toBeNull()
    expect(planMove(s.idx, [s.F1.id], { id: s.F1.id, zone: 'inside' })).toBeNull()
    expect(planMove(s.idx, [s.F1.id], { id: s.z.id, zone: 'before' })).toBeNull()
  })

  it('放到原位返回空操作', () => {
    const s = sample()
    expect(planMove(s.idx, [s.A.id], { id: s.B.id, zone: 'before' })).toEqual([])
    expect(planMove(s.idx, [s.A.id], { id: s.A.id, zone: 'after' })).toEqual([])
  })

  it('放到根（id=0）', () => {
    const s = sample()
    const ops = planMove(s.idx, [s.x.id], { id: 0, zone: 'inside' })!
    expect(apply(s.roots, ops).titles(0)).toBe('A B F1 C x')
  })

  it('上下微调', () => {
    const s = sample()
    expect(apply(s.roots, planNudge(s.idx, s.B.id, -1)).titles(0)).toBe('B A F1 C')
    expect(planNudge(s.idx, s.A.id, -1)).toEqual([])
  })
})

describe('删除的反向操作', () => {
  it('按原父文件夹和原位置重建，子孙用 parentRef', () => {
    const s = sample()
    s.F1.children![2].children![0].tags = ['t']
    const ops = planRecreate(s.idx, [s.F2.id, s.z.id, s.A.id])
    expect(ops.map((o) => o.title)).toEqual(['A', 'F2', 'z'])
    expect(ops[0]).toMatchObject({ parentId: 0, position: 0 })
    expect(ops[1]).toMatchObject({ parentId: s.F1.id, position: 2, type: 'folder' })
    expect(ops[2]).toMatchObject({ parentRef: ops[1].ref, tags: ['t'] })
    expect(childrenOf(s.idx, 0)).toHaveLength(4)
  })
})

describe('outlineRows', () => {
  const view = (rows: { item: Item; depth: number }[]) => rows.map((r) => '  '.repeat(r.depth) + r.item.title)

  it('不展开时只有直接子项', () => {
    const { idx } = sample()
    expect(view(outlineRows(idx, 0, new Set()))).toEqual(['A', 'B', 'F1', 'C'])
  })

  it('展开的文件夹就地展开，逐级缩进；没展开的父级挡住子级', () => {
    const { idx, F1, F2 } = sample()
    expect(view(outlineRows(idx, 0, new Set([F1.id, F2.id])))).toEqual(['A', 'B', 'F1', '  x', '  y', '  F2', '    z', 'C'])
    expect(view(outlineRows(idx, 0, new Set([F2.id])))).toEqual(['A', 'B', 'F1', 'C'])
    expect(view(outlineRows(idx, F1.id, new Set([F2.id])))).toEqual(['x', 'y', 'F2', '  z'])
  })
})
