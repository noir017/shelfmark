// 配了 PW_CDP_URL 就连远程浏览器（CDP），每个用例照常新建自己的 context；没配就用本地启动的浏览器。
// PW_CDP_HEADERS 可选，形如 "X-Api-Key: xxx"，连接时带上。
// 远程浏览器要能访问本机的被测服务（localhost），得由浏览器那边的代理把网络带回本机。
// 只能在本地跑的用例（扩展、下载落盘、改启动参数）直接从 @playwright/test 引 test。
import { test as base } from '@playwright/test'

export * from '@playwright/test'

const cdpUrl = process.env.PW_CDP_URL

function cdpHeaders(): Record<string, string> | undefined {
  const raw = process.env.PW_CDP_HEADERS ?? ''
  const i = raw.indexOf(':')
  return i > 0 ? { [raw.slice(0, i).trim()]: raw.slice(i + 1).trim() } : undefined
}

export const test = cdpUrl
  ? base.extend({
      browser: [
        async ({ playwright }, use) => {
          const browser = await playwright.chromium.connectOverCDP(cdpUrl, { headers: cdpHeaders() })
          await use(browser)
          // 只断开连接、清掉本次建的 context，不会关远程浏览器
          await browser.close()
        },
        { scope: 'worker' },
      ],
    })
  : base
