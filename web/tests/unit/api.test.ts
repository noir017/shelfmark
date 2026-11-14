import { describe, expect, it, vi } from 'vitest'
import { AccessExpiredError, ApiError, NetworkError, isGatewayResponse, unwrap } from '../../src/api/client'
import { ORIGIN, setup } from './helpers'

describe('API 封装', () => {
  it('登录后用 Cookie 会话访问，写请求自动带 X-Requested-With', async () => {
    const t = setup()
    const me = await t.login()
    expect(me.user.username).toBe('alice')
    expect(t.jar.has('shelfmark_session')).toBe(true)
    const libs = await unwrap(t.client.GET('/api/v1/libraries'))
    expect(libs.map((l) => l.slug)).toEqual(['bookmarks', 'work'])
    const created = await unwrap(
      t.client.POST('/api/v1/libraries/{slug}/items', {
        params: { path: { slug: 'bookmarks' } },
        body: { type: 'bookmark', title: 'Example', url: 'https://example.net/' },
      }),
    )
    expect(created.item.id).toBeGreaterThan(0)
    const post = t.calls.find((c) => c.method === 'POST' && c.url.endsWith('/items'))!
    expect(post.headers.get('x-requested-with')).toBe('shelfmark')
    const get = t.calls.find((c) => c.method === 'GET')!
    expect(get.headers.get('x-requested-with')).toBeNull()
  })

  it('不带 X-Requested-With 的 Cookie 写请求被假后端拒绝（CSRF）', async () => {
    const t = setup()
    await t.login()
    const res = await t.mockFetch(new Request(ORIGIN + '/api/v1/libraries', { method: 'POST', body: '{"slug":"x","name":"x"}' }))
    expect(res.status).toBe(403)
  })

  it('错误统一转成 ApiError', async () => {
    const t = setup()
    await t.login()
    const p = unwrap(t.client.GET('/api/v1/libraries/{slug}', { params: { path: { slug: 'nope' } } }))
    await expect(p).rejects.toBeInstanceOf(ApiError)
    await expect(p).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('401 触发 onUnauthorized，但登录接口自身的 401 不触发', async () => {
    const onUnauthorized = vi.fn()
    const t = setup('seeded', { onUnauthorized })
    await t.client.GET('/api/v1/libraries')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    await t.client.POST('/api/v1/auth/login', { body: { username: 'alice', password: 'wrong-password' } })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('423 按 Retry-After 自动重试，锁释放后成功', async () => {
    const onLocked = vi.fn()
    const t = setup('seeded', { onLocked, lockDelayMs: () => 30 })
    await t.login()
    await t.control('lock', { library: 'bookmarks', durationMs: 50, actor: 'Floccus · 笔记本' })
    const r = await unwrap(
      t.client.POST('/api/v1/libraries/{slug}/items', { params: { path: { slug: 'bookmarks' } }, body: { type: 'folder', title: '新文件夹' } }),
    )
    expect(r.item.title).toBe('新文件夹')
    expect(onLocked).toHaveBeenCalled()
    expect(onLocked.mock.calls[0][0]).toMatchObject({ actor: 'Floccus · 笔记本', attempt: 1, maxAttempts: 3 })
  })

  it('423 重试 3 次仍被锁则返回 locked 错误', async () => {
    const onLocked = vi.fn()
    const t = setup('seeded', { onLocked })
    await t.login()
    await t.control('lock', { library: 'bookmarks', durationMs: 60_000 })
    const p = unwrap(t.client.DELETE('/api/v1/libraries/{slug}/items/{itemId}', { params: { path: { slug: 'bookmarks', itemId: 1 } } }))
    await expect(p).rejects.toMatchObject({ status: 423, code: 'locked' })
    expect(onLocked).toHaveBeenCalledTimes(3)
    const deletes = t.calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(4)
  })

  it('网络错误抛 NetworkError', async () => {
    const onNetworkError = vi.fn()
    const t = setup('seeded', { onNetworkError })
    await t.login()
    await t.control('config', { offline: true })
    await expect(t.client.GET('/api/v1/libraries')).rejects.toBeInstanceOf(NetworkError)
    expect(onNetworkError).toHaveBeenCalled()
  })

  it('请求被跳到 Access 登录页时抛 AccessExpiredError', async () => {
    const onAccessExpired = vi.fn()
    const t = setup('seeded', { onAccessExpired })
    await t.login()
    await t.control('config', { accessExpired: true })
    await expect(t.client.GET('/api/v1/libraries')).rejects.toBeInstanceOf(AccessExpiredError)
    expect(onAccessExpired).toHaveBeenCalledTimes(1)
  })

  it('fetch 报网络错误但探测到跳转时，判定为 Access 过期而不是断网', async () => {
    const onAccessExpired = vi.fn()
    const onNetworkError = vi.fn()
    // 模拟浏览器：跟随跨域跳转被 CORS 拦下 → TypeError；manual 模式探测则拿到跳转
    const t2 = setup('seeded', {
      onAccessExpired,
      onNetworkError,
      fetch: async (req) => {
        if (req.redirect === 'manual' && req.url.endsWith('/api/v1/system/info')) return new Response(null, { status: 302, headers: { Location: 'https://example.cloudflareaccess.com/' } })
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(t2.client.GET('/api/v1/settings')).rejects.toBeInstanceOf(AccessExpiredError)
    expect(onAccessExpired).toHaveBeenCalled()
    expect(onNetworkError).not.toHaveBeenCalled()
  })

  it('识别网关响应：跳转、opaqueredirect、API 返回 HTML', () => {
    expect(isGatewayResponse(new Response(null, { status: 302 }))).toBe(true)
    expect(isGatewayResponse(new Response('<html>', { headers: { 'content-type': 'text/html' } }))).toBe(true)
    expect(isGatewayResponse(new Response('{}', { headers: { 'content-type': 'application/json' } }))).toBe(false)
    expect(isGatewayResponse(new Response(null, { status: 304 }))).toBe(false)
  })

  it('Access 单点登录：启用且有映射时直接建立会话', async () => {
    const t = setup()
    await t.control('config', { cfAccessSso: true, accessUser: 'alice' })
    const info = await unwrap(t.client.GET('/api/v1/system/info'))
    expect(info.features.cfAccessSso).toBe(true)
    const me = await unwrap(t.client.POST('/api/v1/auth/access'))
    expect(me.authMethod).toBe('access')
    expect((await unwrap(t.client.GET('/api/v1/auth/me'))).user.username).toBe('alice')
  })

  it('树接口支持 ETag / 304', async () => {
    const t = setup()
    await t.login()
    const r1 = await t.client.GET('/api/v1/libraries/{slug}/tree', { params: { path: { slug: 'bookmarks' } } })
    const etag = r1.response.headers.get('etag')!
    expect(etag).toMatch(/^"r\d+/)
    const r2 = await t.client.GET('/api/v1/libraries/{slug}/tree', { params: { path: { slug: 'bookmarks' }, header: { 'If-None-Match': etag } } })
    expect(r2.response.status).toBe(304)
  })
})
