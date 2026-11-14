import { expect, test } from '@playwright/test'
import { login, mock, reset, row, rowMenu, touchDrag } from './helpers'

test.beforeEach(async ({ request }) => reset(request))

test('建文件夹、建书签、行内编辑、删除并撤销', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await expect(row(page, '常用')).toBeVisible()

  await page.getByTestId('new-folder').click()
  await page.getByTestId('confirm-dialog').locator('input').fill('测试文件夹')
  await page.getByRole('button', { name: '创建' }).click()
  await expect(row(page, '测试文件夹')).toBeVisible()

  await page.getByTestId('new-bookmark').click()
  const dlg = page.getByTestId('item-dialog')
  await dlg.locator('input[name=url]').fill('https://example.net/page')
  await dlg.locator('input[name=title]').fill('Example Net')
  await dlg.locator('input[name=tags]').fill('e2e, 测试')
  await dlg.getByRole('button', { name: '保存' }).click()
  await expect(row(page, 'Example Net')).toBeVisible()
  await expect(row(page, 'Example Net').getByText('#e2e')).toBeVisible()

  await rowMenu(page, 'Example Net', '编辑')
  const edit = page.getByTestId('inline-edit')
  await edit.locator('input').first().fill('Example Net 改')
  await edit.locator('input').first().press('Enter')
  await expect(row(page, 'Example Net 改')).toBeVisible()

  await rowMenu(page, 'Example Net 改', '删除')
  await expect(row(page, 'Example Net 改')).toHaveCount(0)
  await page.getByTestId('toast').getByRole('button', { name: '撤销' }).click()
  await expect(row(page, 'Example Net 改')).toBeVisible()
  await expect(row(page, 'Example Net 改').getByText('#e2e')).toBeVisible()
})

test('鼠标拖放：把书签拖进文件夹', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  const src = row(page, 'Example Domain').locator('[data-drag-handle]')
  const dst = row(page, '购物')
  const a = (await src.boundingBox())!
  const b = (await dst.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  await expect(dst).toHaveAttribute('data-drop-zone', 'inside')
  await page.mouse.up()
  await expect(row(page, 'Example Domain')).toHaveCount(0)
  await row(page, '购物').locator('a.title').click()
  await expect(row(page, 'Example Domain')).toBeVisible()
})

test('触屏拖放：用手柄把书签排到最前', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await touchDrag(page, '[data-testid=item-row][data-title="Example Domain"]', '[data-testid=item-row][data-title="常用"]', 0.1)
  await expect(page.getByTestId('item-row').first()).toHaveAttribute('data-title', 'Example Domain')
})

test('多选批量移动', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await row(page, 'Example Domain').locator('input[type=checkbox]').check()
  await row(page, '内网测试站').locator('input[type=checkbox]').check()
  await expect(page.getByTestId('selection-bar')).toContainText('已选 2 项')
  await page.getByTestId('selection-bar').getByRole('button', { name: '移动到…' }).click()
  await page.getByTestId('move-dialog').getByTestId('folder-option').filter({ hasText: '购物' }).click()
  await page.getByRole('button', { name: '移动到这里' }).click()
  await expect(row(page, 'Example Domain')).toHaveCount(0)
  await expect(row(page, '内网测试站')).toHaveCount(0)
})

test('423：库被 Floccus 锁定时提示并自动重试', async ({ page, request }) => {
  await login(page, '/lib/bookmarks')
  await mock(request, 'lock', { library: 'bookmarks', durationMs: 1500, actor: 'Floccus · 笔记本' })
  await page.getByTestId('new-folder').click()
  await page.getByTestId('confirm-dialog').locator('input').fill('锁后新建')
  await page.getByRole('button', { name: '创建' }).click()
  await expect(page.getByTestId('toast').filter({ hasText: '正在与 Floccus · 笔记本 同步' })).toBeVisible()
  await expect(row(page, '锁后新建')).toBeVisible({ timeout: 10_000 })
})

test('同步状态与强制解锁', async ({ page, request }) => {
  await mock(request, 'lock', { library: 'bookmarks', durationMs: 600_000, actor: 'Floccus · 台式机' })
  await login(page, '/lib/bookmarks')
  await expect(page.getByTestId('sync-status')).toContainText('正在与 Floccus · 台式机 同步')
  await page.getByTestId('force-unlock').click()
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '强制解锁' }).click()
  await expect(page.getByTestId('sync-status')).not.toContainText('正在与')
})
