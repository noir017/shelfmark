/** Cross-browser extension namespace: Firefox exposes promise-based `browser`, Chromium `chrome`. */
const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome };

export const ext: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;

export const TARGET = __TARGET__;
