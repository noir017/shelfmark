// URL 工具：规范化（与服务端 normalized_url 规则一致）、从文本提取、判断输入是否像网址

const TRACKING = /^(utm_.*|fbclid|gclid|mc_eid|spm)$/i
const DEFAULT_PORT: Record<string, string> = { 'http:': '80', 'https:': '443' }

export function normalizeUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return raw.trim()
  }
  if (u.port && DEFAULT_PORT[u.protocol] === u.port) u.port = ''
  u.hash = ''
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k))
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
  const search = new URLSearchParams(params).toString()
  let path = u.pathname
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  // URL 已把 scheme、host 转为小写
  const auth = u.username ? `${u.username}${u.password ? ':' + u.password : ''}@` : ''
  const special = u.protocol === 'http:' || u.protocol === 'https:'
  if (!special) return u.href.replace(/#.*$/, '')
  return `${u.protocol}//${auth}${u.host}${path}${search ? '?' + search : ''}`
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/i

/** PWA 分享时 URL 可能在 text 里（如“标题 https://…”），取第一个 http(s) 链接，去掉末尾标点 */
export function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(URL_IN_TEXT)
  if (!m) return null
  return m[0].replace(/[),.;:!?，。；：！？）】」』]+$/u, '')
}

/** 起始页搜索框：输入像网址时返回可打开的 URL，否则 null */
export function looksLikeUrl(input: string): string | null {
  const s = input.trim()
  if (!s || /\s/.test(s)) return null
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).href
    } catch {
      return null
    }
  }
  // localhost:3000、192.168.1.1、example.com/path
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s
  if (/^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s
  return null
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
