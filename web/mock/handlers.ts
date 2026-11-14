// MSW 处理器：按 api/openapi.yaml 实现全部 /api/v1 接口
import { http, HttpResponse, type HttpHandler } from 'msw'
import type {
  AiOrganizeResult, AiSuggestion, DeletedEntry, DuplicateGroup, HealthStatus, ItemWithPath, JobName, Library, Me,
  PendingUpload, QuickSaveResult, SearchHit, Settings, StartPage, User,
} from '../src/api/types'
import { highlight, matches, parseQuery, score } from '../src/lib/search/query.ts'
import { normalizeUrl } from '../src/lib/url.ts'
import { cleanTags, diffSnaps, HttpError, nowIso, type MLib, type MockDB, type MUser, type MItem, type MPending, type Snap } from './db.ts'
import { detectFormat, parseHtml, parseJson, parseXbel, toHtml, toXbel, type FNode } from './formats.ts'

type AuthMethod = 'session' | 'access' | 'token'

interface Ctx {
  request: Request
  url: URL
  params: Record<string, string>
  user: MUser
  auth: AuthMethod
  sid: string | null
}

type Out = Response | object | null | undefined

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => HttpResponse.json(data as never, { status, headers })
const noContent = () => new HttpResponse(null, { status: 204 })
const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) => new HttpError(status, code, message, details)

function errorResponse(e: HttpError) {
  return json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, e.status, e.headers)
}

const COOKIE = 'shelfmark_session'
const sessionCookie = (sid: string) => `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`

async function body<T>(request: Request): Promise<T> {
  const text = await request.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw fail(422, 'validation', '请求体不是合法 JSON')
  }
}

const int = (s: string | null | undefined, name: string): number => {
  const n = Number(s)
  if (!Number.isInteger(n)) throw fail(422, 'validation', `${name} 不合法`, { [name]: 'integer' })
  return n
}

export function createHandlers(getDb: () => MockDB): HttpHandler[] {
  const db = () => getDb()

  function resolveAuth(request: Request): { user: MUser; auth: AuthMethod; sid: string | null } | null {
    const d = db()
    const authz = request.headers.get('authorization')
    if (authz?.startsWith('Bearer ')) {
      const t = d.tokens.find((x) => x.token === authz.slice(7) && !x.revoked && x.scopes.includes('api'))
      if (!t) return null
      t.lastUsedAt = nowIso()
      const user = d.users.find((u) => u.id === t.userId)
      return user ? { user, auth: 'token', sid: null } : null
    }
    const cookie = request.headers.get('cookie') ?? ''
    const sid = cookie.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1)
    if (!sid) return null
    const s = d.sessions.get(sid)
    const user = s && d.users.find((u) => u.id === s.userId)
    return user ? { user, auth: s!.method, sid } : null
  }

  type Fn = (c: Ctx) => Out | Promise<Out>
  type PubFn = (c: { request: Request; url: URL; params: Record<string, string> }) => Out | Promise<Out>

  function wrap(method: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string, fn: Fn, opts: { admin?: boolean; csrfExempt?: boolean } = {}): HttpHandler {
    return http[method]('*' + path, async ({ request, params }) => {
      const url = new URL(request.url)
      try {
        if (db().config.latencyMs) await new Promise((r) => setTimeout(r, db().config.latencyMs))
        const a = resolveAuth(request)
        if (!a) throw fail(401, 'unauthorized', '未登录')
        const write = method !== 'get'
        if (write && a.auth !== 'token' && !opts.csrfExempt && request.headers.get('x-requested-with') !== 'shelfmark') {
          throw fail(403, 'forbidden', '缺少 X-Requested-With 请求头')
        }
        if (opts.admin && !a.user.isAdmin) throw fail(403, 'forbidden', '仅管理员')
        const out = await fn({ request, url, params: params as Record<string, string>, ...a })
        if (out instanceof Response) return out
        if (out === null || out === undefined) return noContent()
        return json(out)
      } catch (e) {
        if (e instanceof HttpError) return errorResponse(e)
        console.error('[mock]', e)
        return errorResponse(fail(500, 'internal', String(e)))
      }
    })
  }

  function pub(method: 'get' | 'post', path: string, fn: PubFn): HttpHandler {
    return http[method]('*' + path, async ({ request, params }) => {
      try {
        if (db().config.latencyMs) await new Promise((r) => setTimeout(r, db().config.latencyMs))
        const out = await fn({ request, url: new URL(request.url), params: params as Record<string, string> })
        if (out instanceof Response) return out
        if (out === null || out === undefined) return noContent()
        return json(out)
      } catch (e) {
        if (e instanceof HttpError) return errorResponse(e)
        console.error('[mock]', e)
        return errorResponse(fail(500, 'internal', String(e)))
      }
    })
  }

  const userOut = (u: MUser): User => ({ id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt })
  const me = (u: MUser, m: AuthMethod): Me => ({ user: userOut(u), authMethod: m })

  function libOut(l: MLib): Library {
    const d = db()
    let folders = 0
    for (const i of l.items.values()) if (i.type === 'folder') folders++
    return {
      slug: l.slug, name: l.name, davFile: `${l.slug}.xbel`, revision: l.revision, highestId: l.highestId,
      bookmarkCount: d.bookmarkCount(l), folderCount: folders, createdAt: l.createdAt, updatedAt: l.updatedAt,
      lastSyncAt: l.lastSyncAt, lastSyncActor: l.lastSyncActor, lock: d.lockInfo(l),
      pendingCount: d.pending.filter((p) => p.userId === l.userId && p.library === l.slug).length,
    }
  }

  const lib = (c: Ctx) => db().lib(c.user.id, c.params.slug)
  const sourceOf = (c: Ctx): 'api' | 'web' => (c.auth === 'token' ? 'api' : 'web')
  const actorOf = (c: Ctx) => c.user.username

  function writeLib(c: Ctx): MLib {
    const l = lib(c)
    db().checkLock(l)
    return l
  }

  // ---------- 跨库辅助 ----------

  function allBookmarks(u: MUser): Array<{ lib: MLib; it: MItem }> {
    const out: Array<{ lib: MLib; it: MItem }> = []
    for (const l of db().userLibs(u.id)) for (const it of l.items.values()) out.push({ lib: l, it })
    return out
  }

  function dupSet(u: MUser): Set<string> {
    const count = new Map<string, number>()
    for (const { it } of allBookmarks(u)) if (it.url) count.set(normalizeUrl(it.url), (count.get(normalizeUrl(it.url)) ?? 0) + 1)
    return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k))
  }

  function snapNodes(snap: Snap[], parentId = 0): Array<FNode & { id: number }> {
    return snap
      .filter((s) => s.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, type: s.type, title: s.title, url: s.url, notes: s.notes, tags: s.tags, children: s.type === 'folder' ? snapNodes(snap, s.id) : undefined }))
  }

  function exportResponse(l: MLib, snap: Snap[], format: string, name: string, rev: number) {
    const nodes = snapNodes(snap)
    const visits = new Map([...l.items.values()].map((i) => [i.id, i.visitCount]))
    const headers = (ext: string, type: string) => ({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}.${ext}"` })
    if (format === 'xbel') return new HttpResponse(toXbel(nodes, l.highestId), { headers: headers('xbel', 'application/xml; charset=utf-8') })
    if (format === 'json') {
      const withVisits = (ns: Array<FNode & { id: number }>): unknown[] =>
        ns.map((n) => ({ ...n, visitCount: visits.get(n.id) ?? 0, children: n.children ? withVisits(n.children as Array<FNode & { id: number }>) : undefined }))
      const data = { format: 'shelfmark', version: 1, library: l.slug, revision: rev, exportedAt: nowIso(), highestId: l.highestId, children: withVisits(nodes) }
      return new HttpResponse(JSON.stringify(data, null, 2), { headers: headers('json', 'application/json') })
    }
    return new HttpResponse(toHtml(nodes, l.name), { headers: headers('html', 'text/html; charset=utf-8') })
  }

  function insertNodes(l: MLib, parentId: number, nodes: FNode[], mode: 'folder' | 'merge' | 'replace', stats: { b: number; f: number; skip: number }) {
    const d = db()
    for (const n of nodes) {
      if (n.type === 'folder') {
        let target = mode === 'merge' ? d.children(l, parentId).find((c) => c.type === 'folder' && c.title === n.title) : undefined
        if (!target) {
          target = d.insert(l, { type: 'folder', parentId, title: n.title })
          stats.f++
        }
        insertNodes(l, target.id, n.children ?? [], mode, stats)
      } else {
        if (!n.url) continue
        if (mode === 'merge') {
          const norm = normalizeUrl(n.url)
          if (d.children(l, parentId).some((c) => c.url && normalizeUrl(c.url) === norm)) {
            stats.skip++
            continue
          }
        }
        d.insert(l, { type: 'bookmark', parentId, title: n.title, url: n.url, notes: n.notes, tags: n.tags })
        stats.b++
      }
    }
  }

  function folderPaths(l: MLib): Array<{ id: number; path: string[] }> {
    const d = db()
    return [...l.items.values()].filter((i) => i.type === 'folder').map((f) => ({ id: f.id, path: [...d.path(l, f.id).path, f.title] }))
  }

  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)

  function suggestFolders(l: MLib, url: string, title: string) {
    const d = db()
    let host = ''
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* ignore */
    }
    const ws = new Set([...words(title), ...words(host)])
    const scored = folderPaths(l).map((f) => {
      let s = 0
      for (const w of words(f.path.join(' '))) if (ws.has(w)) s += 2
      for (const c of d.children(l, f.id)) {
        if (c.url && host && c.url.includes(host)) s += 3
        for (const w of words(c.title)) if (ws.has(w)) s += 0.5
      }
      return { ...f, s }
    })
    scored.sort((a, b) => b.s - a.s)
    const max = Math.max(1, scored[0]?.s ?? 1)
    return scored.slice(0, 3).map((f) => ({ folderId: f.id, path: f.path, score: Math.round((f.s / max) * 100) / 100 }))
  }

  return [
    // ---------- system / auth ----------
    pub('get', '/healthz', () => new HttpResponse('ok 0.0.0-mock', { headers: { 'Content-Type': 'text/plain' } })),
    pub('get', '/api/v1/system/info', () => ({
      version: '0.0.0-mock', commit: 'mock', needsSetup: db().users.length === 0, davPath: '/dav/', baseUrl: null,
      features: { ai: db().config.aiEnabled, metrics: false, linkcheck: true, metadata: true, autoCreateLibrary: true, cfAccessSso: db().config.cfAccessSso },
    })),
    pub('post', '/api/v1/setup', async ({ request }) => {
      const d = db()
      if (d.users.length) throw fail(409, 'conflict', '已经设置过管理员')
      const b = await body<{ username?: string; password?: string }>(request)
      if (!b.username || !/^[A-Za-z0-9._-]{1,64}$/.test(b.username)) throw fail(422, 'validation', '用户名不合法', { username: 'pattern' })
      if (!b.password || b.password.length < 8) throw fail(422, 'validation', '密码至少 8 位', { password: 'minLength' })
      const u = d.addUser(b.username, b.password, true)
      const sid = d.newSession(u.id)
      return json(me(u, 'session'), 201, { 'Set-Cookie': sessionCookie(sid) })
    }),
    pub('post', '/api/v1/auth/login', async ({ request }) => {
      const d = db()
      if (d.loginFailures >= 10) throw new HttpError(429, 'rate_limited', '失败次数过多，请 15 分钟后再试', undefined, { 'Retry-After': '900' })
      const b = await body<{ username?: string; password?: string }>(request)
      const u = d.users.find((x) => x.username === b.username && x.password === b.password)
      if (!u) {
        d.loginFailures++
        throw fail(401, 'unauthorized', '用户名或密码错误')
      }
      const sid = d.newSession(u.id)
      return json(me(u, 'session'), 200, { 'Set-Cookie': sessionCookie(sid) })
    }),
    pub('post', '/api/v1/auth/access', () => {
      const d = db()
      if (!d.config.cfAccessSso) throw fail(503, 'unavailable', '未启用 Access 单点登录')
      const u = d.users.find((x) => x.username === d.config.accessUser)
      if (!u) throw fail(401, 'unauthorized', 'Access 身份无效或没有映射')
      const sid = d.newSession(u.id, 'access')
      return json(me(u, 'access'), 200, { 'Set-Cookie': sessionCookie(sid) })
    }),
    pub('post', '/api/v1/auth/token', async ({ request }) => {
      const d = db()
      const b = await body<{ username?: string; password?: string; name?: string; scopes?: Array<'api' | 'dav'> }>(request)
      const u = d.users.find((x) => x.username === b.username && x.password === b.password)
      if (!u) throw fail(401, 'unauthorized', '用户名或密码错误')
      const t = d.createToken(u.id, b.name ?? 'token', b.scopes?.length ? b.scopes : ['api'])
      return json({ ...d.publicToken(t), token: t.token }, 201)
    }),
    wrap('post', '/api/v1/auth/logout', (c) => {
      if (c.sid) db().sessions.delete(c.sid)
      return new HttpResponse(null, { status: 204, headers: { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` } })
    }),
    wrap('get', '/api/v1/auth/me', (c) => me(c.user, c.auth)),
    wrap('post', '/api/v1/auth/password', async (c) => {
      const b = await body<{ currentPassword?: string; newPassword?: string }>(c.request)
      if (b.currentPassword !== c.user.password) throw fail(401, 'unauthorized', '当前密码不对')
      if (!b.newPassword || b.newPassword.length < 8) throw fail(422, 'validation', '新密码至少 8 位', { newPassword: 'minLength' })
      c.user.password = b.newPassword
      for (const [k, s] of db().sessions) if (s.userId === c.user.id && k !== c.sid) db().sessions.delete(k)
      return null
    }),

    // ---------- users ----------
    wrap('get', '/api/v1/users', () => db().users.map(userOut), { admin: true }),
    wrap('post', '/api/v1/users', async (c) => {
      const b = await body<{ username?: string; password?: string; isAdmin?: boolean }>(c.request)
      if (!b.username || !/^[A-Za-z0-9._-]{1,64}$/.test(b.username)) throw fail(422, 'validation', '用户名不合法', { username: 'pattern' })
      if (!b.password || b.password.length < 8) throw fail(422, 'validation', '密码至少 8 位', { password: 'minLength' })
      if (db().users.some((u) => u.username === b.username)) throw fail(409, 'conflict', '用户名已存在')
      return json(userOut(db().addUser(b.username, b.password, !!b.isAdmin)), 201)
    }, { admin: true }),
    wrap('patch', '/api/v1/users/:userId', async (c) => {
      const d = db()
      const u = d.users.find((x) => x.id === int(c.params.userId, 'userId'))
      if (!u) throw fail(404, 'not_found', '用户不存在')
      const b = await body<{ password?: string; isAdmin?: boolean }>(c.request)
      if (b.password !== undefined) {
        if (b.password.length < 8) throw fail(422, 'validation', '密码至少 8 位', { password: 'minLength' })
        u.password = b.password
      }
      if (b.isAdmin === false && u.isAdmin && d.users.filter((x) => x.isAdmin).length === 1) throw fail(409, 'conflict', '不能取消最后一个管理员')
      if (b.isAdmin !== undefined) u.isAdmin = b.isAdmin
      return userOut(u)
    }, { admin: true }),
    wrap('delete', '/api/v1/users/:userId', (c) => {
      const d = db()
      const u = d.users.find((x) => x.id === int(c.params.userId, 'userId'))
      if (!u) throw fail(404, 'not_found', '用户不存在')
      if (u.id === c.user.id) throw fail(409, 'conflict', '不能删除自己')
      if (u.isAdmin && d.users.filter((x) => x.isAdmin).length === 1) throw fail(409, 'conflict', '不能删除最后一个管理员')
      d.users = d.users.filter((x) => x !== u)
      d.libs = d.libs.filter((l) => l.userId !== u.id)
      d.tokens = d.tokens.filter((t) => t.userId !== u.id)
      return null
    }, { admin: true }),

    // ---------- tokens ----------
    wrap('get', '/api/v1/tokens', (c) => db().tokens.filter((t) => t.userId === c.user.id && !t.revoked).map((t) => db().publicToken(t))),
    wrap('post', '/api/v1/tokens', async (c) => {
      const b = await body<{ name?: string; scopes?: Array<'api' | 'dav'> }>(c.request)
      if (!b.name?.trim()) throw fail(422, 'validation', '名称必填', { name: 'required' })
      if (!b.scopes?.length) throw fail(422, 'validation', '至少选一个 scope', { scopes: 'minItems' })
      const t = db().createToken(c.user.id, b.name.trim(), b.scopes)
      return json({ ...db().publicToken(t), token: t.token }, 201)
    }),
    wrap('delete', '/api/v1/tokens/:tokenId', (c) => {
      const t = db().tokens.find((x) => x.id === int(c.params.tokenId, 'tokenId') && x.userId === c.user.id && !x.revoked)
      if (!t) throw fail(404, 'not_found', '令牌不存在')
      t.revoked = true
      return null
    }),
    wrap('post', '/api/v1/floccus/setup', async (c) => {
      const b = await body<{ library?: string; deviceName?: string }>(c.request)
      const l = db().lib(c.user.id, b.library ?? '')
      const name = (b.deviceName ?? '').trim() || 'Floccus'
      const t = db().createToken(c.user.id, name, ['dav'])
      const davUrl = `${c.url.origin}/dav/`
      return json({
        token: { ...db().publicToken(t), token: t.token }, library: l.slug, davUrl, username: c.user.username, bookmarkFile: `${l.slug}.xbel`,
        profile: { type: 'webdav', url: davUrl, username: c.user.username, password: t.token, bookmark_file: `${l.slug}.xbel`, bookmark_file_type: 'xbel', label: name },
        profileFileName: `floccus-${l.slug}.json`,
      }, 201)
    }),

    // ---------- libraries ----------
    wrap('get', '/api/v1/libraries', (c) => db().userLibs(c.user.id).map(libOut)),
    wrap('post', '/api/v1/libraries', async (c) => {
      const b = await body<{ slug?: string; name?: string }>(c.request)
      if (!b.name?.trim()) throw fail(422, 'validation', '名称必填', { name: 'required' })
      return json(libOut(db().createLibrary(c.user.id, b.slug ?? '', b.name.trim())), 201)
    }),
    wrap('get', '/api/v1/libraries/:slug', (c) => libOut(lib(c))),
    wrap('patch', '/api/v1/libraries/:slug', async (c) => {
      const l = lib(c)
      const b = await body<{ name?: string; slug?: string }>(c.request)
      if (b.slug !== undefined && b.slug !== l.slug) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(b.slug)) throw fail(422, 'validation', 'slug 不合法', { slug: 'pattern' })
        if (db().userLibs(c.user.id).some((x) => x.slug === b.slug)) throw fail(409, 'conflict', 'slug 已被占用')
        for (const p of db().pending) if (p.userId === c.user.id && p.library === l.slug) p.library = b.slug
        l.slug = b.slug
      }
      if (b.name !== undefined) {
        if (!b.name.trim()) throw fail(422, 'validation', '名称必填', { name: 'required' })
        l.name = b.name.trim()
      }
      l.updatedAt = nowIso()
      return libOut(l)
    }),
    wrap('delete', '/api/v1/libraries/:slug', (c) => {
      const l = lib(c)
      if (c.url.searchParams.get('confirm') !== l.slug) throw fail(422, 'validation', 'confirm 必须等于 slug', { confirm: 'mismatch' })
      const d = db()
      d.libs = d.libs.filter((x) => x !== l)
      d.pending = d.pending.filter((p) => !(p.userId === c.user.id && p.library === l.slug))
      return null
    }),
    wrap('post', '/api/v1/libraries/:slug/lock/release', (c) => {
      lib(c).lock = null
      return null
    }),

    // ---------- tree / items ----------
    wrap('get', '/api/v1/libraries/:slug/tree', (c) => {
      const l = lib(c)
      const etag = `"r${l.revision}-${l.changeSeq}"`
      if (c.request.headers.get('if-none-match') === etag) return new HttpResponse(null, { status: 304, headers: { ETag: etag } })
      const d = db()
      return json({ library: l.slug, revision: l.revision, highestId: l.highestId, children: d.children(l, 0).map((i) => d.apiItem(l, i, true)) }, 200, { ETag: etag })
    }),
    wrap('post', '/api/v1/libraries/:slug/items/batch', async (c) => {
      const l = writeLib(c)
      const d = db()
      const b = await body<{ ops?: Array<Record<string, unknown>> }>(c.request)
      if (!Array.isArray(b.ops) || !b.ops.length) throw fail(422, 'validation', 'ops 不能为空', { ops: 'minItems' })
      if (b.ops.length > 1000) throw fail(422, 'validation', 'ops 太多', { ops: 'maxItems' })
      const backup = structuredClone(l.items)
      const highest = l.highestId
      const created: Record<string, number> = {}
      const parentOf = (op: Record<string, unknown>) => {
        if (typeof op.parentRef === 'string') {
          const id = created[op.parentRef]
          if (id === undefined) throw fail(422, 'validation', `未知 parentRef ${op.parentRef}`, { parentRef: 'unknown' })
          return id
        }
        return op.parentId === undefined ? undefined : Number(op.parentId)
      }
      try {
        b.ops.forEach((op, i) => {
          switch (op.op) {
            case 'create': {
              const it = d.insert(l, {
                type: op.type as 'folder' | 'bookmark', parentId: parentOf(op) ?? 0, position: op.position as number | undefined,
                title: String(op.title ?? ''), url: op.url as string | undefined, notes: op.notes as string | undefined, tags: op.tags as string[] | undefined,
              })
              if (typeof op.ref === 'string') created[op.ref] = it.id
              break
            }
            case 'update':
              d.update(l, Number(op.id), op as never)
              break
            case 'move': {
              const it = d.item(l, Number(op.id))
              d.move(l, it.id, parentOf(op) ?? it.parentId, op.position as number | undefined)
              break
            }
            case 'delete':
              d.remove(l, Number(op.id))
              break
            case 'tag': {
              const it = d.item(l, Number(op.id))
              const rm = new Set(((op.remove as string[]) ?? []).map((t) => t.toLowerCase()))
              it.tags = cleanTags([...it.tags.filter((t) => !rm.has(t.toLowerCase())), ...((op.add as string[]) ?? [])])
              it.updatedAt = nowIso()
              break
            }
            default:
              throw fail(422, 'validation', `第 ${i + 1} 个操作不认识`, { index: i })
          }
        })
      } catch (e) {
        l.items = backup
        l.highestId = highest
        if (e instanceof HttpError) e.details = { ...(e.details ?? {}), failedOp: e.details?.index ?? null }
        throw e
      }
      return { revision: d.commit(l, sourceOf(c), actorOf(c)), created }
    }),
    wrap('post', '/api/v1/libraries/:slug/items', async (c) => {
      const l = writeLib(c)
      const d = db()
      const b = await body<{ type?: 'folder' | 'bookmark'; parentId?: number; position?: number; title?: string; url?: string; notes?: string; tags?: string[] }>(c.request)
      if (b.type !== 'folder' && b.type !== 'bookmark') throw fail(422, 'validation', 'type 不合法', { type: 'enum' })
      if (typeof b.title !== 'string') throw fail(422, 'validation', 'title 必填', { title: 'required' })
      const it = d.insert(l, { type: b.type, parentId: b.parentId ?? 0, position: b.position, title: b.title, url: b.url, notes: b.notes, tags: b.tags })
      const revision = d.commit(l, sourceOf(c), actorOf(c))
      return json({ revision, item: d.apiItem(l, it, false) }, 201)
    }),
    wrap('get', '/api/v1/libraries/:slug/items/:itemId', (c) => {
      const l = lib(c)
      return db().withPath(l, db().item(l, int(c.params.itemId, 'itemId')))
    }),
    wrap('patch', '/api/v1/libraries/:slug/items/:itemId', async (c) => {
      const l = writeLib(c)
      const d = db()
      const id = int(c.params.itemId, 'itemId')
      const it = d.item(l, id)
      const b = await body<{ title?: string; url?: string; notes?: string | null; tags?: string[]; parentId?: number; position?: number }>(c.request)
      d.update(l, id, b)
      if (b.parentId !== undefined || b.position !== undefined) d.move(l, id, b.parentId ?? it.parentId, b.position)
      return { revision: d.commit(l, sourceOf(c), actorOf(c)), item: d.apiItem(l, it, false) }
    }),
    wrap('delete', '/api/v1/libraries/:slug/items/:itemId', (c) => {
      const l = writeLib(c)
      db().remove(l, int(c.params.itemId, 'itemId'))
      return { revision: db().commit(l, sourceOf(c), actorOf(c)) }
    }),
    wrap('get', '/api/v1/libraries/:slug/recent', (c) => {
      const l = lib(c)
      const limit = Math.min(100, Number(c.url.searchParams.get('limit') ?? 20) || 20)
      return [...l.items.values()]
        .filter((i) => i.type === 'bookmark')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .slice(0, limit)
        .map((i) => db().withPath(l, i))
    }),
    wrap('get', '/api/v1/libraries/:slug/frequent', (c) => {
      const l = lib(c)
      const limit = Math.min(100, Number(c.url.searchParams.get('limit') ?? 20) || 20)
      return [...l.items.values()]
        .filter((i) => i.type === 'bookmark' && i.visitCount > 0)
        .sort((a, b) => b.visitCount - a.visitCount)
        .slice(0, limit)
        .map((i) => db().withPath(l, i))
    }),

    // ---------- quick save / lookup / search ----------
    wrap('post', '/api/v1/quick-save', async (c) => {
      const d = db()
      const b = await body<{ url?: string; title?: string; library?: string; parentId?: number; notes?: string; tags?: string[]; allowDuplicate?: boolean }>(c.request)
      if (!b.url?.trim()) throw fail(422, 'validation', 'url 必填', { url: 'required' })
      const def = c.user.settings.defaultSave
      const slug = b.library ?? def?.library ?? 'bookmarks'
      const l = d.lib(c.user.id, slug)
      d.checkLock(l)
      let parentId = b.parentId ?? (b.library === undefined || b.library === def?.library ? def?.folderId : undefined)
      if (parentId === undefined) {
        let inbox = d.children(l, 0).find((x) => x.type === 'folder' && x.title === '收件箱')
        if (!inbox) inbox = d.insert(l, { type: 'folder', parentId: 0, title: '收件箱' })
        parentId = inbox.id
      }
      if (!b.allowDuplicate) {
        const norm = normalizeUrl(b.url)
        const ex = [...l.items.values()].find((i) => i.url && normalizeUrl(i.url) === norm)
        if (ex) {
          const r: QuickSaveResult = { existed: true, library: l.slug, item: d.apiItem(l, ex, false), path: d.path(l, ex.id).path, revision: l.revision }
          return r
        }
      }
      const title = b.title?.trim() || fakeTitle(b.url)
      const it = d.insert(l, { type: 'bookmark', parentId, title, url: b.url.trim(), notes: b.notes, tags: b.tags })
      const revision = d.commit(l, c.auth === 'token' ? 'extension' : 'web', actorOf(c))
      const target = { library: l.slug, folderId: parentId }
      c.user.settings.recentSaveTargets = [target, ...c.user.settings.recentSaveTargets.filter((t) => !(t.library === target.library && t.folderId === target.folderId))].slice(0, 10)
      const r: QuickSaveResult = { existed: false, library: l.slug, item: d.apiItem(l, it, false), path: d.path(l, it.id).path, revision }
      return json(r, 201)
    }),
    wrap('get', '/api/v1/lookup', (c) => {
      const url = c.url.searchParams.get('url') ?? ''
      const norm = normalizeUrl(url)
      const matchesOut: ItemWithPath[] = allBookmarks(c.user)
        .filter(({ it }) => it.url && normalizeUrl(it.url) === norm)
        .map(({ lib: l, it }) => db().withPath(l, it))
      return { url, normalizedUrl: norm, matches: matchesOut }
    }),
    wrap('get', '/api/v1/search', (c) => {
      const q = c.url.searchParams.get('q') ?? ''
      const only = c.url.searchParams.get('library')
      const limit = Math.min(200, Number(c.url.searchParams.get('limit') ?? 50) || 50)
      const offset = Number(c.url.searchParams.get('offset') ?? 0) || 0
      const p = parseQuery(q)
      const dups = dupSet(c.user)
      const d = db()
      const hits: Array<{ s: number; hit: SearchHit }> = []
      for (const { lib: l, it } of allBookmarks(c.user)) {
        if (only && l.slug !== only) continue
        const { path, pathIds } = d.path(l, it.id)
        const sv = {
          library: l.slug, title: it.title, url: it.url, notes: it.notes, tags: it.tags, path,
          broken: !!it.health && ['broken', 'unreachable'].includes(it.health.status),
          duplicate: !!it.url && dups.has(normalizeUrl(it.url)),
        }
        if (!matches(p, sv)) continue
        if (!p.terms.length && !p.tags.length && !p.sites.length && !p.folders.length && !p.is.length && !p.libs.length) continue
        hits.push({
          s: score(p, sv, it.visitCount) + (it.type === 'bookmark' ? 1 : 0),
          hit: {
            library: l.slug, item: d.apiItem(l, it, false), path, pathIds,
            highlights: { title: highlight(it.title, p.terms), url: highlight(it.url ?? '', p.terms), notes: highlight(it.notes ?? '', p.terms) },
          },
        })
      }
      hits.sort((a, b) => b.s - a.s)
      return { query: q, total: hits.length, results: hits.slice(offset, offset + limit).map((h) => h.hit) }
    }),

    // ---------- tags / visits / favicons / meta ----------
    wrap('get', '/api/v1/tags', (c) => {
      const m = new Map<string, { name: string; count: number }>()
      for (const { it } of allBookmarks(c.user))
        for (const t of it.tags) {
          const k = t.toLowerCase()
          const e = m.get(k) ?? { name: t, count: 0 }
          e.count++
          m.set(k, e)
        }
      return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    }),
    wrap('patch', '/api/v1/tags/:name', async (c) => {
      const from = decodeURIComponent(c.params.name).toLowerCase()
      const b = await body<{ name?: string }>(c.request)
      const to = cleanTags([b.name ?? ''])[0]
      if (!to) throw fail(422, 'validation', '标签名不合法', { name: 'invalid' })
      let found = false
      for (const l of db().userLibs(c.user.id)) {
        let changed = false
        for (const it of l.items.values()) {
          if (!it.tags.some((t) => t.toLowerCase() === from)) continue
          it.tags = cleanTags(it.tags.map((t) => (t.toLowerCase() === from ? to : t)))
          changed = found = true
        }
        if (changed) db().commit(l, sourceOf(c), actorOf(c))
      }
      if (!found) throw fail(404, 'not_found', '标签不存在')
      return null
    }),
    wrap('delete', '/api/v1/tags/:name', (c) => {
      const name = decodeURIComponent(c.params.name).toLowerCase()
      let found = false
      for (const l of db().userLibs(c.user.id)) {
        let changed = false
        for (const it of l.items.values()) {
          if (!it.tags.some((t) => t.toLowerCase() === name)) continue
          it.tags = it.tags.filter((t) => t.toLowerCase() !== name)
          changed = found = true
        }
        if (changed) db().commit(l, sourceOf(c), actorOf(c))
      }
      if (!found) throw fail(404, 'not_found', '标签不存在')
      return null
    }),
    // sendBeacon 带不了自定义请求头，所以 visits 不做 X-Requested-With 校验（见汇报）
    wrap('post', '/api/v1/visits', async (c) => {
      const b = await body<{ library?: string; itemId?: number }>(c.request)
      const l = db().userLibs(c.user.id).find((x) => x.slug === b.library)
      const it = l?.items.get(Number(b.itemId))
      if (it) {
        it.visitCount++
        it.lastVisitedAt = nowIso()
      }
      return null
    }, { csrfExempt: true }),
    pub('get', '/api/v1/favicons/:faviconId', ({ params }) => {
      const f = db().favicons.get(params.faviconId)
      if (!f) throw fail(404, 'not_found', '图标不存在')
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${f.color}"/><text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${f.letter.replace(/[<&]/g, '')}</text></svg>`
      return new HttpResponse(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=31536000, immutable' } })
    }),
    wrap('post', '/api/v1/meta/fetch', async (c) => {
      const b = await body<{ url?: string }>(c.request)
      if (!b.url) throw fail(422, 'validation', 'url 必填', { url: 'required' })
      try {
        new URL(b.url)
      } catch {
        throw fail(422, 'validation', 'url 不合法', { url: 'invalid' })
      }
      return { url: b.url, finalUrl: b.url, title: fakeTitle(b.url), description: `关于 ${new URL(b.url).hostname} 的描述`, faviconId: db().faviconFor(b.url, '') }
    }),

    // ---------- history ----------
    wrap('get', '/api/v1/libraries/:slug/revisions', (c) => {
      const l = lib(c)
      const before = c.url.searchParams.get('before')
      const limit = Math.min(200, Number(c.url.searchParams.get('limit') ?? 50) || 50)
      const list = [...l.revisions].reverse().filter((r) => !before || r.rev < Number(before))
      const page = list.slice(0, limit)
      return {
        items: page.map(({ snapshot: _s, hash: _h, ...r }) => r),
        nextBefore: list.length > limit ? page[page.length - 1].rev : null,
      }
    }),
    wrap('get', '/api/v1/libraries/:slug/revisions/:rev', (c) => {
      const { rev, diff } = db().revisionDiff(lib(c), int(c.params.rev, 'rev'))
      const { snapshot: _s, hash: _h, ...r } = rev
      return { revision: r, diff }
    }),
    wrap('get', '/api/v1/libraries/:slug/revisions/:rev/export', (c) => {
      const l = lib(c)
      const { rev } = db().revisionDiff(l, int(c.params.rev, 'rev'))
      return exportResponse(l, rev.snapshot, c.url.searchParams.get('format') ?? 'html', `${l.slug}-r${rev.rev}`, rev.rev)
    }),
    wrap('post', '/api/v1/libraries/:slug/revisions/:rev/restore', (c) => {
      const l = writeLib(c)
      const { rev } = db().revisionDiff(l, int(c.params.rev, 'rev'))
      db().replaceWithSnapshot(l, rev.snapshot)
      return { revision: db().commit(l, 'restore', actorOf(c), { noMerge: true }) }
    }),
    wrap('get', '/api/v1/libraries/:slug/deleted', (c) => {
      const l = lib(c)
      const days = Math.min(365, Number(c.url.searchParams.get('days') ?? 30) || 30)
      const since = Date.now() - days * 86_400_000
      const out: DeletedEntry[] = []
      for (const r of [...l.revisions].reverse()) {
        if (Date.parse(r.createdAt) < since) break
        const { diff } = db().revisionDiff(l, r.rev)
        for (const it of diff.removed) {
          if (l.restored.has(`${r.rev}:${it.id}`)) continue
          out.push({ revision: r.rev, deletedAt: r.createdAt, source: r.source, actor: r.actor, item: it })
        }
      }
      return out
    }),
    wrap('post', '/api/v1/libraries/:slug/deleted/restore', async (c) => {
      const l = writeLib(c)
      const d = db()
      const b = await body<{ entries?: Array<{ revision: number; itemId: number }> }>(c.request)
      if (!b.entries?.length) throw fail(422, 'validation', 'entries 不能为空', { entries: 'minItems' })
      let restored = 0
      for (const e of b.entries) {
        const { prev } = d.revisionDiff(l, e.revision)
        const src = prev.find((s) => s.id === e.itemId)
        if (!src) throw fail(404, 'not_found', `修订 ${e.revision} 里没有删除条目 ${e.itemId}`)
        let parentId = src.parentId
        if (parentId !== 0 && !l.items.has(parentId)) {
          let box = d.children(l, 0).find((x) => x.type === 'folder' && x.title === '已恢复')
          if (!box) box = d.insert(l, { type: 'folder', parentId: 0, title: '已恢复' })
          parentId = box.id
        }
        const rebuild = (s: Snap, pid: number, pos?: number) => {
          const it = d.insert(l, { type: s.type, parentId: pid, position: pos, title: s.title, url: s.url, notes: s.notes, tags: s.tags })
          restored++
          for (const ch of prev.filter((x) => x.parentId === s.id).sort((a, b) => a.position - b.position)) rebuild(ch, it.id)
        }
        rebuild(src, parentId, parentId === src.parentId ? src.position : undefined)
        l.restored.add(`${e.revision}:${e.itemId}`)
      }
      return { revision: d.commit(l, sourceOf(c), actorOf(c)), restored }
    }),

    // ---------- pending ----------
    wrap('get', '/api/v1/pending', (c) => db().pending.filter((p) => p.userId === c.user.id).map(pendingOut)),
    wrap('get', '/api/v1/libraries/:slug/pending/:pendingId', (c) => {
      const l = lib(c)
      const p = findPending(c, l)
      return { pending: pendingOut(p), diff: diffSnaps(db().snapshot(l), p.items).diff }
    }),
    wrap('post', '/api/v1/libraries/:slug/pending/:pendingId/approve', (c) => {
      const l = writeLib(c)
      const p = findPending(c, l)
      const d = db()
      d.replaceWithSnapshot(l, p.items)
      l.highestId = Math.max(l.highestId, p.highestId)
      const revision = d.commit(l, 'webdav', `${p.actor}（已确认）`, { noMerge: true })
      l.lastSyncAt = nowIso()
      l.lastSyncActor = p.actor
      d.pending = d.pending.filter((x) => x !== p)
      return { revision }
    }),
    wrap('post', '/api/v1/libraries/:slug/pending/:pendingId/discard', (c) => {
      const l = lib(c)
      const p = findPending(c, l)
      db().pending = db().pending.filter((x) => x !== p)
      return null
    }),

    // ---------- reports / jobs ----------
    wrap('get', '/api/v1/reports/broken', (c) => {
      const only = c.url.searchParams.get('library')
      const st = c.url.searchParams.get('status')
      const want = new Set<HealthStatus>(st ? (st.split(',') as HealthStatus[]) : ['redirect', 'broken', 'unreachable'])
      return allBookmarks(c.user)
        .filter(({ lib: l, it }) => (!only || l.slug === only) && it.health && want.has(it.health.status))
        .map(({ lib: l, it }) => db().withPath(l, it))
    }),
    wrap('post', '/api/v1/reports/broken/recheck', async (c) => {
      const b = await body<{ library?: string; itemIds?: number[] }>(c.request)
      const l = db().lib(c.user.id, b.library ?? '')
      for (const id of b.itemIds ?? []) {
        const it = l.items.get(id)
        if (it?.health) it.health = { ...it.health, checkedAt: nowIso() }
      }
      return new HttpResponse(null, { status: 202 })
    }),
    wrap('get', '/api/v1/reports/duplicates', (c) => {
      const only = c.url.searchParams.get('library')
      const groups = new Map<string, ItemWithPath[]>()
      for (const { lib: l, it } of allBookmarks(c.user)) {
        if (!it.url || (only && l.slug !== only)) continue
        const k = normalizeUrl(it.url)
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k)!.push(db().withPath(l, it))
      }
      const out: DuplicateGroup[] = [...groups].filter(([, v]) => v.length > 1).map(([normalizedUrl, items]) => ({ normalizedUrl, items }))
      return out
    }),
    wrap('get', '/api/v1/jobs', (c) => [...db().userJobs(c.user.id).values()]),
    wrap('post', '/api/v1/jobs/:name/run', (c) => {
      const name = c.params.name as JobName
      const jobs = db().userJobs(c.user.id)
      const j = jobs.get(name)
      if (!j) throw fail(404, 'not_found', '任务不存在')
      if (['backup', 'retention', 'cleanup'].includes(name) && !c.user.isAdmin) throw fail(403, 'forbidden', '仅管理员')
      if (j.running) throw fail(409, 'conflict', '任务正在运行')
      j.running = true
      j.lastStartedAt = nowIso()
      setTimeout(() => {
        j.running = false
        j.lastFinishedAt = nowIso()
        j.lastOk = true
        j.lastSummary = `手动运行完成（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`
      }, 600)
      return new HttpResponse(null, { status: 202 })
    }),

    // ---------- import / export ----------
    wrap('post', '/api/v1/libraries/:slug/import', async (c) => {
      const l = writeLib(c)
      const d = db()
      let form: FormData
      try {
        form = await c.request.formData()
      } catch {
        throw fail(415, 'unsupported_media_type', '需要 multipart/form-data')
      }
      const file = form.get('file')
      if (!file || typeof file === 'string') throw fail(422, 'validation', '缺少文件', { file: 'required' })
      if (file.size > 32 * 1024 * 1024) throw fail(413, 'payload_too_large', '文件超过 32 MiB')
      const text = await file.text()
      const format = detectFormat(text)
      if (!format) throw fail(415, 'unsupported_media_type', '无法识别的格式（支持 HTML、XBEL、JSON）')
      let nodes: FNode[]
      try {
        nodes = format === 'html' ? parseHtml(text) : format === 'xbel' ? parseXbel(text) : parseJson(text)
      } catch {
        throw fail(415, 'unsupported_media_type', '文件解析失败')
      }
      const mode = (String(form.get('mode') ?? 'folder') || 'folder') as 'folder' | 'merge' | 'replace'
      if (!['folder', 'merge', 'replace'].includes(mode)) throw fail(422, 'validation', 'mode 不合法', { mode: 'enum' })
      const stats = { b: 0, f: 0, skip: 0 }
      if (mode === 'replace') {
        l.items = new Map()
        insertNodes(l, 0, nodes, mode, stats)
      } else if (mode === 'merge') {
        insertNodes(l, 0, nodes, mode, stats)
      } else {
        const name = String(form.get('folderName') ?? '').trim() || `导入 ${new Date().toISOString().slice(0, 10)}`
        const f = d.insert(l, { type: 'folder', parentId: 0, title: name })
        stats.f++
        insertNodes(l, f.id, nodes, mode, stats)
      }
      const revision = d.commit(l, 'import', actorOf(c), { noMerge: true })
      return { format, mode, addedBookmarks: stats.b, addedFolders: stats.f, skippedDuplicates: stats.skip, revision }
    }),
    wrap('get', '/api/v1/libraries/:slug/export', (c) => {
      const l = lib(c)
      return exportResponse(l, db().snapshot(l), c.url.searchParams.get('format') ?? 'html', l.slug, l.revision)
    }),

    // ---------- settings ----------
    wrap('get', '/api/v1/settings', (c) => c.user.settings),
    wrap('patch', '/api/v1/settings', async (c) => {
      const b = await body<Partial<Settings>>(c.request)
      const s = c.user.settings
      if (b.language !== undefined) {
        if (!['auto', 'zh-CN', 'en'].includes(b.language)) throw fail(422, 'validation', 'language 不合法', { language: 'enum' })
        s.language = b.language
      }
      if (b.theme !== undefined) {
        if (!['system', 'light', 'dark'].includes(b.theme)) throw fail(422, 'validation', 'theme 不合法', { theme: 'enum' })
        s.theme = b.theme
      }
      if (b.openInNewTab !== undefined) s.openInNewTab = !!b.openInNewTab
      if (b.defaultSave !== undefined) {
        if (b.defaultSave) db().lib(c.user.id, b.defaultSave.library)
        s.defaultSave = b.defaultSave
      }
      if (b.startPage !== undefined) s.startPage = validateStartPage(b.startPage)
      return s
    }),

    // ---------- ai ----------
    wrap('get', '/api/v1/ai/status', () => ({ enabled: db().config.aiEnabled, model: db().config.aiEnabled ? 'fake-model' : null })),
    wrap('post', '/api/v1/ai/suggest', async (c) => {
      if (!db().config.aiEnabled) throw fail(503, 'unavailable', 'AI 未启用')
      const b = await body<{ library?: string; url?: string; title?: string }>(c.request)
      const l = db().lib(c.user.id, b.library ?? '')
      const url = b.url ?? ''
      const title = (b.title || fakeTitle(url)).replace(/\s+[-|–]\s+[^-|–]+$/, '').trim()
      let host = ''
      try {
        host = new URL(url).hostname.replace(/^www\./, '').split('.')[0]
      } catch {
        /* ignore */
      }
      const tags = [...new Set([host, ...words(title).slice(0, 3)].filter(Boolean))].slice(0, 5)
      const out: AiSuggestion = { title, folders: suggestFolders(l, url, title), tags }
      return out
    }),
    wrap('post', '/api/v1/ai/organize', async (c) => {
      if (!db().config.aiEnabled) throw fail(503, 'unavailable', 'AI 未启用')
      const b = await body<{ library?: string; folderId?: number; limit?: number }>(c.request)
      const d = db()
      const l = d.lib(c.user.id, b.library ?? '')
      d.folder(l, b.folderId ?? 0)
      const items = d.children(l, b.folderId ?? 0).filter((i) => i.type === 'bookmark').slice(0, b.limit ?? 50)
      const out: AiOrganizeResult = {
        suggestions: items.map((it) => {
          const best = suggestFolders(l, it.url ?? '', it.title).find((f) => f.folderId !== it.parentId) ?? { folderId: it.parentId, path: d.path(l, it.id).path }
          let host = ''
          try {
            host = new URL(it.url ?? '').hostname.replace(/^www\./, '').split('.')[0]
          } catch {
            /* ignore */
          }
          return { itemId: it.id, title: it.title, url: it.url ?? '', folderId: best.folderId, path: best.path, tags: host ? [host] : [] }
        }),
      }
      return out
    }),

    // ---------- downloads（插件包由服务端提供，这里给占位文件） ----------
    pub('get', '/downloads/:file', ({ params }) => {
      if (!/\.zip$/.test(params.file)) throw fail(404, 'not_found', '不存在')
      return new HttpResponse(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]), {
        headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${params.file}"` },
      })
    }),
  ]

  function pendingOut(p: MPending): PendingUpload {
    const { items: _i, userId: _u, highestId: _h, ...rest } = p
    return rest
  }

  function findPending(c: Ctx, l: MLib): MPending {
    const id = int(c.params.pendingId, 'pendingId')
    const p = db().pending.find((x) => x.id === id && x.userId === c.user.id && x.library === l.slug)
    if (!p) throw fail(404, 'not_found', '待确认的上传不存在')
    return p
  }
}

function validateStartPage(sp: StartPage): StartPage {
  const bad = (f: string) => fail(422, 'validation', `startPage.${f} 不合法`, { [`startPage.${f}`]: 'invalid' })
  if (typeof sp !== 'object' || !sp) throw bad('')
  for (const k of ['recentCount', 'frequentCount'] as const) if (!(sp[k] >= 1 && sp[k] <= 50)) throw bad(k)
  if (!Array.isArray(sp.sections) || sp.sections.length > 50) throw bad('sections')
  for (const s of sp.sections) if (!s.id || !s.library || typeof s.folderId !== 'number' || !['grid', 'list'].includes(s.layout)) throw bad('sections')
  return sp
}

export function fakeTitle(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const seg = u.pathname.split('/').filter(Boolean).pop()
    const name = host.split('.')[0]
    const cap = name.charAt(0).toUpperCase() + name.slice(1)
    return seg ? `${decodeURIComponent(seg).replace(/[-_]/g, ' ')} - ${cap}` : cap
  } catch {
    return url
  }
}
