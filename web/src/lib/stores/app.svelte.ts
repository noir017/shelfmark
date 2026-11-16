// 应用级状态：系统信息、当前用户、设置、库列表、待确认上传、联网状态
import { api, client, unwrap } from '../../api'
import { AccessExpiredError, ApiError, NetworkError } from '../../api/client'
import type { Library, Me, PendingUpload, QuickSaveRequest, Settings, SettingsPatch, SystemInfo } from '../../api/types'
import { setLang, t } from '../i18n/index.svelte'
import { kvGet, kvSet } from '../offline/idb'
import { flushQueue, listQueued } from '../offline/queue'
import { setTheme } from '../theme'
import { dismissKey, toast } from '../toast.svelte'

export const app = $state({
  booted: false,
  bootError: null as string | null,
  info: null as SystemInfo | null,
  me: null as Me | null,
  settings: null as Settings | null,
  libraries: [] as Library[],
  pending: [] as PendingUpload[],
  /** 服务端可达 */
  online: true,
  /** Cloudflare Access 会话过期 */
  accessExpired: false,
  queueCount: 0,
})

export const cacheKey = {
  last: 'last',
  settings: () => `u:${app.me?.user.username}:settings`,
  libraries: () => `u:${app.me?.user.username}:libraries`,
  tree: (slug: string) => `u:${app.me?.user.username}:tree:${slug}`,
}

export function errorText(e: unknown): string {
  if (e instanceof NetworkError) return t('error.network')
  if (e instanceof AccessExpiredError) return t('error.accessExpired')
  if (e instanceof ApiError) {
    if (e.code === 'locked') return t('error.locked', { actor: String(e.details?.actor ?? '?') })
    if (e.code === 'unauthorized' && e.status === 401) return e.message || t('error.unauthorized')
    if (e.code === 'rate_limited') return t('error.rateLimited')
    return e.message || t('error.generic')
  }
  return e instanceof Error ? e.message : String(e)
}

function installHooks() {
  api.hooks.onNetworkError = () => {
    app.online = false
  }
  api.hooks.onReachable = () => {
    if (!app.online) {
      app.online = true
      void onBackOnline()
    }
  }
  api.hooks.onAccessExpired = () => {
    app.accessExpired = true
  }
  api.hooks.onUnauthorized = () => {
    // 身份没了（Access 会话过期或服务端拒绝）：让用户点一下刷新，重新走 Access 登录
    app.accessExpired = true
  }
  api.hooks.onLocked = (n) => {
    toast(t('lock.retrying', { actor: n.actor ?? '?', attempt: n.attempt, max: n.maxAttempts }), { kind: 'warn', key: 'lock', timeout: n.retryAfterMs + 1500 })
  }
}

export function applyPrefs() {
  const s = app.settings
  void setLang(s?.language ?? (localStorage.getItem('shelfmark.lang') as 'zh-CN' | 'en' | null) ?? 'auto')
  setTheme(s?.theme ?? ((localStorage.getItem('shelfmark.theme') as 'system' | 'light' | 'dark' | null) ?? 'system'))
}

export async function boot() {
  installHooks()
  window.addEventListener('online', () => void onBackOnline())
  try {
    app.info = await unwrap(client.GET('/api/v1/system/info'))
    const r = await client.GET('/api/v1/auth/me')
    app.me = r.response.ok ? r.data! : null
    if (app.me) await loadUserData()
  } catch (e) {
    if (e instanceof NetworkError) await bootOffline()
    else if (!(e instanceof AccessExpiredError)) app.bootError = errorText(e)
  }
  applyPrefs()
  app.booted = true
  void refreshQueueCount()
  if (app.me && app.online) void flushOffline()
}

async function bootOffline() {
  app.online = false
  const last = await kvGet<{ info: SystemInfo; me: Me }>(cacheKey.last)
  if (!last) {
    app.bootError = t('error.offlineNoCache')
    return
  }
  app.info = last.info
  app.me = last.me
  app.settings = (await kvGet<Settings>(cacheKey.settings())) ?? null
  app.libraries = (await kvGet<Library[]>(cacheKey.libraries())) ?? []
}

export async function loadUserData() {
  const [settings, libraries] = await Promise.all([unwrap(client.GET('/api/v1/settings')), unwrap(client.GET('/api/v1/libraries'))])
  app.settings = settings
  app.libraries = libraries
  void kvSet(cacheKey.last, { info: $state.snapshot(app.info), me: $state.snapshot(app.me) })
  void kvSet(cacheKey.settings(), settings)
  void kvSet(cacheKey.libraries(), libraries)
  void refreshPending()
}

export async function refreshLibraries() {
  try {
    app.libraries = await unwrap(client.GET('/api/v1/libraries'))
    void kvSet(cacheKey.libraries(), $state.snapshot(app.libraries))
  } catch {
    /* 离线时保留缓存 */
  }
}

export async function refreshPending() {
  try {
    app.pending = await unwrap(client.GET('/api/v1/pending'))
  } catch {
    /* ignore */
  }
}

export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const s = await unwrap(client.PATCH('/api/v1/settings', { body: patch }))
  app.settings = s
  void kvSet(cacheKey.settings(), s)
  applyPrefs()
  return s
}

// 只有经 Cloudflare Access 访问时才有"退出"可做；内网没有会话可退。
export function logout() {
  location.href = '/cdn-cgi/access/logout'
}

/** 书签默认用新标签页打开；设置还没加载时也按新标签页 */
export function opensInNewTab(): boolean {
  return app.settings?.openInNewTab ?? true
}

export function defaultLibrary(): string | null {
  const d = app.settings?.defaultSave?.library
  if (d && app.libraries.some((l) => l.slug === d)) return d
  return app.libraries.find((l) => l.slug === 'bookmarks')?.slug ?? app.libraries[0]?.slug ?? null
}

export async function refreshQueueCount() {
  try {
    app.queueCount = (await listQueued()).length
  } catch {
    app.queueCount = 0
  }
}

export async function flushOffline() {
  await refreshQueueCount()
  if (!app.queueCount || !app.me) return
  const send = (r: QuickSaveRequest) => unwrap(client.POST('/api/v1/quick-save', { body: r }))
  const s = await flushQueue(send, (o) => {
    const title = o.entry.request.title || o.entry.request.url
    if (o.ok) toast(t(o.result.existed ? 'queue.existed' : 'queue.sent', { title }), { kind: 'success' })
    else toast(t('queue.failed', { title, error: errorText(o.error) }), { kind: 'error', timeout: 10000 })
  })
  await refreshQueueCount()
  if (s.sent) void refreshLibraries()
}

async function onBackOnline() {
  dismissKey('offline')
  if (!app.me) return
  await flushOffline()
  void refreshLibraries()
  void refreshPending()
}
