import { expect, test } from '../fixtures'
import { login, mock, reset } from './helpers'

test.beforeEach(async ({ request }) => reset(request))

test('Access 会话过期：提示整页刷新，SW 不缓存 Access 登录页', async ({ page, context, request }) => {
  await login(page)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await context.route('https://example.cloudflareaccess.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Access</title><h1>Cloudflare Access login</h1>' }),
  )
  await mock(request, 'config', { accessExpired: true })

  // 站内跳转触发 API 请求 → 被 302 到 Access → 识别为会话过期
  await page.getByTestId('workspace-search').fill('svelte')
  await page.getByTestId('workspace-search').press('Enter')
  await expect(page.getByTestId('access-expired')).toContainText('Cloudflare 登录已过期')

  // 整页刷新：导航请求原样跟随跳转，不回退到缓存的外壳
  await page.getByTestId('access-expired').getByRole('button', { name: '刷新页面' }).click()
  await expect(page.getByRole('heading', { name: 'Cloudflare Access login' })).toBeVisible()

  await mock(request, 'config', { accessExpired: false })
  await page.goto('/')
  await expect(page.getByTestId('workspace-search')).toBeVisible()
  const shell = await page.evaluate(async () => (await (await caches.match('/index.html'))?.text()) ?? '')
  expect(shell).toContain('shelfmark')
  expect(shell).not.toContain('Cloudflare Access login')
})
