// 假后端的种子数据。账号密码仅用于内存假后端演示和测试，不对应任何真实服务。
import { MockDB, healthOf, type MLib, type MUser } from './db.ts'

export const DEMO_USER = 'alice'
export const DEMO_PASSWORD = process.env.SHELFMARK_MOCK_PASSWORD || 'demo-password'

export type Scenario = 'seeded' | 'empty'

const DAY = 86_400_000
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000).toISOString()

type B = { t: string; u: string; tags?: string[]; notes?: string; visits?: number; health?: ReturnType<typeof healthOf> }
type F = { folder: string; items: Array<B | F> }

function add(db: MockDB, lib: MLib, parentId: number, nodes: Array<B | F>, at: string): Record<string, number> {
  const ids: Record<string, number> = {}
  for (const n of nodes) {
    if ('folder' in n) {
      const f = db.insert(lib, { type: 'folder', parentId, title: n.folder }, at)
      ids[n.folder] = f.id
      Object.assign(ids, add(db, lib, f.id, n.items, at))
    } else {
      const b = db.insert(lib, { type: 'bookmark', parentId, title: n.t, url: n.u, tags: n.tags, notes: n.notes }, at)
      b.visitCount = n.visits ?? 0
      if (b.visitCount) b.lastVisitedAt = ago(0, b.visitCount % 20)
      b.health = n.health ?? healthOf('ok', { httpStatus: 200 })
      ids[n.t] = b.id
    }
  }
  return ids
}

function seedAlice(db: MockDB): MUser {
  const alice = db.addUser(DEMO_USER, DEMO_PASSWORD, true, ago(30))
  const lib = db.lib(alice.id, 'bookmarks')
  lib.name = '书签'

  const ids = add(db, lib, 0, [
    { folder: '常用', items: [
      { t: 'GitHub', u: 'https://github.com/', tags: ['dev'], visits: 42 },
      { t: 'MDN Web Docs', u: 'https://developer.mozilla.org/', tags: ['dev', 'docs'], visits: 31 },
      { t: 'Svelte', u: 'https://svelte.dev/', tags: ['dev'], visits: 12 },
      { t: 'Go', u: 'https://go.dev/', tags: ['dev', 'docs'], visits: 9 },
      { t: 'Hacker News', u: 'https://news.ycombinator.com/', tags: ['reading'], visits: 27 },
      { t: '维基百科', u: 'https://zh.wikipedia.org/', tags: ['中文'], visits: 5 },
    ] },
    { folder: '工具', items: [
      { folder: '在线工具', items: [
        { t: 'Regex101', u: 'https://regex101.com/', tags: ['tool'], visits: 8 },
        { t: 'JSON 格式化', u: 'https://jsonformatter.org/', tags: ['tool'] },
        { t: 'Can I use', u: 'https://caniuse.com/', tags: ['tool', 'dev'], visits: 3 },
      ] },
      { t: 'Excalidraw', u: 'https://excalidraw.com/', tags: ['tool'], visits: 4 },
      { t: 'Squoosh', u: 'https://squoosh.app/', tags: ['tool'] },
      { t: 'DeepL 翻译', u: 'https://www.deepl.com/translator', tags: ['tool'], notes: '翻译长文用' },
    ] },
    { folder: '阅读', items: [
      { t: '阮一峰的网络日志', u: 'https://www.ruanyifeng.com/blog/', tags: ['reading', '中文'], visits: 6 },
      { t: 'Lobsters', u: 'https://lobste.rs/', tags: ['reading'] },
      { t: 'The Go Blog', u: 'https://go.dev/blog/', tags: ['reading', 'dev'] },
      { t: 'Svelte Blog', u: 'https://svelte.dev/blog', tags: ['reading'] },
      { t: '已失效的文章', u: 'https://old.example.com/gone', health: healthOf('broken', { httpStatus: 404, error: 'Not Found' }) },
      { t: '搬家的文档', u: 'http://example.org/docs', health: healthOf('redirect', { httpStatus: 301, finalUrl: 'https://example.org/docs/' }) },
    ] },
    { folder: '购物', items: [
      { t: '示例商城', u: 'https://shop.example.com/?utm_source=bookmark' },
      { t: '二手市场', u: 'https://used.example.net/' },
    ] },
    { t: 'Example Domain', u: 'https://example.com/', notes: '示例站点', visits: 2 },
    { t: 'Example（newsletter 链接）', u: 'https://example.com/?utm_source=newsletter' },
    { t: '内网测试站', u: 'https://unreachable.example.invalid/', health: healthOf('unreachable', { error: 'dial tcp: no such host' }) },
    { t: '旧的收藏', u: 'https://old-bookmark.example.com/' },
  ], ago(10))
  db.commit(lib, 'import', DEMO_USER, { at: ago(10), noMerge: true })

  // 一次 Floccus 同步：新增两个书签、改一个标题
  add(db, lib, ids['阅读'], [
    { t: 'Rust Blog', u: 'https://blog.rust-lang.org/', tags: ['reading'] },
    { t: 'V8 博客', u: 'https://v8.dev/blog', tags: ['reading', 'dev'] },
  ], ago(5))
  db.update(lib, ids['Squoosh'], { title: 'Squoosh 图片压缩' })
  db.commit(lib, 'webdav', 'Floccus · 笔记本', { at: ago(5), noMerge: true })
  lib.lastSyncAt = ago(5)
  lib.lastSyncActor = 'Floccus · 笔记本'

  // 网页上删除一个、移动一个
  db.remove(lib, ids['旧的收藏'])
  db.move(lib, ids['Excalidraw'], ids['在线工具'])
  db.commit(lib, 'web', DEMO_USER, { at: ago(2), noMerge: true })

  // 插件收藏一个
  add(db, lib, ids['阅读'], [{ t: 'web.dev', u: 'https://web.dev/', tags: ['dev'] }], ago(1))
  db.commit(lib, 'extension', '插件 · Chrome · Linux', { at: ago(1), noMerge: true })
  for (const it of lib.items.values()) it.updatedAt = it.createdAt

  const work = db.createLibrary(alice.id, 'work', '工作', ago(20))
  add(db, work, 0, [
    { folder: '项目', items: [
      { t: '问题跟踪', u: 'https://issues.example.com/', tags: ['work'], visits: 14 },
      { t: '持续集成', u: 'https://ci.example.com/', tags: ['work'] },
    ] },
    { folder: '文档', items: [
      { t: '团队 Wiki', u: 'https://wiki.example.com/', tags: ['work', 'docs'], visits: 7 },
      { t: 'API 文档', u: 'https://api.example.com/docs', tags: ['docs'] },
    ] },
    { t: 'GitHub', u: 'https://github.com/', tags: ['dev'] },
  ], ago(20))
  db.commit(work, 'import', DEMO_USER, { at: ago(20), noMerge: true })

  db.createToken(alice.id, 'Floccus · 笔记本', ['dav']).lastUsedAt = ago(5)
  db.createToken(alice.id, '插件 · Chrome · Linux', ['api']).lastUsedAt = ago(1)

  alice.settings.startPage = {
    showSearch: true, showRecent: true, recentCount: 6, showFrequent: true, frequentCount: 6,
    sections: [
      { id: 's-common', library: 'bookmarks', folderId: ids['常用'], title: null, layout: 'grid', collapsed: false },
      { id: 's-tools', library: 'bookmarks', folderId: ids['工具'], title: null, layout: 'list', collapsed: false },
    ],
  }
  return alice
}

export function seed(scenario: Scenario = 'seeded'): MockDB {
  const db = new MockDB()
  if (scenario === 'seeded') seedAlice(db)
  return db
}
