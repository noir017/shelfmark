/**
 * Normalize what the user typed as server address: default to https, keep an optional
 * sub-path, drop query/fragment and trailing slashes. Throws on anything not http(s).
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('empty');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  if (!u.hostname) throw new Error('host');
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Host permission pattern for the server. Ports are left out on purpose: Firefox match
 * patterns do not accept them and in Chrome a port-less pattern covers every port.
 */
export function originPattern(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Only http(s) pages can be saved or looked up. */
export function isSavableUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/** Heuristic for the search boxes: does the input look like an address to open directly? */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(s) && /\.[a-z]{2,}(:\d+)?(\/|$)|^localhost/i.test(s);
}

export function toNavigableUrl(input: string): string {
  const s = input.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}
