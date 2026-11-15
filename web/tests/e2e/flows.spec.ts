import { expect, test } from '@playwright/test'
import { login, mock, reset } from './helpers'

test.beforeEach(async ({ request }) => reset(request))

test('内网直接进入，没有登录页', async ({ page }) => {
  await page.goto('/lib/bookmarks')
  await expect(page).toHaveURL(/\/lib\/bookmarks$/)
  await expect(page.getByTestId('start-search')).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByTestId('start-search')).toBeVisible()
})

test('起始页自动分组显示默认库的顶层文件夹', async ({ page, request }) => {
  const r = await request.patch('/api/v1/settings', {
    data: { startPage: { showSearch: true, showRecent: true, recentCount: 8, showFrequent: true, frequentCount: 8, sections: [] } },
    headers: { 'X-Requested-With': 'shelfmark' },
  })
  expect(r.ok()).toBeTruthy()
  await page.goto('/')
  await expect(page.getByTestId('start-section')).toHaveCount(4)
  await expect(page.getByTestId('start-section').filter({ hasText: '工具' })).toBeVisible()
})

test('搜索语法', async ({ page }) => {
  await login(page)
  await page.getByTestId('start-search').fill('#docs')
  await page.getByTestId('start-search').press('Enter')
  await expect(page).toHaveURL(/\/search\?q=%23docs/)
  await expect(page.getByTestId('search-hit').filter({ hasText: 'MDN Web Docs' })).toBeVisible()
  await page.goto('/search?q=is%3Abroken')
  await expect(page.getByTestId('search-hit').filter({ hasText: '已失效的文章' })).toBeVisible()
  await page.goto('/search?q=site%3Ago.dev%20-blog')
  await expect(page.getByTestId('search-hit')).toHaveCount(1)
})

test('分享收藏：从 text 里提取 URL，存进收件箱；已收藏提示', async ({ page }) => {
  await login(page)
  await page.goto('/share?text=' + encodeURIComponent('看看这个 https://example.org/new-article'))
  await expect(page.getByTestId('share-url')).toHaveValue('https://example.org/new-article')
  await expect(page.getByTestId('share-title')).toHaveValue('看看这个')
  await page.getByTestId('share-save').click()
  await expect(page.getByTestId('share-result')).toContainText('收件箱')

  await page.goto('/add?url=' + encodeURIComponent('https://github.com/') + '&title=GitHub')
  await expect(page.getByTestId('already-saved')).toBeVisible()
})

test('离线收藏队列：断网时排队，联网后自动提交', async ({ page, context }) => {
  await login(page)
  await page.goto('/share?url=' + encodeURIComponent('https://offline.example.com/') + '&title=' + encodeURIComponent('离线收藏'))
  await expect(page.getByTestId('share-url')).toHaveValue('https://offline.example.com/')
  await context.setOffline(true)
  await page.getByTestId('share-save').click()
  await expect(page.getByTestId('share-result')).toContainText('本机队列')
  await expect(page.getByTestId('offline-banner')).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByTestId('toast').filter({ hasText: '离线收藏已提交：离线收藏' })).toBeVisible({ timeout: 10_000 })
})

test('离线只读浏览和本地搜索', async ({ page, context }) => {
  await login(page, '/lib/bookmarks')
  await expect(page.locator('[data-testid=item-row][data-title="常用"]')).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('offline-banner')).toBeVisible()
  await expect(page.locator('[data-testid=item-row][data-title="常用"]')).toBeVisible()
  await page.goto('/search?q=svelte')
  await expect(page.getByTestId('local-search')).toBeVisible()
  await expect(page.getByTestId('search-hit').first()).toBeVisible()
  await context.setOffline(false)
})

test('历史差异与回滚、最近删除恢复', async ({ page }) => {
  await login(page, '/history/bookmarks')
  const web = page.getByTestId('revision').filter({ hasText: '网页' })
  await web.getByRole('button').first().click()
  await expect(web.getByTestId('diff')).toContainText('旧的收藏')
  const first = page.getByTestId('revision').last()
  await first.getByRole('button').first().click()
  await first.getByTestId('restore-revision').click()
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '回滚' }).click()
  await expect(page.getByTestId('toast').filter({ hasText: '已回滚' })).toBeVisible()

  await page.goto('/deleted/bookmarks')
  const r = page.getByTestId('deleted-row').filter({ hasText: 'Rust Blog' })
  await r.locator('input[type=checkbox]').check()
  await page.getByTestId('restore-selected').click()
  await expect(page.getByTestId('toast').filter({ hasText: '已恢复' })).toBeVisible()
})

test('拦截的上传：全局横幅 → 查看差异 → 允许', async ({ page, request }) => {
  const r = await mock(request, 'dav-upload', { library: 'bookmarks', keep: 0.2 })
  expect(r.status()).toBe(412)
  await login(page)
  await expect(page.getByTestId('pending-banner')).toBeVisible()
  await page.getByTestId('pending-banner').getByRole('link').click()
  await expect(page.getByTestId('diff')).toContainText('删除')
  await page.getByTestId('pending-approve').click()
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '允许（应用这次上传）' }).click()
  await expect(page.getByTestId('pending-done')).toBeVisible()
  await expect(page.getByTestId('pending-banner')).toHaveCount(0)
})

test('设置页：令牌、Floccus 向导、主题和语言', async ({ page }) => {
  await login(page, '/settings/devices')
  await page.getByTestId('api-token').click()
  await page.getByTestId('token-dialog').locator('input').first().fill('脚本 · 测试')
  await page.getByRole('button', { name: '创建' }).click()
  await expect(page.getByTestId('new-token')).toContainText('smk_')
  await page.getByRole('button', { name: '完成' }).click()

  await page.getByTestId('floccus-wizard').click()
  await page.getByRole('button', { name: '生成配置' }).click()
  await expect(page.getByTestId('floccus-result')).toContainText('/dav/')
  await expect(page.getByTestId('floccus-result')).toContainText('bookmarks.xbel')
  await page.getByRole('button', { name: '完成' }).click()

  for (const s of ['libraries', 'startpage', 'import-export', 'integrations', 'users', 'about']) {
    await page.goto('/settings/' + s)
    await expect(page.locator('.content h1')).toBeVisible()
  }
  await page.goto('/settings/account')
  await page.getByTestId('theme').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByTestId('language').selectOption('en')
  await expect(page.locator('.topnav')).toContainText('Settings')
})

test.describe('窄屏', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('底部导航、单栏管理器、“移动到…”对话框', async ({ page }) => {
    await login(page, '/lib/bookmarks')
    await expect(page.locator('.bottomnav')).toBeVisible()
    await expect(page.locator('.topnav')).toBeHidden()
    await expect(page.locator('aside.side')).toBeHidden()
    await page.locator('[data-testid=item-row][data-title="Example Domain"]').getByTestId('row-menu').click()
    await page.getByRole('menuitem', { name: '移动到…' }).click()
    await page.getByTestId('move-dialog').getByTestId('folder-option').filter({ hasText: '阅读' }).click()
    await page.getByRole('button', { name: '移动到这里' }).click()
    await expect(page.getByTestId('toast').filter({ hasText: '已移动' })).toBeVisible()
  })
})
