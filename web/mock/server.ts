// 假后端入口：把 Fetch Request 交给 MSW 处理器，另加测试控制接口 /__mock/*
//   POST /__mock/reset        {scenario?: 'seeded'|'empty', config?}  重置数据
//   POST /__mock/config       Partial<MockConfig>                    改开关（AI、Access、断网、重试间隔……）
//   POST /__mock/lock         {library, actor?, durationMs?, user?}  模拟 Floccus 持锁同步（期间 API 写入 423）
//   POST /__mock/dav-upload   {library, keep?, actor?, user?}        模拟 Floccus 上传只保留 keep 比例的书签（触发 412 拦截）
//   GET  /__mock/state                                               调试用摘要
import { getResponse } from 'msw'
import { defaultConfig, type MockConfig, type MockDB } from './db.ts'
import { createHandlers } from './handlers.ts'
import { DEMO_USER, seed, type Scenario } from './seed.ts'

export type MockResult = { kind: 'response'; response: Response } | { kind: 'pass' } | { kind: 'drop' }

const BACKEND = ['/api/', '/healthz', '/downloads/']
/** Cloudflare Access 放行的路径（设计 7.1） */
const ACCESS_BYPASS = ['/dav/', '/manifest.webmanifest', '/icons/', '/__mock/']
export const ACCESS_LOGIN = 'https://example.cloudflareaccess.com/cdn-cgi/access/login/'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

export function createMockServer(initial: Scenario = 'seeded') {
  const state = { db: seed(initial) as MockDB }
  const handlers = createHandlers(() => state.db)

  function userFor(name?: string) {
    const u = state.db.users.find((x) => x.username === (name ?? DEMO_USER))
    if (!u) throw new Error(`no user ${name}`)
    return u
  }

  async function control(request: Request, path: string): Promise<Response> {
    const b = request.method === 'POST' ? await request.json().catch(() => ({})) : {}
    const db = state.db
    switch (path) {
      case '/__mock/reset': {
        const cfg = db.config
        state.db = seed((b.scenario as Scenario) ?? 'seeded')
        state.db.config = { ...defaultConfig(), ...(b.keepConfig ? cfg : {}), ...(b.config ?? {}) }
        return json({ ok: true })
      }
      case '/__mock/config':
        Object.assign(db.config, b as Partial<MockConfig>)
        return json(db.config)
      case '/__mock/lock': {
        const lib = db.lib(userFor(b.user).id, b.library ?? 'bookmarks')
        const now = new Date().toISOString()
        if (b.release) lib.lock = null
        else lib.lock = { actor: b.actor ?? 'Floccus · 笔记本', since: now, modifiedAt: now, releaseAt: Date.now() + (b.durationMs ?? 60_000) }
        return json({ ok: true })
      }
      case '/__mock/dav-upload': {
        const lib = db.lib(userFor(b.user).id, b.library ?? 'bookmarks')
        const snap = db.snapshot(lib)
        const keep = typeof b.keep === 'number' ? b.keep : 0.3
        const bookmarks = snap.filter((s) => s.type === 'bookmark')
        const drop = new Set(bookmarks.slice(Math.ceil(bookmarks.length * keep)).map((s) => s.id))
        const kept = snap.filter((s) => !drop.has(s.id))
        // 重排位置，保证兄弟间连续
        const byParent = new Map<number, typeof kept>()
        for (const s of kept) byParent.set(s.parentId, [...(byParent.get(s.parentId) ?? []), s])
        for (const sibs of byParent.values()) sibs.sort((a, c) => a.position - c.position).forEach((s, i) => (s.position = i))
        const pending = db.davUpload(lib, kept, b.actor ?? 'Floccus · 笔记本')
        if (pending) {
          return new Response(`这次上传会删除 ${pending.removed} 个条目，已拦截，请到网页确认`, { status: 412, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        }
        return new Response(null, { status: 204 })
      }
      case '/__mock/state':
        return json({
          users: db.users.map((u) => u.username),
          config: db.config,
          libraries: db.libs.map((l) => ({ slug: l.slug, revision: l.revision, bookmarks: db.bookmarkCount(l), lock: l.lock })),
          pending: db.pending.length,
        })
    }
    return json({ error: 'unknown control' }, 404)
  }

  async function handle(request: Request): Promise<MockResult> {
    const url = new URL(request.url)
    const path = url.pathname
    if (path.startsWith('/__mock/')) return { kind: 'response', response: await control(request, path) }
    const cfg = state.db.config
    if (cfg.accessExpired && !ACCESS_BYPASS.some((p) => path.startsWith(p))) {
      const location = `${ACCESS_LOGIN}${url.host}?redirect_url=${encodeURIComponent(path + url.search)}`
      return { kind: 'response', response: new Response(null, { status: 302, headers: { Location: location } }) }
    }
    if (!BACKEND.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return { kind: 'pass' }
    if (cfg.offline) return { kind: 'drop' }
    const res = await getResponse(handlers, request)
    if (res) return { kind: 'response', response: res }
    return { kind: 'response', response: json({ error: { code: 'not_found', message: `假后端没有实现 ${request.method} ${path}` } }, 404) }
  }

  return { handle, state }
}
