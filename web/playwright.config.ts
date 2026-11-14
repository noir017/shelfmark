import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4391)

/** 本机已装的 chromium 版本可能与 Playwright 要求的不同：没有对应版本时回退到缓存里最新的一个 */
function chromiumPath(): string | undefined {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH
  try {
    if (existsSync(chromium.executablePath())) return undefined
  } catch {
    /* 没装 */
  }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(base)) return undefined
  const dirs = readdirSync(base)
    .filter((d) => /^chromium_headless_shell-\d+$/.test(d) || /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]) || (a.includes('headless') ? -1 : 1))
  for (const d of dirs) {
    for (const sub of readdirSync(join(base, d))) {
      for (const exe of ['headless_shell', 'chrome']) {
        const p = join(base, d, sub, exe)
        if (existsSync(p)) return p
      }
    }
  }
  return undefined
}

const executablePath = chromiumPath()

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  // 假后端是进程内共享状态，只能串行
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
  ],
  webServer: {
    command: `node scripts/e2e-server.mjs`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { E2E_PORT: String(PORT) },
  },
})
