// 假后端本身的业务规则（拦截、修订、恢复），保证开发和 e2e 用到的场景可信
import { describe, expect, it } from 'vitest'
import { unwrap } from '../../src/api/client'
import { setup } from './helpers'

const slug = { params: { path: { slug: 'bookmarks' } } }

describe('假后端', () => {
  it('没有登录步骤：请求直接以默认用户身份处理', async () => {
    const t = setup()
    const me = await unwrap(t.client.GET('/api/v1/auth/me'))
    expect(me.user.username).toBe('alice')
    expect(me.authMethod).toBe('lan')
  })

  it('大批量删除的上传被拦截（412），确认后应用并生成 webdav 修订', async () => {
    const t = setup()
    await t.login()
    const before = await unwrap(t.client.GET('/api/v1/libraries/{slug}', slug))
    const res = await t.control('dav-upload', { library: 'bookmarks', keep: 0.2 })
    expect(res!.status).toBe(412)
    const pending = await unwrap(t.client.GET('/api/v1/pending'))
    expect(pending).toHaveLength(1)
    const detail = await unwrap(t.client.GET('/api/v1/libraries/{slug}/pending/{pendingId}', { params: { path: { slug: 'bookmarks', pendingId: pending[0].id } } }))
    expect(detail.diff.removed.length).toBeGreaterThan(0)
    const w = await unwrap(t.client.POST('/api/v1/libraries/{slug}/pending/{pendingId}/approve', { params: { path: { slug: 'bookmarks', pendingId: pending[0].id } } }))
    expect(w.revision).toBe(before.revision + 1)
    const revs = await unwrap(t.client.GET('/api/v1/libraries/{slug}/revisions', slug))
    expect(revs.items[0]).toMatchObject({ source: 'webdav', actor: 'Floccus · 笔记本（已确认）' })
    expect(await unwrap(t.client.GET('/api/v1/pending'))).toHaveLength(0)
  })

  it('小改动的上传直接应用', async () => {
    const t = setup()
    await t.login()
    const res = await t.control('dav-upload', { library: 'bookmarks', keep: 0.9 })
    expect(res!.status).toBe(204)
  })

  it('修订差异、回滚、最近删除恢复', async () => {
    const t = setup()
    await t.login()
    const revs = await unwrap(t.client.GET('/api/v1/libraries/{slug}/revisions', slug))
    const webRev = revs.items.find((r) => r.source === 'web')!
    const d = await unwrap(t.client.GET('/api/v1/libraries/{slug}/revisions/{rev}', { params: { path: { slug: 'bookmarks', rev: webRev.rev } } }))
    expect(d.diff.removed.map((i) => i.title)).toEqual(['旧的收藏'])
    expect(d.diff.moved.map((i) => i.title)).toEqual(['Excalidraw'])

    const deleted = await unwrap(t.client.GET('/api/v1/libraries/{slug}/deleted', slug))
    const e = deleted.find((x) => x.item.title === '旧的收藏')!
    const r = await unwrap(t.client.POST('/api/v1/libraries/{slug}/deleted/restore', { ...slug, body: { entries: [{ revision: e.revision, itemId: e.item.id }] } }))
    expect(r.restored).toBe(1)
    const look = await unwrap(t.client.GET('/api/v1/lookup', { params: { query: { url: 'https://old-bookmark.example.com/' } } }))
    expect(look.matches).toHaveLength(1)

    const first = revs.items[revs.items.length - 1]
    const rr = await unwrap(t.client.POST('/api/v1/libraries/{slug}/revisions/{rev}/restore', { params: { path: { slug: 'bookmarks', rev: first.rev } } }))
    const latest = await unwrap(t.client.GET('/api/v1/libraries/{slug}/revisions', slug))
    expect(latest.items[0]).toMatchObject({ rev: rr.revision, source: 'restore' })
  })

  it('批量操作原子：一个失败全部回滚', async () => {
    const t = setup()
    await t.login()
    const tree1 = await unwrap(t.client.GET('/api/v1/libraries/{slug}/tree', slug))
    const r = await t.client.POST('/api/v1/libraries/{slug}/items/batch', {
      ...slug,
      body: { ops: [{ op: 'create', type: 'folder', title: 'X', ref: 'x' }, { op: 'delete', id: 99999 }] },
    })
    expect(r.response.status).toBe(404)
    const tree2 = await unwrap(t.client.GET('/api/v1/libraries/{slug}/tree', slug))
    expect(tree2.children.length).toBe(tree1.children.length)
  })

  it('同一来源 120 秒内的连续编辑合并为一个修订', async () => {
    const t = setup()
    await t.login()
    const a = await unwrap(t.client.POST('/api/v1/libraries/{slug}/items', { ...slug, body: { type: 'folder', title: 'A' } }))
    const b = await unwrap(t.client.POST('/api/v1/libraries/{slug}/items', { ...slug, body: { type: 'folder', title: 'B' } }))
    expect(b.revision).toBe(a.revision)
    const d = await unwrap(t.client.GET('/api/v1/libraries/{slug}/revisions/{rev}', { params: { path: { slug: 'bookmarks', rev: b.revision } } }))
    expect(d.diff.added.map((i) => i.title).sort()).toEqual(['A', 'B'])
  })

  it('搜索语法与高亮', async () => {
    const t = setup()
    await t.login()
    const r = await unwrap(t.client.GET('/api/v1/search', { params: { query: { q: 'go #docs' } } }))
    expect(r.results.map((h) => h.item.title)).toContain('Go')
    expect(r.results[0].highlights?.title).toContain('<mark>')
    const broken = await unwrap(t.client.GET('/api/v1/search', { params: { query: { q: 'is:broken' } } }))
    expect(broken.results.map((h) => h.item.title).sort()).toEqual(['内网测试站', '已失效的文章'])
    const dup = await unwrap(t.client.GET('/api/v1/search', { params: { query: { q: 'is:duplicate lib:bookmarks' } } }))
    expect(dup.results.length).toBeGreaterThanOrEqual(2)
  })

  it('导入 HTML（文件夹模式）', async () => {
    const t = setup()
    await t.login()
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><H3>Dev</H3>\n<DL><p>\n<DT><A HREF="https://example.com/a" TAGS="x,y">A</A>\n</DL><p>\n<DT><A HREF="https://example.com/b">B</A>\n</DL><p>'
    const fd = new FormData()
    fd.append('file', new Blob([html], { type: 'text/html' }), 'b.html')
    fd.append('mode', 'folder')
    fd.append('folderName', '导入测试')
    const res = await t.api.fetch('/api/v1/libraries/bookmarks/import', { method: 'POST', body: fd })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ format: 'html', addedBookmarks: 2, addedFolders: 2 })
  })
})
