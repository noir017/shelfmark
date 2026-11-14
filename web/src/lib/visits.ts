// 点击书签时用 sendBeacon 记访问（页面跳走也能发出去）
export function recordVisit(library: string, itemId: number) {
  const body = JSON.stringify({ library, itemId })
  try {
    if (navigator.sendBeacon && navigator.sendBeacon('/api/v1/visits', body)) return
  } catch {
    /* 退回 fetch */
  }
  fetch('/api/v1/visits', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'shelfmark' } }).catch(() => {})
}
