import { expect, type APIRequestContext, type Page } from '@playwright/test'

export async function reset(request: APIRequestContext, body: Record<string, unknown> = {}) {
  const r = await request.post('/__mock/reset', { data: body })
  expect(r.ok()).toBeTruthy()
}

export async function mock(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  return request.post('/__mock/' + path, { data })
}

export async function login(page: Page, next = '/') {
  await page.goto(next)
  if (next.startsWith('/lib')) await expect(page.getByTestId('item-list')).toBeVisible()
  else if (next === '/') await expect(page.getByTestId('workspace-search')).toBeVisible()
  else await expect(page).toHaveURL(new RegExp(next.replace(/[?]/g, '\\?')))
}

export const row = (page: Page, title: string) => page.locator(`[data-testid=item-row][data-title="${title}"]`)

export async function openNew(page: Page, item: '新建书签' | '新建文件夹') {
  await page.getByTestId('new-bookmark').click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

export async function newFolder(page: Page, name: string) {
  await openNew(page, '新建文件夹')
  await page.getByTestId('confirm-dialog').locator('input').fill(name)
  await page.getByRole('button', { name: '创建' }).click()
  await expect(row(page, name)).toBeVisible()
}

export async function newBookmark(page: Page, url: string, title: string, tags?: string) {
  await openNew(page, '新建书签')
  const dlg = page.getByTestId('save-sheet')
  await dlg.getByTestId('share-url').fill(url)
  await dlg.getByTestId('share-title').fill(title)
  if (tags) await dlg.locator('input[name=tags]').fill(tags)
  await dlg.getByTestId('share-save').click()
  await expect(dlg.getByTestId('share-result')).toBeVisible()
  await dlg.locator('.done').getByRole('button', { name: '关闭' }).click()
  await expect(row(page, title)).toBeVisible()
}

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
