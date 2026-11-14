import { describe, expect, it } from 'vitest'
import { extractUrl, looksLikeUrl, normalizeUrl } from '../../src/lib/url'

describe('URL 规范化', () => {
  it('小写 scheme/host、去默认端口、fragment、追踪参数，参数排序，去末尾斜杠', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/a/b/?z=1&utm_source=x&a=2&fbclid=y#top')).toBe('https://example.com/a/b?a=2&z=1')
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/')
    expect(normalizeUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x')
    expect(normalizeUrl('https://example.com/?spm=1&gclid=2&mc_eid=3')).toBe('https://example.com/')
  })
  it('非法 URL 原样返回', () => {
    expect(normalizeUrl(' not a url ')).toBe('not a url')
  })
})

describe('从分享文本提取 URL', () => {
  it('取第一个链接并去掉末尾标点', () => {
    expect(extractUrl('好文推荐 https://example.com/post?id=1。')).toBe('https://example.com/post?id=1')
    expect(extractUrl('Title\nhttps://example.org/a), more')).toBe('https://example.org/a')
    expect(extractUrl('没有链接')).toBeNull()
    expect(extractUrl(null)).toBeNull()
  })
})

describe('起始页输入是否像网址', () => {
  it('识别网址', () => {
    expect(looksLikeUrl('example.com')).toBe('https://example.com')
    expect(looksLikeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(looksLikeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(looksLikeUrl('192.168.1.1/admin')).toBe('http://192.168.1.1/admin')
  })
  it('普通搜索词不是网址', () => {
    expect(looksLikeUrl('svelte 教程')).toBeNull()
    expect(looksLikeUrl('#dev')).toBeNull()
    expect(looksLikeUrl('site:example.com')).toBeNull()
    expect(looksLikeUrl('hello')).toBeNull()
  })
})
