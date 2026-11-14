import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../../src/lib/i18n/en'
import zh from '../../src/lib/i18n/zh-CN'

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

function sources(dir: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(ts|svelte)$/.test(f) && !p.includes('i18n')) out.push(p)
  }
  return out
}

describe('i18n 字典', () => {
  it('中英文键完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('没有空值，占位符一致', () => {
    for (const k of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(zh[k].trim(), k).not.toBe('')
      expect(en[k].trim(), k).not.toBe('')
      expect(placeholders(en[k]), k).toEqual(placeholders(zh[k]))
    }
  })

  it('源码里 t() 用到的键都存在（含模板拼接的前缀）', () => {
    const keys = new Set(Object.keys(zh))
    const missing: string[] = []
    for (const file of sources(join(__dirname, '../../src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([\w.]+)'/g)) if (!keys.has(m[1])) missing.push(`${file}: ${m[1]}`)
      for (const m of text.matchAll(/\bt\(\s*`([\w.]+)\$\{/g)) {
        if (![...keys].some((k) => k.startsWith(m[1]))) missing.push(`${file}: ${m[1]}*`)
      }
    }
    expect(missing).toEqual([])
  })

  it('枚举类键齐全（健康状态、修订来源、任务名）', () => {
    for (const s of ['ok', 'redirect', 'broken', 'unreachable', 'skipped', 'unknown']) expect(zh).toHaveProperty(`health.${s}`)
    for (const s of ['webdav', 'web', 'api', 'extension', 'import', 'restore', 'system']) expect(zh).toHaveProperty(`source.${s}`)
    for (const s of ['linkcheck', 'metadata', 'retention', 'cleanup', 'backup']) expect(zh).toHaveProperty(`jobs.${s}`)
  })
})
