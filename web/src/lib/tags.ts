/** 把“a, b #c”之类的输入拆成标签：逗号、空白分隔，去掉开头的 # */
export function parseTags(s: string): string[] {
  const out: string[] = []
  for (const x of s.split(/[,，\s]+/)) {
    const v = x.replace(/^#/, '').trim()
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  return out
}
