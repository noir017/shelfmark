// 单元测试辅助：把 API 客户端接到内存假后端（带最简 Cookie 罐）
import { createApi, type ApiOptions } from '../../src/api/client'
import { createMockServer } from '../../mock/server'
import { DEMO_PASSWORD, DEMO_USER, type Scenario } from '../../mock/seed'

export const ORIGIN = 'http://shelfmark.test'

export function setup(scenario: Scenario = 'seeded', opts: ApiOptions = {}) {
  const mock = createMockServer(scenario)
  const jar = new Map<string, string>()
  const calls: Request[] = []
  const mockFetch = async (req: Request): Promise<Response> => {
    const headers = new Headers(req.headers)
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const r = new Request(req, { headers })
    calls.push(r.clone())
    const out = await mock.handle(r)
    if (out.kind === 'drop' || out.kind === 'pass') throw new TypeError('fetch failed')
    for (const c of out.response.headers.getSetCookie()) {
      const [kv] = c.split(';')
      const [k, v] = kv.split('=')
      if (/Max-Age=0/i.test(c) || v === '') jar.delete(k)
      else jar.set(k, v)
    }
    return out.response
  }
  const api = createApi({ baseUrl: ORIGIN, fetch: mockFetch, lockDelayMs: () => 5, ...opts })
  const control = async (path: string, body: unknown = {}) => {
    const r = await mock.handle(new Request(ORIGIN + '/__mock/' + path, { method: 'POST', body: JSON.stringify(body) }))
    return r.kind === 'response' ? r.response : null
  }
  const login = async () => {
    const r = await api.client.POST('/api/v1/auth/login', { body: { username: DEMO_USER, password: DEMO_PASSWORD } })
    if (!r.response.ok) throw new Error('login failed')
    return r.data!
  }
  return { mock, api, client: api.client, jar, calls, control, login, mockFetch }
}
