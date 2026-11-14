import type { Translate } from '../../src/lib/i18n';
import type { StorageAreaLike } from '../../src/lib/storage';

/** In-memory chrome.storage area. */
export class MemoryArea implements StorageAreaLike {
  data: Record<string, unknown> = {};

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null || keys === undefined) return structuredClone(this.data);
    const list = typeof keys === 'string' ? [keys] : keys;
    return Object.fromEntries(list.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const k of typeof keys === 'string' ? [keys] : keys) delete this.data[k];
  }
}

/** Translator that makes keys and substitutions visible in assertions. */
export const tt: Translate = (key, subs) => (subs?.length ? `${key}(${subs.join('|')})` : key);
