import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const USER = 'alice'
export const PASS = process.env.SHELFMARK_MOCK_PASSWORD || 'demo-password'

export async function reset(request: APIRequestContext, body: Record<string, unknown> = {}) {
  const r = await request.post('/__mock/reset', { data: body })
  expect(r.ok()).toBeTruthy()
}

export async function mock(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  return request.post('/__mock/' + path, { data })
}

export async function login(page: Page, next = '/') {
  await page.goto('/login' + (next !== '/' ? '?next=' + encodeURIComponent(next) : ''))
  await page.locator('input[name=username]').fill(USER)
  await page.locator('input[name=password]').fill(PASS)
  await page.getByRole('button', { name: '登录' }).click()
  if (next === '/') await expect(page.getByTestId('start-search')).toBeVisible()
  else await expect(page).toHaveURL(new RegExp(next.replace(/[?]/g, '\\?')))
}

export const row = (page: Page, title: string) => page.locator(`[data-testid=item-row][data-title="${title}"]`)

export async function rowMenu(page: Page, title: string, item: string) {
  await row(page, title).getByTestId('row-menu').click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/** 用合成的触屏 PointerEvent 拖动（Playwright 没有多点触控拖动 API） */
export async function touchDrag(page: Page, from: string, to: string, yFraction: number) {
  await page.evaluate(
    ({ from, to, yFraction }) => {
      const src = document.querySelector(from)!.querySelector<HTMLElement>('[data-drag-handle]')!
      const dst = document.querySelector<HTMLElement>(to)!
      const a = src.getBoundingClientRect()
      const b = dst.getBoundingClientRect()
      const opts = (x: number, y: number) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y })
      const sx = a.left + a.width / 2
      const sy = a.top + a.height / 2
      const tx = b.left + b.width / 2
      const ty = b.top + b.height * yFraction
      src.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy)))
      for (let i = 1; i <= 8; i++) window.dispatchEvent(new PointerEvent('pointermove', opts(sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8)))
      window.dispatchEvent(new PointerEvent('pointerup', opts(tx, ty)))
    },
    { from, to, yFraction },
  )
}
