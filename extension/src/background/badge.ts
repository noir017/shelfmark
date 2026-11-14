import { describeError, needsSettingsFix, type ErrorContext } from '../lib/errors';
import type { Translate } from '../lib/i18n';
import type { LookupSummary } from './lookup';

export interface BadgeView {
  text: string;
  color: string;
  title: string;
}

export const COLORS = { saved: '#16a34a', busy: '#2563eb', error: '#dc2626' } as const;

export function locationLabel(m: { library: string; path: string[] }): string {
  return [m.library, ...m.path].join(' / ');
}

/** Badge for a lookup result: ✓ when the page is saved anywhere, empty otherwise. */
export function lookupBadge(summary: LookupSummary | null, t: Translate): BadgeView {
  if (!summary || !summary.matches.length) return { text: '', color: COLORS.saved, title: t('actionTitle') };
  const where = summary.matches.map(locationLabel).join('\n');
  return { text: '✓', color: COLORS.saved, title: `${t('badgeSaved')}\n${where}` };
}

/** Badge after a failed lookup: only problems the user must fix are shown; offline stays quiet. */
export function errorBadge(err: unknown, t: Translate, ctx: ErrorContext): BadgeView {
  if (!needsSettingsFix(err)) return { text: '', color: COLORS.saved, title: t('actionTitle') };
  return { text: '!', color: COLORS.error, title: describeError(err, t, ctx) };
}

export const BUSY_BADGE = (t: Translate): BadgeView => ({ text: '…', color: COLORS.busy, title: t('badgeSaving') });

export interface BadgeApi {
  setBadgeText(details: { tabId?: number; text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void> | void;
  setTitle(details: { tabId?: number; title: string }): Promise<void> | void;
}

export async function applyBadge(action: BadgeApi, tabId: number, view: BadgeView): Promise<void> {
  try {
    await action.setBadgeBackgroundColor({ tabId, color: view.color });
    await action.setBadgeText({ tabId, text: view.text });
    await action.setTitle({ tabId, title: view.title });
  } catch {
    // The tab may have closed in the meantime.
  }
}
