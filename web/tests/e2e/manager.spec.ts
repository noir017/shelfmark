import { expect, test } from '@playwright/test'
import { login, longPress, mock, newBookmark, newFolder, openNew, reset, row, rowMenu, touchDrag } from './helpers'

test.beforeEach(async ({ request }) => reset(request))

test('建文件夹、建书签、行内编辑、删除并撤销', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await expect(row(page, '常用')).toBeVisible()

  await newFolder(page, '测试文件夹')
  await newBookmark(page, 'https://example.net/page', 'Example Net', 'e2e, 测试')
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
  const src = row(page, 'Example Domain').locator('.title')
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

test('文件夹选择器默认折叠，展开后能选深层文件夹', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await rowMenu(page, 'Example Domain', '移动到…')
  const dlg = page.getByTestId('move-dialog')
  const opt = (name: string) => dlg.getByTestId('folder-option').filter({ hasText: name })
  await expect(opt('工具')).toBeVisible()
  await expect(opt('在线工具')).toHaveCount(0)
  await dlg.locator('.opt').filter({ has: page.getByRole('option', { name: '工具', exact: true }) }).getByTestId('folder-toggle').click()
  await opt('在线工具').click()
  await page.getByRole('button', { name: '移动到这里' }).click()
  await expect(page.getByTestId('toast').filter({ hasText: '已移动' })).toBeVisible()
  // 搜索时平铺显示带路径的结果
  await rowMenu(page, 'Example（newsletter 链接）', '移动到…')
  await expect(opt('在线工具')).toHaveCount(0)
  await dlg.getByTestId('picker-filter').fill('在线')
  await expect(opt('工具 / 在线工具')).toBeVisible()
})

test('423：库被 Floccus 锁定时提示并自动重试', async ({ page, request }) => {
  await login(page, '/lib/bookmarks')
  await mock(request, 'lock', { library: 'bookmarks', durationMs: 1500, actor: 'Floccus · 笔记本' })
  await openNew(page, '新建文件夹')
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
  await expect(page.getByTestId('sync-status')).toHaveCount(0)
  await expect(page.getByTestId('sync-icon')).toHaveAttribute('title', /最后同步/)
})

test('书签默认新标签页打开', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await expect(row(page, 'Example Domain').locator('a.title')).toHaveAttribute('target', '_blank')
})

test('书签栏：悬停弹出文件夹菜单，子文件夹向右展开，移开就收起', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  const bar = page.getByTestId('bookmark-bar')
  await bar.getByTestId('bar-folder').filter({ hasText: '工具' }).hover()
  const menus = page.getByTestId('folder-menu')
  await expect(menus).toHaveCount(1)
  await menus.first().locator('a.mi', { hasText: '在线工具' }).hover()
  await expect(menus).toHaveCount(2)
  const link = menus.nth(1).locator('a.mi', { hasText: 'Regex101' })
  await expect(link).toHaveAttribute('target', '_blank')
  // 悬停到相邻文件夹直接切换
  await bar.getByTestId('bar-folder').filter({ hasText: '阅读' }).hover()
  await expect(menus.first()).toContainText('Lobsters')
  await page.mouse.move(700, 600)
  await expect(menus).toHaveCount(0)
  // 点开的菜单不随指针离开收起，点文件夹进入
  await bar.getByTestId('bar-folder').filter({ hasText: '工具' }).click()
  await page.mouse.move(700, 600)
  await page.waitForTimeout(600)
  await menus.first().locator('a.mi', { hasText: '在线工具' }).click()
  await expect(page).toHaveURL(/\/lib\/bookmarks\/f\/\d+$/)
  await expect(row(page, 'Regex101')).toBeVisible()
  await expect(menus).toHaveCount(0)
})

test('面包屑分隔符列出同级文件夹，直接跳过去', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await row(page, '工具').locator('a.title').click()
  await expect(row(page, '在线工具')).toBeVisible()
  await page.getByTestId('crumb-sep').first().click()
  const menu = page.getByTestId('folder-menu')
  await expect(menu.locator('a.mi')).toHaveText(['常用', '工具', '阅读', '购物'])
  await menu.locator('a.mi', { hasText: '阅读' }).click()
  await expect(row(page, 'Lobsters')).toBeVisible()
  await expect(page.getByTestId('breadcrumbs')).toContainText('阅读')
})

test('列表原地展开文件夹，刷新后保持', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await expect(row(page, 'GitHub')).toHaveCount(0)
  await row(page, '常用').getByTestId('row-toggle').click()
  await expect(row(page, 'GitHub')).toHaveAttribute('data-depth', '1')
  await page.reload()
  await expect(row(page, 'GitHub')).toBeVisible()
  await row(page, '常用').getByTestId('row-toggle').click()
  await expect(row(page, 'GitHub')).toHaveCount(0)
})

test('Ctrl/Shift 点击多选', async ({ page }) => {
  await login(page, '/lib/bookmarks')
  await row(page, '常用').click({ modifiers: ['ControlOrMeta'] })
  await expect(page).toHaveURL(/\/lib\/bookmarks$/)
  await row(page, '购物').click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-bar')).toContainText('已选 4 项')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)
})

test.describe('触屏', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('长按进入多选，点行切换选择，用手柄拖动排序', async ({ page }) => {
    await login(page, '/lib/bookmarks')
    await expect(row(page, 'Example Domain')).toBeVisible()
    await expect(row(page, 'Example Domain').locator('[data-drag-handle]')).toBeHidden()
    await longPress(page, '[data-testid=item-row][data-title="Example Domain"] .title')
    await expect(page.getByTestId('selection-bar')).toContainText('已选 1 项')
    await row(page, '内网测试站').locator('.title').tap()
    await expect(page.getByTestId('selection-bar')).toContainText('已选 2 项')
    await row(page, '常用').locator('.title').tap()
    await expect(page).toHaveURL(/\/lib\/bookmarks$/)
    await expect(page.getByTestId('selection-bar')).toContainText('已选 3 项')
    await page.getByTestId('selection-bar').getByRole('button', { name: '取消' }).tap()
    await longPress(page, '[data-testid=item-row][data-title="Example Domain"] .title')
    await expect(row(page, 'Example Domain').locator('[data-drag-handle]')).toBeVisible()
    await touchDrag(page, '[data-testid=item-row][data-title="Example Domain"]', '[data-testid=item-row][data-title="常用"]', 0.1)
    await expect(page.getByTestId('item-row').first()).toHaveAttribute('data-title', 'Example Domain')
  })
})
