// 主题：浅色 / 深色 / 跟随系统，写在 <html data-theme>，CSS 变量切换
export type ThemePref = 'system' | 'light' | 'dark'

let pref: ThemePref = 'system'
let mq: MediaQueryList | null = null

function apply() {
  const dark = pref === 'dark' || (pref === 'system' && !!mq?.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#16181d' : '#2f6fdb')
}

export function setTheme(p: ThemePref | null | undefined) {
  pref = p ?? 'system'
  if (!mq && typeof matchMedia !== 'undefined') {
    mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
  }
  try {
    localStorage.setItem('shelfmark.theme', pref)
  } catch {
    /* ignore */
  }
  apply()
}
