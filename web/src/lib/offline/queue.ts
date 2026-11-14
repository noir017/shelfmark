// 离线收藏队列：快速收藏遇到网络错误时存进 IndexedDB，恢复联网或下次打开时按序提交
import { AccessExpiredError, ApiError, NetworkError } from '../../api/client'
import type { QuickSaveRequest, QuickSaveResult } from '../../api/types'
import { queueAdd, queueAll, queueDelete } from './idb'

export interface QueuedSave {
  id?: number
  request: QuickSaveRequest
  createdAt: string
}

export type FlushOutcome =
  | { entry: QueuedSave; ok: true; result: QuickSaveResult }
  | { entry: QueuedSave; ok: false; error: ApiError }

export interface FlushSummary {
  sent: number
  failed: number
  remaining: number
  /** 因网络或临时错误中断 */
  interrupted: boolean
}

export async function enqueueSave(request: QuickSaveRequest): Promise<number> {
  return queueAdd<QueuedSave>({ request, createdAt: new Date().toISOString() })
}

export async function listQueued(): Promise<QueuedSave[]> {
  const all = await queueAll<QueuedSave>()
  return all.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
}

/** 临时性错误：保留在队列里下次再试 */
function transient(e: unknown): boolean {
  if (e instanceof NetworkError || e instanceof AccessExpiredError) return true
  if (e instanceof ApiError) return e.status === 423 || e.status === 429 || e.status >= 500
  return true
}

let running: Promise<FlushSummary> | null = null

/** 按入队顺序逐个提交；同一时间只跑一次（重复调用返回同一个 Promise） */
export function flushQueue(
  send: (r: QuickSaveRequest) => Promise<QuickSaveResult>,
  onOutcome?: (o: FlushOutcome) => void,
): Promise<FlushSummary> {
  if (running) return running
  running = (async () => {
    const summary: FlushSummary = { sent: 0, failed: 0, remaining: 0, interrupted: false }
    const entries = await listQueued()
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      try {
        const result = await send(entry.request)
        await queueDelete(entry.id!)
        summary.sent++
        onOutcome?.({ entry, ok: true, result })
      } catch (e) {
        if (transient(e)) {
          summary.interrupted = true
          summary.remaining = entries.length - i
          break
        }
        await queueDelete(entry.id!)
        summary.failed++
        onOutcome?.({ entry, ok: false, error: e as ApiError })
      }
    }
    return summary
  })().finally(() => {
    running = null
  })
  return running
}
