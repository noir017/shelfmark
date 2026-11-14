import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

// 页面按路由重建、对话框只取初始值，这两类提示是有意为之
const IGNORED = new Set(['state_referenced_locally', 'a11y_autofocus'])

export default {
  preprocess: vitePreprocess(),
  compilerOptions: { warningFilter: (w) => !IGNORED.has(w.code) },
}
