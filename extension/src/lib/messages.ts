/** Messages from extension pages to the background. */
import type { LookupSummary } from '../background/lookup';

export type BackgroundMessage =
  /** The popup changed what is saved for a URL; update cache and badges. */
  | { type: 'lookup-updated'; url: string; summary: LookupSummary }
  /** Re-run lookups for the active tabs (e.g. after the settings changed). */
  | { type: 'refresh-badges' };
