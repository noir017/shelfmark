// History API 路由：路由表 + 懒加载页面；拦截站内 <a> 点击
import type { Component } from 'svelte'

type Loader = () => Promise<{ default: Component<any> }>

export interface RouteDef {
  name: string
  pattern: string
  load: Loader
  /** 不显示顶栏和底部导航 */
  bare?: boolean
}

export const routes: RouteDef[] = [
  { name: 'start', pattern: '/', load: () => import('../pages/StartPage.svelte') },
  { name: 'manager', pattern: '/lib', load: () => import('../pages/Manager.svelte') },
  { name: 'manager', pattern: '/lib/:slug', load: () => import('../pages/Manager.svelte') },
  { name: 'manager', pattern: '/lib/:slug/f/:folderId', load: () => import('../pages/Manager.svelte') },
  { name: 'search', pattern: '/search', load: () => import('../pages/Search.svelte') },
  { name: 'share', pattern: '/share', load: () => import('../pages/Share.svelte') },
  { name: 'share', pattern: '/add', load: () => import('../pages/Share.svelte') },
  { name: 'history', pattern: '/history/:slug', load: () => import('../pages/History.svelte') },
  { name: 'deleted', pattern: '/deleted/:slug', load: () => import('../pages/Deleted.svelte') },
  { name: 'pending', pattern: '/pending/:slug/:id', load: () => import('../pages/Pending.svelte') },
  { name: 'broken', pattern: '/reports/broken', load: () => import('../pages/ReportBroken.svelte') },
  { name: 'duplicates', pattern: '/reports/duplicates', load: () => import('../pages/ReportDuplicates.svelte') },
  { name: 'settings', pattern: '/settings', load: () => import('../pages/Settings.svelte') },
  { name: 'settings', pattern: '/settings/:section', load: () => import('../pages/Settings.svelte') },
]

const notFound: RouteDef = { name: 'notfound', pattern: '*', load: () => import('../pages/NotFound.svelte') }

export interface Current {
  def: RouteDef
  params: Record<string, string>
  query: URLSearchParams
  path: string
  /** 每次导航递增，页面可据此重新加载 */
  key: number
}

function compile(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/\/:(\w+)/g, '/(?<$1>[^/]+)') + '/?$')
}
const compiled = routes.map((r) => ({ r, re: compile(r.pattern) }))

export function match(path: string): { def: RouteDef; params: Record<string, string> } {
  for (const { r, re } of compiled) {
    const m = path.match(re)
    if (m) {
      const params: Record<string, string> = {}
      for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = decodeURIComponent(v)
      return { def: r, params }
    }
  }
  return { def: notFound, params: {} }
}

let key = 0
function read(): Current {
  const { def, params } = match(location.pathname)
  return { def, params, query: new URLSearchParams(location.search), path: location.pathname, key: ++key }
}

export const router = $state<{ current: Current }>({ current: read() })

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, location.href)
  const same = url.pathname + url.search === location.pathname + location.search
  if (opts.replace || same) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  router.current = read()
  if (!opts.replace && !same) window.scrollTo(0, 0)
}

export function installRouter() {
  window.addEventListener('popstate', () => (router.current = read()))
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return
    const href = a.getAttribute('href')
    if (!href || href.startsWith('#')) return
    const url = new URL(a.href)
    if (url.origin !== location.origin) return
    if (/^\/(api|dav|downloads|healthz)\b/.test(url.pathname)) return
    e.preventDefault()
    navigate(url.pathname + url.search + url.hash)
  })
}
