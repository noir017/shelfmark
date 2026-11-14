import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../src/api/client'
import type { QuickSaveRequest, QuickSaveResult } from '../../src/api/types'
import { _resetForTests, kvGet, kvSet } from '../../src/lib/offline/idb'
import { enqueueSave, flushQueue, listQueued } from '../../src/lib/offline/queue'
import { setup } from './helpers'

const result = (r: QuickSaveRequest): QuickSaveResult => ({
  existed: false, library: 'bookmarks', path: ['收件箱'], revision: 1,
  item: { id: 1, type: 'bookmark', parentId: 1, position: 0, title: r.title ?? '', url: r.url, createdAt: '', updatedAt: '', tags: [], visitCount: 0 },
})

beforeEach(async () => {
  await _resetForTests()
  indexedDB.deleteDatabase('shelfmark')
})

describe('IndexedDB 缓存', () => {
  it('kv 读写', async () => {
    await kvSet('tree:bookmarks', { a: 1 })
    expect(await kvGet('tree:bookmarks')).toEqual({ a: 1 })
    expect(await kvGet('none')).toBeUndefined()
  })
})

describe('离线收藏队列', () => {
  it('按入队顺序提交，成功后出队', async () => {
    await enqueueSave({ url: 'https://a.example.com/', title: 'A' })
    await enqueueSave({ url: 'https://b.example.com/', title: 'B' })
    expect((await listQueued()).map((e) => e.request.title)).toEqual(['A', 'B'])
    const sent: string[] = []
    const onOutcome = vi.fn()
    const s = await flushQueue(async (r) => (sent.push(r.title!), result(r)), onOutcome)
    expect(sent).toEqual(['A', 'B'])
    expect(s).toEqual({ sent: 2, failed: 0, remaining: 0, interrupted: false })
    expect(onOutcome).toHaveBeenCalledTimes(2)
    expect(await listQueued()).toEqual([])
  })

  it('网络错误时中断并保留剩余条目', async () => {
    await enqueueSave({ url: 'https://a.example.com/' })
    await enqueueSave({ url: 'https://b.example.com/' })
    let n = 0
    const s = await flushQueue(async (r) => {
      if (n++ === 1) throw new NetworkError()
      return result(r)
    })
    expect(s).toMatchObject({ sent: 1, interrupted: true, remaining: 1 })
    expect((await listQueued()).map((e) => e.request.url)).toEqual(['https://b.example.com/'])
  })

  it('4xx 错误出队并报告失败，423/5xx 保留', async () => {
    await enqueueSave({ url: 'bad' })
    await enqueueSave({ url: 'https://locked.example.com/' })
    const outcomes: boolean[] = []
    const s = await flushQueue(
      async (r) => {
        if (r.url === 'bad') throw new ApiError(422, 'validation', 'url 不合法')
        throw new ApiError(423, 'locked', 'locked')
      },
      (o) => outcomes.push(o.ok),
    )
    expect(outcomes).toEqual([false])
    expect(s).toMatchObject({ failed: 1, interrupted: true, remaining: 1 })
    expect((await listQueued()).map((e) => e.request.url)).toEqual(['https://locked.example.com/'])
  })

  it('并发调用只跑一次', async () => {
    await enqueueSave({ url: 'https://a.example.com/' })
    const send = vi.fn(async (r: QuickSaveRequest) => result(r))
    const [a, b] = await Promise.all([flushQueue(send), flushQueue(send)])
    expect(a).toBe(b)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('接上假后端：断网时排队，恢复后提交进收件箱', async () => {
    const t = setup()
    await t.login()
    const send = async (r: QuickSaveRequest) => {
      const res = await t.client.POST('/api/v1/quick-save', { body: r })
      if (!res.response.ok) throw new ApiError(res.response.status, 'unknown', 'fail')
      return res.data!
    }
    await t.control('config', { offline: true })
    await enqueueSave({ url: 'https://queued.example.com/', title: '排队的' })
    expect((await flushQueue(send)).interrupted).toBe(true)
    await t.control('config', { offline: false })
    const s = await flushQueue(send)
    expect(s.sent).toBe(1)
    const look = await t.client.GET('/api/v1/lookup', { params: { query: { url: 'https://queued.example.com' } } })
    expect(look.data!.matches[0].path).toEqual(['收件箱'])
  })
})
