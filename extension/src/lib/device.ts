export interface UaHints {
  userAgent: string;
  /** navigator.userAgentData?.brands */
  brands?: { brand: string }[];
  /** navigator.userAgentData?.platform */
  platform?: string;
  /** Brave exposes navigator.brave */
  isBrave?: boolean;
}

export function detectBrowser(h: UaHints): string {
  const ua = h.userAgent;
  const brands = (h.brands ?? []).map((b) => b.brand);
  if (h.isBrave || brands.includes('Brave')) return 'Brave';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua) || brands.includes('Microsoft Edge')) return 'Edge';
  if (/OPR\//.test(ua) || brands.includes('Opera')) return 'Opera';
  if (/Vivaldi/.test(ua)) return 'Vivaldi';
  if (/Chrome\//.test(ua) || brands.includes('Google Chrome') || brands.includes('Chromium')) return 'Chrome';
  return 'Browser';
}

export function detectOs(h: UaHints): string {
  const p = (h.platform ?? '').toLowerCase();
  const ua = h.userAgent;
  if (p.includes('android') || /Android/.test(ua)) return 'Android';
  if (p.includes('chrome os') || /CrOS/.test(ua)) return 'ChromeOS';
  if (p.includes('win') || /Windows/.test(ua)) return 'Windows';
  if (p.includes('mac') || /Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (p.includes('linux') || /Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

/** Default token name, e.g. "插件 · Chrome · Linux". */
export function deviceName(prefix: string, h: UaHints): string {
  return `${prefix} · ${detectBrowser(h)} · ${detectOs(h)}`.slice(0, 100);
}

export function currentUaHints(): UaHints {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: { brand: string }[]; platform?: string };
    brave?: unknown;
  };
  return {
    userAgent: nav.userAgent,
    brands: nav.userAgentData?.brands,
    platform: nav.userAgentData?.platform,
    isBrave: Boolean(nav.brave),
  };
}
