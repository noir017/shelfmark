// Playwright 用：没有构建产物就先构建，然后用 vite preview（挂内存假后端）提供 dist
import { existsSync } from 'node:fs'
import { build, preview } from 'vite'

const port = Number(process.env.E2E_PORT ?? 4391)
if (!existsSync('dist/index.html') || process.env.E2E_REBUILD) await build({ logLevel: 'warn' })
const server = await preview({ preview: { port, strictPort: true, host: 'localhost' } })
server.printUrls()
