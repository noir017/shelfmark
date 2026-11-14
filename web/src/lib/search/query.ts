// 搜索语法（设计第 9 节）：普通词（AND）、"短语"、#标签、site:、in:、lib:、is:broken、is:duplicate、-排除
// 解析结果供离线本地搜索和假后端共用；在线时原样把 q 交给服务端。

export type IsFlag = 'broken' | 'duplicate'

export interface ParsedQuery {
  /** 普通词与短语（都要求出现），小写 */
  terms: string[]
  tags: string[]
  sites: string[]
  folders: string[]
  libs: string[]
  is: IsFlag[]
  exclude: { terms: string[]; tags: string[]; sites: string[]; folders: string[] }
}

function emptyQuery(): ParsedQuery {
  return { terms: [], tags: [], sites: [], folders: [], libs: [], is: [], exclude: { terms: [], tags: [], sites: [], folders: [] } }
}

/** 切词：支持引号，前缀（-、site: 等）可以和引号连用，如 -"foo bar"、in:"My Folder" */
export function tokenize(q: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++
    if (i >= q.length) break
    let tok = ''
    while (i < q.length && !/\s/.test(q[i])) {
      if (q[i] === '"') {
        const end = q.indexOf('"', i + 1)
        if (end === -1) {
          tok += q.slice(i + 1)
          i = q.length
        } else {
          tok += '\u0000' + q.slice(i + 1, end) + '\u0000'
          i = end + 1
        }
      } else {
        tok += q[i++]
      }
    }
    out.push(tok)
  }
  return out
}

const unquote = (s: string) => s.replace(/\u0000/g, '')

export function parseQuery(q: string): ParsedQuery {
  const r = emptyQuery()
  for (let tok of tokenize(q)) {
    let neg = false
    if (tok.length > 1 && tok.startsWith('-')) {
      neg = true
      tok = tok.slice(1)
    }
    const quotedWhole = tok.startsWith('\u0000')
    const m = quotedWhole ? null : tok.match(/^(site|in|lib|is):(.*)$/i)
    if (m) {
      const key = m[1].toLowerCase()
      const val = unquote(m[2]).trim().toLowerCase()
      if (!val) continue
      if (key === 'site') (neg ? r.exclude.sites : r.sites).push(val.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      else if (key === 'in') (neg ? r.exclude.folders : r.folders).push(val)
      else if (key === 'lib') {
        if (!neg) r.libs.push(val)
      } else if (key === 'is' && (val === 'broken' || val === 'duplicate')) {
        if (!neg && !r.is.includes(val)) r.is.push(val)
      }
      continue
    }
    if (!quotedWhole && tok.startsWith('#') && tok.length > 1) {
      ;(neg ? r.exclude.tags : r.tags).push(unquote(tok.slice(1)).toLowerCase())
      continue
    }
    const term = unquote(tok).trim().toLowerCase()
    if (term) (neg ? r.exclude.terms : r.terms).push(term)
  }
  return r
}

export function isEmptyQuery(p: ParsedQuery): boolean {
  return (
    !p.terms.length && !p.tags.length && !p.sites.length && !p.folders.length && !p.libs.length && !p.is.length &&
    !p.exclude.terms.length && !p.exclude.tags.length && !p.exclude.sites.length && !p.exclude.folders.length
  )
}

export interface Searchable {
  library: string
  title: string
  url: string | null
  notes: string | null
  tags: string[]
  path: string[]
  broken?: boolean
  duplicate?: boolean
}

function hostMatches(url: string | null, site: string): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === site || host.endsWith('.' + site)
}

function haystack(it: Searchable): string {
  return [it.title, it.url ?? '', it.notes ?? '', it.tags.join(' '), it.path.join(' ')].join('\n').toLowerCase()
}

export function matches(p: ParsedQuery, it: Searchable): boolean {
  if (p.libs.length && !p.libs.includes(it.library.toLowerCase())) return false
  if (p.is.includes('broken') && !it.broken) return false
  if (p.is.includes('duplicate') && !it.duplicate) return false
  const hay = haystack(it)
  for (const t of p.terms) if (!hay.includes(t)) return false
  for (const t of p.exclude.terms) if (hay.includes(t)) return false
  const tags = it.tags.map((t) => t.toLowerCase())
  for (const t of p.tags) if (!tags.includes(t)) return false
  for (const t of p.exclude.tags) if (tags.includes(t)) return false
  for (const s of p.sites) if (!hostMatches(it.url, s)) return false
  for (const s of p.exclude.sites) if (hostMatches(it.url, s)) return false
  const path = it.path.map((f) => f.toLowerCase())
  for (const f of p.folders) if (!path.some((x) => x.includes(f))) return false
  for (const f of p.exclude.folders) if (path.some((x) => x.includes(f))) return false
  return true
}

/** 排序分：标题命中优先，其次 URL、备注；再按访问次数加权 */
export function score(p: ParsedQuery, it: Searchable, visitCount = 0): number {
  const title = it.title.toLowerCase()
  const url = (it.url ?? '').toLowerCase()
  const notes = (it.notes ?? '').toLowerCase()
  let s = 0
  for (const t of p.terms) {
    if (title.includes(t)) s += title.startsWith(t) ? 12 : 8
    if (url.includes(t)) s += 3
    if (notes.includes(t)) s += 1
  }
  return s + Math.log2(1 + visitCount)
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 返回转义后的 HTML，命中的词包在 <mark> 里（与服务端 highlights 格式一致） */
export function highlight(text: string, terms: string[]): string {
  const ts = terms.filter(Boolean)
  if (!ts.length) return escapeHtml(text)
  const lower = text.toLowerCase()
  const marks: Array<[number, number]> = []
  for (const t of ts) {
    let i = lower.indexOf(t)
    while (i !== -1) {
      marks.push([i, i + t.length])
      i = lower.indexOf(t, i + t.length)
    }
  }
  if (!marks.length) return escapeHtml(text)
  marks.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const m of marks) {
    const last = merged[merged.length - 1]
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1])
    else merged.push([...m])
  }
  let out = ''
  let pos = 0
  for (const [a, b] of merged) {
    out += escapeHtml(text.slice(pos, a)) + '<mark>' + escapeHtml(text.slice(a, b)) + '</mark>'
    pos = b
  }
  return out + escapeHtml(text.slice(pos))
}
