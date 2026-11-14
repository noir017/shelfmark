// i18n：zh-CN 默认内置，en 按需加载。t() 读取响应式的当前语言，模板里调用会随语言切换刷新。
import zh from './zh-CN'

export type Key = keyof typeof zh
export type Lang = 'zh-CN' | 'en'
export type LangPref = 'auto' | Lang
type Dict = Record<Key, string>

const dicts: Partial<Record<Lang, Dict>> = { 'zh-CN': zh }
const state = $state({ lang: 'zh-CN' as Lang })

export function resolveLang(pref: LangPref | null | undefined): Lang {
  if (pref === 'zh-CN' || pref === 'en') return pref
  const nav = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []
  for (const l of nav) {
    if (/^zh/i.test(l)) return 'zh-CN'
    if (/^en/i.test(l)) return 'en'
  }
  return 'zh-CN'
}

export async function setLang(pref: LangPref | null | undefined): Promise<void> {
  const lang = resolveLang(pref)
  if (!dicts[lang]) dicts[lang] = (await import('./en')).default
  state.lang = lang
  document.documentElement.lang = lang
  try {
    localStorage.setItem('shelfmark.lang', lang)
  } catch {
    /* ignore */
  }
}

export function lang(): Lang {
  return state.lang
}

export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = dicts[state.lang]?.[key] ?? zh[key] ?? key
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
  return s
}

function locale() {
  return state.lang === 'en' ? 'en-US' : 'zh-CN'
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(locale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return t('time.never')
  const diff = (Date.parse(iso) - Date.now()) / 1000
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  if (abs < 45) return t('time.justNow')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return fmtDateTime(iso)
}

export function fmtNumber(n: number): string {
  return n.toLocaleString(locale())
}
