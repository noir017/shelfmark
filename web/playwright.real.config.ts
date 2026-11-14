// 对真实二进制跑的少量关键用例（tests/real）。先 make all，再 npm run test:real。
// 默认用临时数据目录启动 SHELFMARK_BIN（默认 ../server/bin/shelfmark），端口 E2E_REAL_PORT（默认 4392）。
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// 配置文件在主进程和每个 worker 里都会执行，用环境变量保证只生成一次
const env = process.env
env.SHELFMARK_E2E_USER ??= 'alice'
env.SHELFMARK_E2E_PASSWORD ??= randomBytes(12).toString('hex')
env.SHELFMARK_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'shelfmark-e2e-'))
const port = env.E2E_REAL_PORT ?? '4392'

export default defineConfig({
  ...base,
  testDir: 'tests/real',
  globalTeardown: './tests/real/teardown.ts',
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `"${resolve(env.SHELFMARK_BIN ?? '../server/bin/shelfmark')}" serve`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      SHELFMARK_LISTEN: `127.0.0.1:${port}`,
      SHELFMARK_DATA_DIR: env.SHELFMARK_E2E_DATA,
      SHELFMARK_ADMIN_USER: env.SHELFMARK_E2E_USER,
      SHELFMARK_ADMIN_PASSWORD: env.SHELFMARK_E2E_PASSWORD,
      SHELFMARK_FETCH_METADATA: 'false',
      SHELFMARK_LINKCHECK_INTERVAL: '0',
    },
  },
})
