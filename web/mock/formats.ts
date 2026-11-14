// 假后端的导入导出格式：Netscape HTML、XBEL、shelfmark JSON（够用即可，不追求完整）

export interface FNode {
  type: 'folder' | 'bookmark'
  title: string
  url?: string | null
  notes?: string | null
  tags?: string[]
  visitCount?: number
  children?: FNode[]
}

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const enc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? decode(m[1]) : null
}

export function detectFormat(text: string): 'html' | 'xbel' | 'json' | null {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  if (/<xbel[\s>]/i.test(t)) return 'xbel'
  if (/NETSCAPE-Bookmark-file|<DT>\s*<A\s/i.test(t)) return 'html'
  return null
}

export function parseHtml(text: string): FNode[] {
  const root: FNode[] = []
  const stack: FNode[][] = [root]
  let pendingFolder: FNode | null = null
  const re = /<DT>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A([^>]*)>([\s\S]*?)<\/A>|<DL[^>]*>|<\/DL>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const cur = stack[stack.length - 1]
    if (m[2] !== undefined) {
      pendingFolder = { type: 'folder', title: decode(m[2].trim()), children: [] }
      cur.push(pendingFolder)
    } else if (m[4] !== undefined) {
      const tags = attr(m[3], 'TAGS')
      cur.push({ type: 'bookmark', title: decode(m[4].trim()), url: attr(m[3], 'HREF'), tags: tags ? tags.split(',').map((x) => x.trim()).filter(Boolean) : [] })
    } else if (/^<DL/i.test(m[0])) {
      if (pendingFolder) {
        stack.push(pendingFolder.children!)
        pendingFolder = null
      } else if (stack.length > 1 || root.length) {
        // 顶层第一个 <DL> 就是根
      }
    } else if (stack.length > 1) {
      stack.pop()
    }
  }
  return root
}

export function parseXbel(text: string): FNode[] {
  const root: FNode[] = []
  const stack: FNode[][] = [root]
  const open: FNode[] = []
  const re = /<(\/?)(folder|bookmark|title)\b([^>]*)>|([^<]+)/gi
  let m: RegExpExecArray | null
  let inTitle = false
  while ((m = re.exec(text))) {
    if (m[4] !== undefined) {
      if (inTitle && open.length) open[open.length - 1].title += decode(m[4])
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const selfClosing = m[3].trim().endsWith('/')
    if (tag === 'title') {
      inTitle = !closing && !selfClosing
      continue
    }
    if (closing) {
      const n = open.pop()
      if (n?.type === 'folder') stack.pop()
      continue
    }
    const node: FNode = tag === 'folder' ? { type: 'folder', title: '', children: [] } : { type: 'bookmark', title: '', url: attr(m[3], 'href') }
    stack[stack.length - 1].push(node)
    if (selfClosing) continue
    open.push(node)
    if (tag === 'folder') stack.push(node.children!)
  }
  return root
}

export function parseJson(text: string): FNode[] {
  const data = JSON.parse(text)
  const conv = (x: Record<string, unknown>): FNode => ({
    type: x.type === 'folder' ? 'folder' : 'bookmark',
    title: String(x.title ?? ''),
    url: (x.url as string) ?? null,
    notes: (x.notes as string) ?? null,
    tags: Array.isArray(x.tags) ? (x.tags as string[]) : [],
    children: Array.isArray(x.children) ? (x.children as Record<string, unknown>[]).map(conv) : x.type === 'folder' ? [] : undefined,
  })
  if (Array.isArray(data)) return data.map(conv)
  if (Array.isArray(data.children)) return data.children.map(conv)
  if (Array.isArray(data.items)) {
    // 扁平快照格式 {items:[{id,parentId,position,...}]}
    const items = data.items as Array<Record<string, unknown>>
    const build = (pid: number): FNode[] =>
      items
        .filter((i) => Number(i.parentId) === pid)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((i) => ({ ...conv(i), children: i.type === 'folder' ? build(Number(i.id)) : undefined }))
    return build(0)
  }
  throw new Error('unrecognized json')
}

export function toHtml(nodes: FNode[], title = 'Bookmarks'): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${enc(title)}</TITLE>`,
    `<H1>${enc(title)}</H1>`,
    '<DL><p>',
  ]
  const walk = (ns: FNode[], ind: string) => {
    for (const n of ns) {
      if (n.type === 'folder') {
        lines.push(`${ind}<DT><H3>${enc(n.title)}</H3>`, `${ind}<DL><p>`)
        walk(n.children ?? [], ind + '    ')
        lines.push(`${ind}</DL><p>`)
      } else {
        const tags = n.tags?.length ? ` TAGS="${enc(n.tags.join(','))}"` : ''
        lines.push(`${ind}<DT><A HREF="${enc(n.url ?? '')}"${tags}>${enc(n.title)}</A>`)
      }
    }
  }
  walk(nodes, '    ')
  lines.push('</DL><p>')
  return lines.join('\n') + '\n'
}

export function toXbel(nodes: Array<FNode & { id?: number }>, highestId: number): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">',
    '<xbel version="1.0">',
    `<!--- highestId :${highestId}: for Floccus bookmark sync browser extension -->`,
  ]
  const walk = (ns: Array<FNode & { id?: number }>, ind: string) => {
    for (const n of ns) {
      const id = n.id !== undefined ? ` id="${n.id}"` : ''
      if (n.type === 'folder') {
        lines.push(`${ind}<folder${id}>`, `${ind}  <title>${enc(n.title)}</title>`)
        walk((n.children ?? []) as Array<FNode & { id?: number }>, ind + '  ')
        lines.push(`${ind}</folder>`)
      } else {
        lines.push(`${ind}<bookmark href="${enc(n.url ?? '')}"${id}>`, `${ind}  <title>${enc(n.title)}</title>`, `${ind}</bookmark>`)
      }
    }
  }
  walk(nodes, '')
  lines.push('</xbel>')
  return lines.join('\n')
}
