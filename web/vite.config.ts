import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { serviceWorker } from './build/sw-plugin.ts'
import { backend } from './mock/vite-plugin.ts'

const root = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8')) as { version: string }

export default defineConfig({
  plugins: [svelte(), backend(), serviceWorker({ root, publicDir: root + 'public' })],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
})
