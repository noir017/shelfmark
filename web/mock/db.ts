// 内存假后端的数据与业务逻辑（按 api/openapi.yaml 和 docs/design.md 实现）。
// 只给开发和测试用；规则尽量与真实服务端一致，细节不追求完全相同。
import type {
  Diff, DiffItem, Health, HealthStatus, Item, ItemWithPath, Job, JobName, LockInfo, Settings,
  StartPage, Token,
} from '../src/api/types'
import { normalizeUrl } from '../src/lib/url.ts'

export type Source = 'webdav' | 'web' | 'api' | 'extension' | 'import' | 'restore' | 'system'

export interface MItem {
  id: number
  type: 'folder' | 'bookmark'
  parentId: number
  position: number
  title: string
  url: string | null
  createdAt: string
  updatedAt: string
  notes: string | null
  tags: string[]
  faviconId: string | null
  health: Health | null
  visitCount: number
  lastVisitedAt: string | null
}

export interface Snap {
  id: number
  parentId: number
  position: number
  type: 'folder' | 'bookmark'
  title: string
  url: string | null
  notes: string | null
  tags: string[]
}

export interface MRev {
  rev: number
  createdAt: string
  source: Source
  actor: string
  added: number
  removed: number
  changed: number
  moved: number
  totalBookmarks: number
  snapshot: Snap[]
  hash: string
}

export interface MLock {
  actor: string
  since: string
  modifiedAt: string
  /** 到这个时间点（毫秒）锁自动解除，模拟 Floccus 同步结束 */
  releaseAt: number
}

export interface MLib {
  userId: number
  slug: string
  name: string
  highestId: number
  revision: number
  /** 每次树变化都递增（含合并修订），用于 ETag */
  changeSeq: number
  items: Map<number, MItem>
  createdAt: string
  updatedAt: string
  lastSyncAt: string | null
  lastSyncActor: string | null
  lock: MLock | null
  revisions: MRev[]
  restored: Set<string>
}

export interface MUser {
  id: number
  username: string
  password: string
  isAdmin: boolean
  createdAt: string
  settings: Settings
}

export interface MToken extends Token {
  userId: number
  token: string
  revoked: boolean
}

export interface MPending {
  id: number
  userId: number
  library: string
  createdAt: string
  actor: string
  added: number
  removed: number
  changed: number
  moved: number
  totalBefore: number
  reason: string
  items: Snap[]
  highestId: number
}

export interface MockConfig {
  aiEnabled: boolean
  cfAccessSso: boolean
  /** Access 单点登录映射到的用户名；null 表示 JWT 无效或没有映射 */
  accessUser: string | null
  /** 模拟 Cloudflare Access 会话过期：除放行路径外一律 302 到 Access 登录页 */
  accessExpired: boolean
  /** 模拟断网：直接断开连接 */
  offline: boolean
  retryAfter: number
  mergeWindowMs: number
  guardRatio: number
  guardMinItems: number
  /** 每个 API 请求的人为延迟 */
  latencyMs: number
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(message)
  }
}

export const nowIso = () => new Date().toISOString()

export function defaultStartPage(): StartPage {
  return { showSearch: true, showRecent: true, recentCount: 8, showFrequent: true, frequentCount: 8, sections: [] }
}

export function defaultSettings(): Settings {
  return {
    language: 'auto',
    theme: 'system',
    openInNewTab: false,
    defaultSave: null,
    recentSaveTargets: [],
    startPage: defaultStartPage(),
  }
}

/** 32 位十六进制的稳定哈希（假图标 ID 用） */
export function hex32(s: string): string {
  let out = ''
  for (let k = 0; k < 4; k++) {
    let h = 0x811c9dc5 ^ k
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out
}

const SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/

export function defaultConfig(): MockConfig {
  return {
    aiEnabled: false,
    cfAccessSso: false,
    accessUser: null,
    accessExpired: false,
    offline: false,
    retryAfter: 1,
    mergeWindowMs: 120_000,
    guardRatio: 0.5,
    guardMinItems: 20,
    latencyMs: 0,
  }
}

export class MockDB {
  users: MUser[] = []
  sessions = new Map<string, { userId: number; method: 'session' | 'access' }>()
  tokens: MToken[] = []
  libs: MLib[] = []
  pending: MPending[] = []
  favicons = new Map<string, { letter: string; color: string }>()
  jobs = new Map<number, Map<JobName, Job>>()
  config: MockConfig = defaultConfig()
  loginFailures = 0
  seq = { user: 1, token: 1, pending: 1 }

  // ---------- 用户与认证 ----------

  addUser(username: string, password: string, isAdmin: boolean, at = nowIso()): MUser {
    const u: MUser = { id: this.seq.user++, username, password, isAdmin, createdAt: at, settings: defaultSettings() }
    this.users.push(u)
    this.createLibrary(u.id, 'bookmarks', 'bookmarks', at)
    return u
  }

  newSession(userId: number, method: 'session' | 'access' = 'session'): string {
    const sid = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    this.sessions.set(sid, { userId, method })
    return sid
  }

  createToken(userId: number, name: string, scopes: Array<'api' | 'dav'>): MToken {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let tok = 'smk_'
    for (let i = 0; i < 43; i++) tok += chars[Math.floor(Math.random() * chars.length)]
    const t: MToken = {
      id: this.seq.token++, userId, name, scopes, prefix: tok.slice(0, 8), token: tok,
      createdAt: nowIso(), lastUsedAt: null, lastUsedIp: null, revoked: false,
    }
    this.tokens.push(t)
    return t
  }

  publicToken(t: MToken): Token {
    return { id: t.id, name: t.name, scopes: t.scopes, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, lastUsedIp: t.lastUsedIp }
  }

  // ---------- 库 ----------

  createLibrary(userId: number, slug: string, name: string, at = nowIso()): MLib {
    if (!SLUG_RE.test(slug)) throw new HttpError(422, 'validation', 'slug 不合法', { slug: 'pattern' })
    if (this.libs.some((l) => l.userId === userId && l.slug === slug)) throw new HttpError(409, 'conflict', '库已存在')
    const lib: MLib = {
      userId, slug, name, highestId: 0, revision: 0, changeSeq: 0, items: new Map(), createdAt: at, updatedAt: at,
      lastSyncAt: null, lastSyncActor: null, lock: null, revisions: [], restored: new Set(),
    }
    this.libs.push(lib)
    return lib
  }

  lib(userId: number, slug: string): MLib {
    const l = this.libs.find((x) => x.userId === userId && x.slug === slug)
    if (!l) throw new HttpError(404, 'not_found', `库 ${slug} 不存在`)
    return l
  }

  userLibs(userId: number): MLib[] {
    return this.libs.filter((l) => l.userId === userId)
  }

  lockInfo(lib: MLib): LockInfo | null {
    this.expireLock(lib)
    if (!lib.lock) return null
    const fresh = Date.now() - Date.parse(lib.lock.modifiedAt) < 15 * 60_000
    return { actor: lib.lock.actor, since: lib.lock.since, modifiedAt: lib.lock.modifiedAt, fresh }
  }

  expireLock(lib: MLib) {
    if (lib.lock && Date.now() >= lib.lock.releaseAt) {
      lib.lastSyncAt = nowIso()
      lib.lastSyncActor = lib.lock.actor
      lib.lock = null
    }
  }

  /** API 写入前检查 Floccus 锁 */
  checkLock(lib: MLib) {
    this.expireLock(lib)
    if (lib.lock) {
      throw new HttpError(423, 'locked', `正在与 ${lib.lock.actor} 同步`, { actor: lib.lock.actor, since: lib.lock.since }, {
        'Retry-After': String(this.config.retryAfter),
      })
    }
  }

  // ---------- 条目 ----------

  children(lib: MLib, parentId: number): MItem[] {
    return [...lib.items.values()].filter((i) => i.parentId === parentId).sort((a, b) => a.position - b.position)
  }

  reindex(lib: MLib, parentId: number) {
    this.children(lib, parentId).forEach((c, i) => (c.position = i))
  }

  item(lib: MLib, id: number): MItem {
    const it = lib.items.get(id)
    if (!it) throw new HttpError(404, 'not_found', `条目 ${id} 不存在`)
    return it
  }

  folder(lib: MLib, id: number): void {
    if (id === 0) return
    const f = lib.items.get(id)
    if (!f) throw new HttpError(404, 'not_found', `文件夹 ${id} 不存在`)
    if (f.type !== 'folder') throw new HttpError(422, 'validation', '目标不是文件夹', { parentId: 'not_folder' })
  }

  subtree(lib: MLib, id: number): number[] {
    const out = [id]
    for (const c of this.children(lib, id)) out.push(...this.subtree(lib, c.id))
    return out
  }

  path(lib: MLib, id: number): { path: string[]; pathIds: number[] } {
    const path: string[] = []
    const pathIds: number[] = []
    let p = lib.items.get(id)?.parentId ?? 0
    while (p) {
      const f = lib.items.get(p)
      if (!f) break
      path.unshift(f.title)
      pathIds.unshift(f.id)
      p = f.parentId
    }
    return { path, pathIds }
  }

  apiItem(lib: MLib, it: MItem, withChildren: boolean): Item {
    const out: Item = {
      id: it.id, type: it.type, parentId: it.parentId, position: it.position, title: it.title, url: it.url,
      createdAt: it.createdAt, updatedAt: it.updatedAt, notes: it.notes, tags: [...it.tags], faviconId: it.faviconId,
      health: it.health, visitCount: it.visitCount, lastVisitedAt: it.lastVisitedAt,
    }
    if (withChildren && it.type === 'folder') out.children = this.children(lib, it.id).map((c) => this.apiItem(lib, c, true))
    return out
  }

  withPath(lib: MLib, it: MItem): ItemWithPath {
    return { library: lib.slug, item: this.apiItem(lib, it, false), ...this.path(lib, it.id) }
  }

  bookmarkCount(lib: MLib): number {
    let n = 0
    for (const i of lib.items.values()) if (i.type === 'bookmark') n++
    return n
  }

  /** 新建条目（不提交修订） */
  insert(
    lib: MLib,
    data: { type: 'folder' | 'bookmark'; parentId: number; position?: number; title: string; url?: string | null; notes?: string | null; tags?: string[] },
    at = nowIso(),
  ): MItem {
    this.folder(lib, data.parentId)
    if (data.type === 'bookmark' && !data.url) throw new HttpError(422, 'validation', '书签必须有 URL', { url: 'required' })
    const id = ++lib.highestId
    const sibs = this.children(lib, data.parentId)
    const pos = data.position === undefined ? sibs.length : Math.max(0, Math.min(data.position, sibs.length))
    for (const s of sibs) if (s.position >= pos) s.position++
    const it: MItem = {
      id, type: data.type, parentId: data.parentId, position: pos, title: data.title ?? '',
      url: data.type === 'bookmark' ? data.url ?? null : null, createdAt: at, updatedAt: at,
      notes: data.notes ?? null, tags: cleanTags(data.tags ?? []), faviconId: null, health: null, visitCount: 0, lastVisitedAt: null,
    }
    if (it.url) it.faviconId = this.faviconFor(it.url, it.title)
    lib.items.set(id, it)
    return it
  }

  move(lib: MLib, id: number, parentId: number, position?: number) {
    const it = this.item(lib, id)
    this.folder(lib, parentId)
    if (parentId !== 0 && this.subtree(lib, id).includes(parentId)) throw new HttpError(409, 'conflict', '不能移动到自己或子文件夹里')
    const oldParent = it.parentId
    it.parentId = -1
    this.reindex(lib, oldParent)
    const sibs = this.children(lib, parentId)
    const pos = position === undefined ? sibs.length : Math.max(0, Math.min(position, sibs.length))
    for (const s of sibs) if (s.position >= pos) s.position++
    it.parentId = parentId
    it.position = pos
    it.updatedAt = nowIso()
  }

  remove(lib: MLib, id: number) {
    const it = this.item(lib, id)
    for (const x of this.subtree(lib, id)) lib.items.delete(x)
    this.reindex(lib, it.parentId)
  }

  update(lib: MLib, id: number, patch: { title?: string; url?: string; notes?: string | null; tags?: string[] }) {
    const it = this.item(lib, id)
    if (patch.title !== undefined) it.title = patch.title
    if (patch.url !== undefined) {
      if (it.type !== 'bookmark') throw new HttpError(422, 'validation', '文件夹没有 URL', { url: 'folder' })
      if (!patch.url) throw new HttpError(422, 'validation', 'URL 不能为空', { url: 'required' })
      it.url = patch.url
      it.faviconId = this.faviconFor(it.url, it.title)
    }
    if (patch.notes !== undefined) it.notes = patch.notes || null
    if (patch.tags !== undefined) it.tags = cleanTags(patch.tags)
    it.updatedAt = nowIso()
  }

  faviconFor(url: string, title: string): string | null {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return null
    }
    const id = hex32(host)
    if (!this.favicons.has(id)) {
      const colors = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#2a9d8f', '#8338ec', '#ff006e', '#3a86ff']
      const letter = (host.replace(/^www\./, '')[0] ?? title[0] ?? '?').toUpperCase()
      this.favicons.set(id, { letter, color: colors[parseInt(id.slice(0, 2), 16) % colors.length] })
    }
    return id
  }

  // ---------- 修订 ----------

  snapshot(lib: MLib): Snap[] {
    return [...lib.items.values()]
      .map((i) => ({ id: i.id, parentId: i.parentId, position: i.position, type: i.type, title: i.title, url: i.url, notes: i.notes, tags: [...i.tags] }))
      .sort((a, b) => a.parentId - b.parentId || a.position - b.position)
  }

  /** 生成修订（含 6.2 的合并规则），返回当前修订号 */
  commit(lib: MLib, source: Source, actor: string, opts: { noMerge?: boolean; at?: string } = {}): number {
    const at = opts.at ?? nowIso()
    const snap = this.snapshot(lib)
    const hash = JSON.stringify(snap)
    const last = lib.revisions[lib.revisions.length - 1]
    if (last && last.hash === hash) return lib.revision
    lib.changeSeq++
    lib.updatedAt = at
    const mergeable =
      !!last && !opts.noMerge && source !== 'webdav' && source !== 'restore' && last.source === source && last.actor === actor &&
      Date.parse(at) - Date.parse(last.createdAt) < this.config.mergeWindowMs
    const base = mergeable ? (lib.revisions[lib.revisions.length - 2]?.snapshot ?? []) : (last?.snapshot ?? [])
    const { counts } = diffSnaps(base, snap)
    const totalBookmarks = snap.filter((s) => s.type === 'bookmark').length
    if (mergeable) {
      Object.assign(last!, { snapshot: snap, hash, totalBookmarks, ...counts })
    } else {
      lib.revision++
      lib.revisions.push({ rev: lib.revision, createdAt: at, source, actor, totalBookmarks, snapshot: snap, hash, ...counts })
    }
    return lib.revision
  }

  /** 修订 rev 相对上一修订的差异 */
  revisionDiff(lib: MLib, rev: number): { rev: MRev; diff: Diff; prev: Snap[] } {
    const i = lib.revisions.findIndex((r) => r.rev === rev)
    if (i === -1) throw new HttpError(404, 'not_found', `修订 ${rev} 不存在`)
    const prev = lib.revisions[i - 1]?.snapshot ?? []
    return { rev: lib.revisions[i], diff: diffSnaps(prev, lib.revisions[i].snapshot).diff, prev }
  }

  /** 用快照替换当前树（保留已有条目的元数据） */
  replaceWithSnapshot(lib: MLib, snap: Snap[]) {
    const old = lib.items
    const next = new Map<number, MItem>()
    const at = nowIso()
    for (const s of snap) {
      const o = old.get(s.id)
      next.set(s.id, {
        id: s.id, type: s.type, parentId: s.parentId, position: s.position, title: s.title, url: s.url,
        notes: s.notes, tags: [...s.tags], createdAt: o?.createdAt ?? at, updatedAt: at,
        faviconId: s.url ? (o?.faviconId ?? this.faviconFor(s.url, s.title)) : null,
        health: o?.health ?? null, visitCount: o?.visitCount ?? 0, lastVisitedAt: o?.lastVisitedAt ?? null,
      })
    }
    lib.items = next
    lib.highestId = Math.max(lib.highestId, ...snap.map((s) => s.id), 0)
  }

  /** 模拟 Floccus 上传（含 4.4 第 5 步的防误删保护）；返回 null 表示已应用，否则为被拦截的记录 */
  davUpload(lib: MLib, snap: Snap[], actor: string): MPending | null {
    const before = this.snapshot(lib)
    const { counts } = diffSnaps(before, snap)
    const current = this.bookmarkCount(lib)
    const ids = new Set(snap.map((s) => s.id))
    const removedBookmarks = before.filter((s) => s.type === 'bookmark' && !ids.has(s.id)).length
    const { guardRatio, guardMinItems } = this.config
    if (guardRatio > 0 && current >= guardMinItems && removedBookmarks >= current * guardRatio) {
      const p: MPending = {
        id: this.seq.pending++, userId: lib.userId, library: lib.slug, createdAt: nowIso(), actor, ...counts,
        totalBefore: current, reason: `这次上传会删除 ${removedBookmarks} 个书签（共 ${current} 个），已拦截`, items: snap,
        highestId: Math.max(0, ...snap.map((s) => s.id)),
      }
      this.pending.push(p)
      return p
    }
    this.replaceWithSnapshot(lib, snap)
    this.commit(lib, 'webdav', actor, { noMerge: true })
    lib.lastSyncAt = nowIso()
    lib.lastSyncActor = actor
    return null
  }

  // ---------- 任务 ----------

  userJobs(userId: number): Map<JobName, Job> {
    let m = this.jobs.get(userId)
    if (!m) {
      m = new Map()
      const day = 86_400_000
      const mk = (name: JobName, every: number, summary: string): Job => ({
        name, enabled: true, running: false, lastStartedAt: new Date(Date.now() - day / 2).toISOString(),
        lastFinishedAt: new Date(Date.now() - day / 2 + 4000).toISOString(), lastOk: true, lastSummary: summary,
        nextRunAt: new Date(Date.now() + every).toISOString(),
      })
      m.set('linkcheck', mk('linkcheck', 7 * day, '检测 42 个，失效 2 个'))
      m.set('metadata', mk('metadata', 0, '抓取 3 个图标'))
      m.set('retention', mk('retention', day, '清理 0 个修订'))
      m.set('cleanup', mk('cleanup', 3_600_000, '清理 1 个临时文件'))
      m.set('backup', mk('backup', day, 'shelfmark-20261114-030000.db'))
      this.jobs.set(userId, m)
    }
    return m
  }
}

export function cleanTags(tags: string[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    const v = t.trim().replace(/[\s,]+/g, '-')
    if (v && v.length <= 64 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  return out
}

// ---------- 差异 ----------

function snapIndex(s: Snap[]) {
  const m = new Map(s.map((x) => [x.id, x]))
  const path = (id: number): string[] => {
    const out: string[] = []
    let p = m.get(id)?.parentId ?? 0
    while (p && m.has(p)) {
      out.unshift(m.get(p)!.title)
      p = m.get(p)!.parentId
    }
    return out
  }
  const kids = new Map<number, Snap[]>()
  for (const x of s) {
    if (!kids.has(x.parentId)) kids.set(x.parentId, [])
    kids.get(x.parentId)!.push(x)
  }
  for (const v of kids.values()) v.sort((a, b) => a.position - b.position)
  const countBookmarks = (id: number): number =>
    (kids.get(id) ?? []).reduce((n, c) => n + (c.type === 'bookmark' ? 1 : countBookmarks(c.id)), 0)
  return { m, path, kids, countBookmarks }
}

export function diffSnaps(prev: Snap[], next: Snap[]) {
  const a = snapIndex(prev)
  const b = snapIndex(next)
  const diff: Diff = { added: [], removed: [], changed: [], moved: [], reorderedCount: 0 }
  let addedAll = 0
  let removedAll = 0
  const toDiffItem = (s: Snap, idx: ReturnType<typeof snapIndex>): DiffItem => {
    const d: DiffItem = { id: s.id, type: s.type, title: s.title, url: s.url, path: idx.path(s.id), notes: s.notes, tags: [...s.tags] }
    if (s.type === 'folder') d.childCount = idx.countBookmarks(s.id)
    return d
  }
  for (const s of next) {
    if (a.m.has(s.id)) continue
    addedAll++
    if (!b.m.get(s.parentId) || a.m.has(s.parentId)) diff.added.push(toDiffItem(s, b))
  }
  for (const s of prev) {
    if (b.m.has(s.id)) continue
    removedAll++
    if (!a.m.get(s.parentId) || b.m.has(s.parentId)) diff.removed.push(toDiffItem(s, a))
  }
  for (const s of next) {
    const o = a.m.get(s.id)
    if (!o) continue
    if (o.title !== s.title || (o.url ?? null) !== (s.url ?? null)) {
      diff.changed.push({ id: s.id, type: s.type, path: b.path(s.id), before: { title: o.title, url: o.url }, after: { title: s.title, url: s.url } })
    }
    if (o.parentId !== s.parentId) {
      diff.moved.push({ id: s.id, type: s.type, title: s.title, url: s.url, fromPath: a.path(s.id), toPath: b.path(s.id), fromPosition: o.position, toPosition: s.position })
    }
  }
  // 同一文件夹内的重排：只看两边都在、父未变的兄弟的相对顺序
  for (const [pid, kidsB] of b.kids) {
    const kidsA = a.kids.get(pid) ?? []
    const common = new Set(kidsA.filter((x) => kidsB.some((y) => y.id === x.id)).map((x) => x.id))
    const orderA = kidsA.filter((x) => common.has(x.id)).map((x) => x.id)
    const orderB = kidsB.filter((x) => common.has(x.id)).map((x) => x.id)
    for (let i = 0; i < orderA.length; i++) if (orderA[i] !== orderB[i]) diff.reorderedCount!++
  }
  const counts = { added: addedAll, removed: removedAll, changed: diff.changed.length, moved: diff.moved.length + (diff.reorderedCount ?? 0) }
  return { diff, counts }
}

export const healthOf = (status: HealthStatus, extra: Partial<Health> = {}): Health => ({
  status, httpStatus: null, finalUrl: null, checkedAt: new Date(Date.now() - 86_400_000).toISOString(), error: null, ...extra,
})

export { normalizeUrl }
