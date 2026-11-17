// 对真实二进制跑的关键流程。每条用例建自己的库，互不影响；界面操作后再用 API 核对服务端状态。
import { expect, test, type Page } from '../fixtures'
import { newBookmark, newFolder, row, rowMenu } from '../e2e/helpers'

type Node = { id: number; type: string; title: string; url?: string | null; tags: string[]; children?: Node[] }

async function login(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('workspace-search')).toBeVisible()
}

/** 用页面的同源请求调 API */
async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const r = await page.request.fetch(path, { method, data, headers: { 'X-Requested-With': 'shelfmark' } })
  expect(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy()
  return (await r.json()) as T
}

async function newLibrary(page: Page, name: string): Promise<string> {
  const slug = `e2e-${Date.now().toString(36)}`
  await api(page, 'POST', '/api/v1/libraries', { slug, name })
  return slug
}

const tree = async (page: Page, slug: string) => (await api<{ children: Node[] }>(page, 'GET', `/api/v1/libraries/${slug}/tree`)).children

test('登录后建文件夹、建书签、行内编辑、删除并撤销', async ({ page }) => {
  await login(page)
  const slug = await newLibrary(page, '建改删')
  await page.goto(`/lib/${slug}`)

  await newFolder(page, '测试文件夹')
  await newBookmark(page, 'https://example.net/page', 'Example Net', 'e2e, 测试')
  await expect(row(page, 'Example Net').getByText('#e2e')).toBeVisible()

  await rowMenu(page, 'Example Net', '编辑')
  const edit = page.getByTestId('inline-edit')
  await edit.locator('input').first().fill('Example Net 改')
  await edit.locator('input').first().press('Enter')
  await expect(row(page, 'Example Net 改')).toBeVisible()
  await expect.poll(async () => (await tree(page, slug)).map((n) => n.title)).toEqual(['测试文件夹', 'Example Net 改'])

  await rowMenu(page, 'Example Net 改', '删除')
  await expect(row(page, 'Example Net 改')).toHaveCount(0)
  await expect.poll(async () => (await tree(page, slug)).length).toBe(1)
  await page.getByTestId('toast').getByRole('button', { name: '撤销' }).click()
  await expect(row(page, 'Example Net 改')).toBeVisible()
  await expect(row(page, 'Example Net 改').getByText('#e2e')).toBeVisible()

  await expect
    .poll(async () => (await tree(page, slug)).find((n) => n.type === 'bookmark'))
    .toMatchObject({ title: 'Example Net 改', url: 'https://example.net/page', tags: expect.arrayContaining(['e2e', '测试']) })
})

test('鼠标拖放：把书签拖进文件夹', async ({ page }) => {
  await login(page)
  const slug = await newLibrary(page, '拖放')
  const folder = await api<{ item: Node }>(page, 'POST', `/api/v1/libraries/${slug}/items`, { type: 'folder', title: '购物' })
  await api(page, 'POST', `/api/v1/libraries/${slug}/items`, { type: 'bookmark', title: 'Example Domain', url: 'https://example.com/' })
  await page.goto(`/lib/${slug}`)

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

  await expect
    .poll(async () => (await tree(page, slug)).map((n) => ({ title: n.title, children: n.children?.map((c) => c.title) })))
    .toEqual([{ title: '购物', children: ['Example Domain'] }])
  await row(page, '购物').locator('a.title').click()
  await expect(page).toHaveURL(new RegExp(`/lib/${slug}/f/${folder.item.id}$`))
  await expect(row(page, 'Example Domain')).toBeVisible()
})
