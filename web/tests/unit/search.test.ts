import { describe, expect, it } from 'vitest'
import { highlight, isEmptyQuery, matches, parseQuery, tokenize, type Searchable } from '../../src/lib/search/query'

const item = (over: Partial<Searchable> = {}): Searchable => ({
  library: 'bookmarks', title: 'Svelte 教程', url: 'https://svelte.dev/tutorial', notes: '入门好文', tags: ['dev', 'Docs'], path: ['常用', '前端'], ...over,
})

describe('搜索语法解析', () => {
  it('切词支持引号和带引号的前缀', () => {
    expect(tokenize('a "b c" in:"My Folder" -"x y"')).toEqual(['a', '\u0000b c\u0000', 'in:\u0000My Folder\u0000', '-\u0000x y\u0000'])
  })

  it('解析全部语法', () => {
    const p = parseQuery('Svelte "hello world" #Dev site:example.com in:前端 lib:Work is:broken is:duplicate -旧 -#tmp -site:bad.com -in:归档')
    expect(p.terms).toEqual(['svelte', 'hello world'])
    expect(p.tags).toEqual(['dev'])
    expect(p.sites).toEqual(['example.com'])
    expect(p.folders).toEqual(['前端'])
    expect(p.libs).toEqual(['work'])
    expect(p.is).toEqual(['broken', 'duplicate'])
    expect(p.exclude).toEqual({ terms: ['旧'], tags: ['tmp'], sites: ['bad.com'], folders: ['归档'] })
  })

  it('site: 去掉协议和路径；未知 is: 忽略；单独的 - 当普通词', () => {
    const p = parseQuery('site:https://Example.com/path is:weird -')
    expect(p.sites).toEqual(['example.com'])
    expect(p.is).toEqual([])
    expect(p.terms).toEqual(['-'])
  })

  it('引号内的 #、site: 不当语法', () => {
    const p = parseQuery('"#notatag" "site:foo"')
    expect(p.tags).toEqual([])
    expect(p.terms).toEqual(['#notatag', 'site:foo'])
  })

  it('空查询', () => {
    expect(isEmptyQuery(parseQuery('   '))).toBe(true)
    expect(isEmptyQuery(parseQuery('is:broken'))).toBe(false)
  })
})

describe('本地匹配', () => {
  it('普通词 AND，跨标题、URL、备注、标签、路径匹配，不区分大小写', () => {
    expect(matches(parseQuery('svelte 入门'), item())).toBe(true)
    expect(matches(parseQuery('svelte react'), item())).toBe(false)
    expect(matches(parseQuery('前端'), item())).toBe(true)
  })

  it('标签、站点（含子域名）、文件夹、库、排除', () => {
    expect(matches(parseQuery('#docs'), item())).toBe(true)
    expect(matches(parseQuery('#rust'), item())).toBe(false)
    expect(matches(parseQuery('site:svelte.dev'), item({ url: 'https://kit.svelte.dev/' }))).toBe(true)
    expect(matches(parseQuery('site:velte.dev'), item())).toBe(false)
    expect(matches(parseQuery('in:常用'), item())).toBe(true)
    expect(matches(parseQuery('-in:常用'), item())).toBe(false)
    expect(matches(parseQuery('lib:work'), item())).toBe(false)
    expect(matches(parseQuery('svelte -教程'), item())).toBe(false)
    expect(matches(parseQuery('-#dev'), item())).toBe(false)
  })

  it('is:broken / is:duplicate', () => {
    expect(matches(parseQuery('is:broken'), item())).toBe(false)
    expect(matches(parseQuery('is:broken'), item({ broken: true }))).toBe(true)
    expect(matches(parseQuery('is:duplicate svelte'), item({ duplicate: true }))).toBe(true)
  })
})

describe('高亮', () => {
  it('转义 HTML 并合并重叠命中', () => {
    expect(highlight('<b>Svelte</b> svelte', ['svelte', 'velte'])).toBe('&lt;b&gt;<mark>Svelte</mark>&lt;/b&gt; <mark>svelte</mark>')
  })
  it('无命中原样转义', () => {
    expect(highlight('a & b', ['zzz'])).toBe('a &amp; b')
  })
})
