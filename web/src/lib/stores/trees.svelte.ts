// 各库的树：内存 + IndexedDB 缓存，ETag 增量刷新；离线时用缓存只读浏览
import { client } from '../../api'
import { AccessExpiredError, NetworkError, errorFromResponse } from '../../api/client'
import type { Tree } from '../../api/types'
import { kvGet, kvSet } from '../offline/idb'
import { indexTree, type TreeIndex } from '../tree'
import { app, cacheKey, errorText } from './app.svelte'

export class TreeEntry {
  tree = $state.raw<Tree | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)
  /** 当前显示的是本地缓存（离线或尚未刷新） */
  stale = $state(false)
  etag: string | null = null
  cacheChecked = false
  index: TreeIndex | null = $derived(this.tree ? indexTree(this.tree.children) : null)
  constructor(public slug: string) {}
}

const entries = new Map<string, TreeEntry>()

export function treeEntry(slug: string): TreeEntry {
  let e = entries.get(slug)
  if (!e) {
    e = new TreeEntry(slug)
    entries.set(slug, e)
  }
  return e
}

export function resetTrees() {
  entries.clear()
}

const inflight = new Map<string, Promise<TreeEntry>>()

export function loadTree(slug: string, opts: { force?: boolean } = {}): Promise<TreeEntry> {
  const running = inflight.get(slug)
  if (running && !opts.force) return running
  const p = doLoad(slug, opts).finally(() => inflight.delete(slug))
  inflight.set(slug, p)
  return p
}

async function doLoad(slug: string, opts: { force?: boolean }): Promise<TreeEntry> {
  const e = treeEntry(slug)
  if (!e.tree && !e.cacheChecked) {
    e.cacheChecked = true
    const cached = await kvGet<{ tree: Tree; etag: string | null }>(cacheKey.tree(slug))
    if (cached && !e.tree) {
      e.tree = cached.tree
      e.etag = cached.etag
      e.stale = true
    }
  }
  e.loading = true
  try {
    const header = e.etag && e.tree && !opts.force ? { 'If-None-Match': e.etag } : {}
    const r = await client.GET('/api/v1/libraries/{slug}/tree', { params: { path: { slug }, header } })
    if (r.response.status === 304) {
      e.stale = false
      e.error = null
      return e
    }
    if (!r.response.ok) throw await errorFromResponse(r.response, r.error)
    e.tree = r.data!
    e.etag = r.response.headers.get('ETag')
    e.stale = false
    e.error = null
    void kvSet(cacheKey.tree(slug), { tree: r.data, etag: e.etag })
  } catch (err) {
    if (err instanceof NetworkError || err instanceof AccessExpiredError) e.stale = !!e.tree
    if (!(err instanceof NetworkError) || !e.tree) e.error = errorText(err)
  } finally {
    e.loading = false
  }
  return e
}

/** 后台把所有库的树预取进 IndexedDB，离线时可浏览任意库 */
export async function prefetchAllTrees() {
  for (const l of app.libraries) {
    if (!app.online) return
    await loadTree(l.slug)
  }
}
