// Vite 插件：开发和预览时默认挂内存假后端；设 SHELFMARK_PROXY 则代理到真实服务端
//   SHELFMARK_PROXY=1                     → http://localhost:8080
//   SHELFMARK_PROXY=http://host:port      → 指定地址
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const PROXIED = ['/api', '/dav', '/downloads', '/healthz']

export function proxyTarget(): string | null {
  const v = process.env.SHELFMARK_PROXY
  if (!v || v === '0' || v === 'false') return null
  return /^https?:\/\//.test(v) ? v : 'http://localhost:8080'
}

type Next = (err?: unknown) => void

async function createMiddleware() {
  const { createMockServer } = await import('./server.ts')
  const mock = createMockServer()
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    try {
      const host = req.headers.host ?? 'localhost'
      const url = `http://${host}${req.url}`
      const method = req.method ?? 'GET'
      const chunks: Buffer[] = []
      if (method !== 'GET' && method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k.startsWith(':')) continue
        headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      }
      const request = new Request(url, { method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
      const r = await mock.handle(request)
      if (r.kind === 'pass') return next()
      if (r.kind === 'drop') {
        req.socket.destroy()
        return
      }
      const out = r.response
      const h: Record<string, string | string[]> = {}
      out.headers.forEach((v, k) => {
        if (k !== 'set-cookie') h[k] = v
      })
      const cookies = out.headers.getSetCookie()
      if (cookies.length) h['set-cookie'] = cookies
      res.writeHead(out.status, h)
      if (method === 'HEAD' || out.body === null) return res.end()
      res.end(Buffer.from(await out.arrayBuffer()))
    } catch (e) {
      next(e)
    }
  }
}

export function backend(): Plugin {
  const target = proxyTarget()
  return {
    name: 'shelfmark-backend',
    config() {
      if (!target) return
      // changeOrigin 保持 false：Host 不变，服务端的 Origin 同源校验才能通过
      const proxy = Object.fromEntries(PROXIED.map((p) => [p, { target, changeOrigin: false }]))
      return { server: { proxy }, preview: { proxy } }
    },
    async configureServer(server) {
      if (!target) server.middlewares.use(await createMiddleware())
    },
    async configurePreviewServer(server) {
      if (!target) server.middlewares.use(await createMiddleware())
    },
  }
}
