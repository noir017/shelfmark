// 首屏前应用主题，避免闪烁（CSP 不允许内联脚本，所以单独成文件）
;(function () {
  try {
    var theme = localStorage.getItem('shelfmark.theme') || 'system'
    var dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    var lang = localStorage.getItem('shelfmark.lang')
    if (lang) document.documentElement.lang = lang
  } catch (e) {}
})()
