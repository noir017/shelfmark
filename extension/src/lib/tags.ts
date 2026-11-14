/** Split user input into tags: whitespace, commas (ASCII and CJK) and 、 separate; case-insensitive dedupe. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,，、;；]+/)) {
    const tag = raw.replace(/^#/, '').trim().slice(0, 64);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 50) break;
  }
  return out;
}

export function formatTags(tags: readonly string[]): string {
  return tags.join(', ');
}

export function addTag(input: string, tag: string): string {
  const tags = parseTags(input);
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return formatTags(tags);
  return formatTags([...tags, tag]);
}
