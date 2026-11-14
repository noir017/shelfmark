// Generates XBEL fixtures the way Floccus does (fast-xml-parser 5.11.2, same options).
// Serializer and parser logic are copied from floccus develop:
//   src/lib/adapters/WebDav.ts (createXBEL), src/lib/serializers/Xbel.ts, src/lib/serializers/DerivedIds.ts
// Run: npm install && node gen.mjs
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ---- serializer (Xbel.ts _serializeFolder + WebDav.ts createXBEL) ----
function serializeFolder(children) {
  return children.map(child => {
    if (child.type === 'bookmark') {
      return { bookmark: [{ title: [{ '#text': child.title }] }], ':@': { '@_href': child.url, '@_id': String(child.id) } }
    }
    return { folder: [{ title: [{ '#text': child.title }] }, ...serializeFolder(child.children)], ':@': { '@_id': String(child.id) } }
  })
}

function createXBEL(children, highestId) {
  const builder = new XMLBuilder({ format: true, preserveOrder: true, ignoreAttributes: false })
  let output = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">
<xbel version="1.0">
`
  output += '<!--- highestId :' + highestId + `: for Floccus bookmark sync browser extension -->
`
  output += builder.build(serializeFolder(children))
  output += `
</xbel>`
  return output
}

// ---- parser (Xbel.ts deserializeFile + DerivedIds.ts) ----
function hash(str) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const result = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return result || 1
}

const hasId = item => item.id !== undefined && item.id !== null && item.id !== '' && !Number.isNaN(item.id)

function collectIds(folder, used) {
  for (const child of folder.children) {
    if (hasId(child)) used.add(String(child.id))
    if (child.type === 'folder') collectIds(child, used)
  }
}

function assignDerivedIds(root) {
  const used = new Set()
  collectIds(root, used)
  const stats = { explicit: used.size, derived: 0 }
  const occurrences = new Map()
  const assign = folder => {
    for (const child of folder.children) {
      child.parentId = folder.id
      if (!hasId(child)) {
        const key = child.type === 'bookmark'
          ? 'bookmark\u0000' + child.url
          : 'folder\u0000' + String(folder.id) + '\u0000' + child.title
        const occurrence = occurrences.get(key) || 0
        occurrences.set(key, occurrence + 1)
        let id = -hash(key + '\u0000' + occurrence)
        while (used.has(String(id))) {
          id = id === -Number.MAX_SAFE_INTEGER ? -1 : id - 1
        }
        used.add(String(id))
        child.id = id
        stats.derived++
      }
      if (child.type === 'folder') assign(child)
    }
  }
  assign(root)
  return stats
}

function parseFolder(nodes, folder) {
  nodes.forEach(node => {
    let item
    if (typeof node.bookmark !== 'undefined') {
      item = {
        type: 'bookmark',
        id: parseInt(node[':@']?.['@_id']),
        url: node[':@']['@_href'],
        title: '' + (typeof node.bookmark?.[0]?.title?.[0]?.['#text'] !== 'undefined' ? node.bookmark?.[0]?.title?.[0]?.['#text'] : ''),
      }
    } else if (typeof node.folder !== 'undefined') {
      item = {
        type: 'folder',
        id: parseInt(node[':@']?.['@_id']),
        title: '' + (typeof node.folder?.[0]?.title?.[0]?.['#text'] !== 'undefined' ? node.folder?.[0]?.title?.[0]?.['#text'] : ''),
        children: [],
      }
      parseFolder(node.folder, item)
    } else {
      return
    }
    folder.children.push(item)
  })
}

function parseXBEL(xbel) {
  const parser = new XMLParser({
    preserveOrder: true,
    ignorePiTags: true,
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: { maxTotalExpansions: Infinity, maxEntityCount: Infinity },
  })
  const xmlObj = parser.parse(xbel)
  const root = { type: 'folder', id: 0, title: 'root', children: [] }
  parseFolder(xmlObj[0].xbel, root)
  const stats = assignDerivedIds(root)
  let highestId = null
  for (const line of xbel.split('\n')) {
    if (line.indexOf('<!--- highestId :') >= 0) {
      highestId = parseInt(line.substring(line.indexOf(':') + 1, line.lastIndexOf(':')))
      break
    }
  }
  const strip = items => items.map(it => it.type === 'bookmark'
    ? { type: 'bookmark', id: it.id, url: it.url ?? null, title: it.title }
    : { type: 'folder', id: it.id, title: it.title, children: strip(it.children) })
  return {
    highestId: Number.isNaN(highestId) ? null : highestId,
    persistIds: stats.derived > 0 && stats.explicit > 0,
    children: strip(root.children),
  }
}

// ---- fixtures ----
const bm = (id, url, title) => ({ type: 'bookmark', id, url, title })
const fo = (id, title, children = []) => ({ type: 'folder', id, title, children })

function bigTree() {
  // deterministic pseudo-random tree
  let seed = 42
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  let id = 0
  const words = ['工具', 'Docs', 'news & media', 'a<b>', '"quoted"', "it's", 'Ünïcödé', '日本語', 'emoji 🎉', 'tab\there']
  const build = depth => {
    const out = []
    const n = 3 + rnd(6)
    for (let i = 0; i < n; i++) {
      if (depth < 4 && rnd(4) === 0) {
        out.push(fo(++id, words[rnd(words.length)] + ' ' + id, build(depth + 1)))
      } else {
        out.push(bm(++id, `https://example.com/${id}?q=${rnd(1000)}&lang=zh#frag`, words[rnd(words.length)] + ' ' + id))
      }
    }
    return out
  }
  const children = build(0)
  return { children, highestId: id + 7 }
}

const roundtrip = {
  empty: { highestId: 0, children: [] },
  basic: {
    highestId: 42,
    children: [
      bm(1, 'https://example.com/', 'Example'),
      fo(2, '工具', [bm(3, 'https://example.org/', 'Org')]),
    ],
  },
  escaping: {
    highestId: 9,
    children: [
      bm(1, 'https://example.com/?a=1&b=2', 'A & B <c> "q" \'s\''),
      fo(2, '', []),
      bm(3, 'https://example.com/a"b<c>&amp;', 'already &amp; escaped'),
      fo(4, 'nested', [fo(5, 'deeper', [fo(6, 'deepest', [bm(7, 'javascript:alert(1)', 'bookmarklet')])])]),
      bm(8, 'https://example.com/empty-title', ''),
      bm(9, 'https://example.com/multi', 'line one\nline two'),
    ],
  },
  negative_ids: {
    highestId: 3,
    children: [
      bm(-3846318462231, 'https://example.com/derived', 'derived id'),
      fo(-77, 'derived folder', [bm(3, 'https://example.net/', 'Net')]),
    ],
  },
  big: bigTree(),
}

const parseCases = {
  // written by another program: no ids at all, duplicates, emoji (UTF-16 surrogates in the hash)
  no_ids: `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0">
  <bookmark href="https://example.com/"><title>Example</title></bookmark>
  <bookmark href="https://example.com/"><title>Example again</title></bookmark>
  <folder><title>Folder 🎉</title>
    <bookmark href="https://example.org/x"><title>X</title></bookmark>
    <folder><title>Sub</title></folder>
    <folder><title>Sub</title></folder>
  </folder>
  <folder><title>Folder 🎉</title></folder>
</xbel>`,
  // floccus file edited by hand: some ids missing -> persistIds
  mixed_ids: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" "http://pyxml.sourceforge.net/topics/dtds/xbel.dtd">
<xbel version="1.0">
<!--- highestId :12: for Floccus bookmark sync browser extension -->

<bookmark href="https://example.com/" id="1">
  <title>Has id</title>
</bookmark>
<folder id="2">
  <title>Folder</title>
  <bookmark href="https://example.com/new">
    <title>No id</title>
  </bookmark>
  <folder>
    <title>New folder</title>
    <bookmark href="https://example.com/deep" id="7">
      <title>Deep</title>
    </bookmark>
  </folder>
</folder>
</xbel>`,
  // parser quirks: trimming, entities, title must be the first child, ignored elements
  quirks: `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0">
<!--- highestId : 5 : for Floccus bookmark sync browser extension -->
<bookmark href="  https://example.com/a?x=1&amp;y=2  " id=" 1 "><title>  padded &lt;title&gt;  </title></bookmark>
<folder id="2"><desc>description first</desc><title>ignored title</title>
  <separator/>
  <bookmark href="https://example.com/b" id="3"><info><metadata owner="x"/></info><title>after info</title></bookmark>
  <bookmark href="https://example.com/c" id="4"/>
</folder>
<alias ref="1"/>
<bookmark href="https://example.com/d" id="5x"><title>trailing junk id</title></bookmark>
</xbel>`,
}

mkdirSync(join(here, 'roundtrip'), { recursive: true })
mkdirSync(join(here, 'parse'), { recursive: true })
for (const [name, tree] of Object.entries(roundtrip)) {
  const xbel = createXBEL(tree.children, tree.highestId)
  writeFileSync(join(here, 'roundtrip', name + '.xbel'), xbel)
  const parsed = parseXBEL(xbel)
  writeFileSync(join(here, 'roundtrip', name + '.json'), JSON.stringify(parsed, null, 2) + '\n')
}
for (const [name, xbel] of Object.entries(parseCases)) {
  writeFileSync(join(here, 'parse', name + '.xbel'), xbel)
  writeFileSync(join(here, 'parse', name + '.json'), JSON.stringify(parseXBEL(xbel), null, 2) + '\n')
}

// collision: give another item the id the first id-less bookmark would derive
{
  const derived = parseXBEL(parseCases.no_ids).children[0].id
  const xbel = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0">
<bookmark href="https://example.com/"><title>Example</title></bookmark>
<bookmark href="https://example.net/" id="${derived}"><title>Taken</title></bookmark>
</xbel>`
  writeFileSync(join(here, 'parse', 'collision.xbel'), xbel)
  writeFileSync(join(here, 'parse', 'collision.json'), JSON.stringify(parseXBEL(xbel), null, 2) + '\n')
}
console.log('ok')
