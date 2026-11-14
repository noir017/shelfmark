// 构建期插件：生成 Service Worker（注入预缓存清单和版本号），并检查首屏 JS 体积
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import type { Plugin, Rolldown } from 'vite'

type OutputBundle = Rolldown.OutputBundle
type OutputChunk = Rolldown.OutputChunk

const BUDGET_KB = 150

function walk(dir: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function firstScreenJs(bundle: OutputBundle): { files: string[]; gzip: number } {
  const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === 'chunk')
  const byName = new Map(chunks.map((c) => [c.fileName, c]))
  const seen = new Set<string>()
  const visit = (c: OutputChunk | undefined) => {
    if (!c || seen.has(c.fileName)) return
    seen.add(c.fileName)
    for (const i of c.imports) visit(byName.get(i))
  }
  for (const c of chunks) if (c.isEntry) visit(c)
  // 起始页是首屏路由，一起算
  for (const c of chunks) if (c.facadeModuleId?.endsWith('/pages/StartPage.svelte')) visit(c)
  let gzip = 0
  for (const f of seen) gzip += gzipSync(byName.get(f)!.code, { level: 9 }).length
  return { files: [...seen], gzip }
}

export function serviceWorker(opts: { root: string; publicDir: string }): Plugin {
  return {
    name: 'shelfmark-sw',
    apply: 'build',
    generateBundle(_o, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js')
      const pub = walk(opts.publicDir).map((p) => relative(opts.publicDir, p).split('\\').join('/'))
      const precache = [...new Set([...built, ...pub])].filter((f) => f !== 'index.html').map((f) => '/' + f)
      const h = createHash('sha256')
      for (const f of built.sort()) {
        const a = bundle[f]
        h.update(f)
        h.update(a.type === 'chunk' ? a.code : typeof a.source === 'string' ? a.source : Buffer.from(a.source))
      }
      const version = h.digest('hex').slice(0, 12)
      const src = readFileSync(join(opts.root, 'src/sw.ts'), 'utf8')
      const js = ts
        .transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true } })
        .outputText.replace(/^export \{\};?\s*$/m, '')
        .replace('sw.__SW_VERSION__', JSON.stringify(version))
        .replace('sw.__PRECACHE__', JSON.stringify(precache))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: js })

      const fs = firstScreenJs(bundle)
      const kb = fs.gzip / 1024
      this.info?.(`首屏 JS gzip ${kb.toFixed(1)} KB（${fs.files.length} 个文件，上限 ${BUDGET_KB} KB）`)
      console.log(`\n[shelfmark] first-screen JS gzip: ${kb.toFixed(1)} KB (${fs.files.join(', ')})`)
      if (kb > BUDGET_KB) this.error(`首屏 JS gzip ${kb.toFixed(1)} KB 超过 ${BUDGET_KB} KB`)
    },
  }
}
