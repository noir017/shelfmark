// Service Worker：缓存应用外壳（构建时注入预缓存清单）。
// - 导航请求走网络；只有网络真正失败（fetch 抛错）时才回退到缓存的 index.html。
//   跳转（如 Cloudflare Access 登录页）原样交给浏览器，不缓存、不回退。
// - /assets/ 下带哈希的文件缓存优先；/api/ 只缓存图标，其余数据由页面存 IndexedDB。
// - 校验响应：必须同源、200、未经跳转，且类型对得上，防止把网关登录页当成应用文件缓存。

export {}

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  request: Request
  respondWith(r: Response | Promise<Response>): void
}
interface SWGlobal {
  location: Location
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void
  __SW_VERSION__: string
  __PRECACHE__: string[]
}

const sw = self as unknown as SWGlobal
const VERSION: string = sw.__SW_VERSION__
const PRECACHE: string[] = sw.__PRECACHE__
const SHELL = `shelfmark-shell-${VERSION}`
const ICONS = 'shelfmark-favicons'

function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/html')
}

/** 能否作为应用文件缓存 */
function cacheable(res: Response, expectHtml: boolean): boolean {
  if (!res.ok || res.status !== 200 || res.redirected || res.type !== 'basic') return false
  return expectHtml ? isHtml(res) : !isHtml(res)
}

async function precache(): Promise<void> {
  const cache = await caches.open(SHELL)
  const shell = await fetch('/index.html', { cache: 'reload', redirect: 'manual' })
  if (!cacheable(shell, true)) throw new Error('shell not cacheable')
  await cache.put('/index.html', shell)
  await Promise.all(
    PRECACHE.map(async (url) => {
      const res = await fetch(url, { cache: 'reload', redirect: 'manual' })
      if (!cacheable(res, false)) throw new Error(`not cacheable: ${url}`)
      await cache.put(url, res)
    }),
  )
}

sw.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => sw.skipWaiting()))
})

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('shelfmark-shell-') && k !== SHELL) await caches.delete(k)
      await sw.clients.claim()
    })(),
  )
})

sw.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') sw.skipWaiting()
})

async function navigate(req: Request): Promise<Response> {
  try {
    // 原样返回网络结果，包括跳转和错误页；不写缓存
    return await fetch(req)
  } catch {
    const cached = await caches.match('/index.html', { cacheName: SHELL })
    return cached ?? Response.error()
  }
}

async function cacheFirst(req: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (cacheable(res, false)) await cache.put(req, res.clone())
  return res
}

sw.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== sw.location.origin) return
  const p = url.pathname
  if (p.startsWith('/cdn-cgi/') || p.startsWith('/__mock/') || p.startsWith('/dav/') || p.startsWith('/downloads/')) return
  if (req.mode === 'navigate') {
    e.respondWith(navigate(req))
    return
  }
  if (p.startsWith('/api/v1/favicons/')) {
    e.respondWith(cacheFirst(req, ICONS))
    return
  }
  if (p.startsWith('/api/')) return
  if (PRECACHE.includes(p) || p.startsWith('/assets/')) e.respondWith(cacheFirst(req, SHELL))
})
