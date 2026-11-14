// API 封装：openapi-fetch + 统一的 fetch 包装
// - 写请求带 X-Requested-With: shelfmark（Cookie 会话的 CSRF 要求）
// - 423（库被 Floccus 锁定）按 Retry-After 自动重试 3 次，每次通知界面
// - redirect: 'manual'：API 从不跳转，出现跳转或 HTML 响应即视为被 Cloudflare Access 等网关拦截（会话过期）
// - 真正的网络错误抛 NetworkError，调用方据此走离线逻辑
import createClient, { type Client } from 'openapi-fetch'
import type { ErrorCode, paths } from './types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode | 'unknown',
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 网络不可达（断网、服务端没起来） */
export class NetworkError extends Error {
  constructor(message = 'network error') {
    super(message)
    this.name = 'NetworkError'
  }
}

/** 请求被网关（Cloudflare Access）重定向到登录页，需要整页刷新重新登录 */
export class AccessExpiredError extends Error {
  constructor() {
    super('access session expired')
    this.name = 'AccessExpiredError'
  }
}

export interface LockNotice {
  actor: string | null
  since: string | null
  attempt: number
  maxAttempts: number
  retryAfterMs: number
}

export interface ApiHooks {
  onLocked?: (n: LockNotice) => void
  onUnauthorized?: () => void
  onAccessExpired?: () => void
  onNetworkError?: () => void
  onReachable?: () => void
}

export interface ApiOptions extends ApiHooks {
  baseUrl?: string
  fetch?: (req: Request) => Promise<Response>
  lockRetries?: number
  /** 根据 Retry-After（秒）算等待毫秒数，测试可缩短 */
  lockDelayMs?: (retryAfterSec: number, attempt: number) => number
}

const isWrite = (m: string) => m !== 'GET' && m !== 'HEAD'

export function isGatewayResponse(res: Response): boolean {
  if (res.type === 'opaqueredirect') return true
  if (res.status >= 300 && res.status < 400 && res.status !== 304) return true
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('text/html')) {
    // 导出接口可能合法地返回 HTML，其余 API 只返回 JSON / 纯文本 / 图片
    let path = ''
    try {
      path = new URL(res.url).pathname
    } catch {
      /* 构造出来的 Response 没有 url */
    }
    return !path.endsWith('/export')
  }
  return false
}

export async function errorFromResponse(res: Response, body?: unknown): Promise<ApiError> {
  let b = body
  if (b === undefined) {
    try {
      b = await res.clone().json()
    } catch {
      b = undefined
    }
  }
  const e = (b as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error
  return new ApiError(res.status, (e?.code as ErrorCode) ?? 'unknown', e?.message ?? res.statusText ?? `HTTP ${res.status}`, e?.details)
}

export interface Api {
  client: Client<paths>
  /** 包装后的 fetch（multipart 等 openapi-fetch 不方便的场景用） */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  hooks: ApiHooks
}

export function createApi(opts: ApiOptions = {}): Api {
  const baseUrl = opts.baseUrl ?? ''
  const baseFetch = opts.fetch ?? ((r: Request) => globalThis.fetch(r))
  const lockRetries = opts.lockRetries ?? 3
  const lockDelayMs = opts.lockDelayMs ?? ((sec) => Math.min(Math.max(sec, 1), 10) * 1000)
  const hooks: ApiHooks = {
    onLocked: opts.onLocked,
    onUnauthorized: opts.onUnauthorized,
    onAccessExpired: opts.onAccessExpired,
    onNetworkError: opts.onNetworkError,
    onReachable: opts.onReachable,
  }

  const absolute = (path: string) => new URL(path, baseUrl || globalThis.location?.origin || 'http://localhost').href

  /** 网络错误时再探一次：用 manual 跳转请求系统信息，拿到跳转/HTML 说明是网关拦截而不是断网 */
  async function probeGateway(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
    try {
      const res = await baseFetch(new Request(absolute('/api/v1/system/info'), { redirect: 'manual', cache: 'no-store' }))
      return isGatewayResponse(res)
    } catch {
      return false
    }
  }

  async function smFetch(input: Request): Promise<Response> {
    const req = new Request(input, { redirect: 'manual' })
    if (isWrite(req.method) && !req.headers.has('X-Requested-With')) req.headers.set('X-Requested-With', 'shelfmark')
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await baseFetch(req.clone())
      } catch {
        if (await probeGateway()) {
          hooks.onAccessExpired?.()
          throw new AccessExpiredError()
        }
        hooks.onNetworkError?.()
        throw new NetworkError()
      }
      if (isGatewayResponse(res)) {
        hooks.onAccessExpired?.()
        throw new AccessExpiredError()
      }
      hooks.onReachable?.()
      if (res.status === 423 && attempt < lockRetries) {
        const sec = Number(res.headers.get('Retry-After') ?? '5') || 5
        const err = await errorFromResponse(res)
        const delay = lockDelayMs(sec, attempt + 1)
        hooks.onLocked?.({
          actor: (err.details?.actor as string) ?? null,
          since: (err.details?.since as string) ?? null,
          attempt: attempt + 1,
          maxAttempts: lockRetries,
          retryAfterMs: delay,
        })
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      if (res.status === 401) hooks.onUnauthorized?.()
      return res
    }
  }

  const client = createClient<paths>({ baseUrl, fetch: smFetch, redirect: 'manual' })
  const wrappedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(typeof input === 'string' ? absolute(input) : input, init)
    return smFetch(req)
  }
  return { client, fetch: wrappedFetch, hooks }
}

type Result<T> = { data?: T; error?: unknown; response: Response }

/** 把 openapi-fetch 的返回变成“成功给数据，失败抛 ApiError” */
export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p
  if (r.response.ok) return r.data as T
  throw await errorFromResponse(r.response, r.error === '' ? undefined : r.error)
}
