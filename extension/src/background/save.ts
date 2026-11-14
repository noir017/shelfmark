import type { Api } from '../api/client';
import { describeError } from '../lib/errors';
import type { Translate } from '../lib/i18n';
import { isSavableUrl } from '../lib/server-url';
import { hasAccessToken, type Config } from '../lib/storage';
import type { QuickSaveResult } from '../lib/types';
import { BUSY_BADGE, COLORS, type BadgeView } from './badge';
import { summarize, type LookupService } from './lookup';

export interface SaveRequest {
  url: string;
  title?: string;
  /** Tab whose toolbar badge shows the feedback. */
  tabId: number;
}

export interface SaveDeps {
  services(): Promise<{ api: Api; config: Config } | null>;
  lookups: LookupService;
  badge(tabId: number, view: BadgeView): Promise<void>;
  /** Restore the tab's normal badge (re-runs the lookup). */
  refreshTab(tabId: number): Promise<void>;
  openOptions(): Promise<void>;
  t: Translate;
  later(fn: () => void, ms: number): void;
}

export const FLASH_MS = 2500;
export const ERROR_MS = 6000;

/**
 * Quick-save to the default location (context menu and keyboard shortcut) and report the
 * outcome on the toolbar badge: "…" while saving, then ✓ or ! with the details in the tooltip.
 */
export async function saveToDefault(deps: SaveDeps, req: SaveRequest): Promise<QuickSaveResult | null> {
  const { t } = deps;
  const svc = await deps.services();
  if (!svc) {
    await deps.openOptions();
    return null;
  }
  if (!isSavableUrl(req.url)) {
    await deps.badge(req.tabId, { text: '!', color: COLORS.error, title: t('errUnsupportedUrl') });
    deps.later(() => void deps.refreshTab(req.tabId), ERROR_MS);
    return null;
  }
  await deps.badge(req.tabId, BUSY_BADGE(t));
  try {
    const title = req.title?.trim();
    const { result, created } = await svc.api.quickSave({ url: req.url, ...(title ? { title } : {}) });
    // Make the saved state visible right away without another lookup round trip.
    await deps.lookups.put(req.url, summarize({ matches: [{ library: result.library, item: result.item, path: result.path }] }));
    const where = [result.library, ...result.path].join(' / ');
    await deps.badge(req.tabId, {
      text: '✓',
      color: COLORS.busy,
      title: t(created ? 'badgeSavedTo' : 'badgeAlreadySaved', [result.item.title || req.url, where]),
    });
    // The cached summary may be incomplete (other libraries); let the tab re-check after the flash.
    deps.later(() => void deps.lookups.invalidate(req.url).then(() => deps.refreshTab(req.tabId)), FLASH_MS);
    return result;
  } catch (err) {
    await deps.badge(req.tabId, {
      text: '!',
      color: COLORS.error,
      title: `${t('badgeSaveFailed')}\n${describeError(err, t, { accessTokenSet: hasAccessToken(svc.config) })}`,
    });
    deps.later(() => void deps.refreshTab(req.tabId), ERROR_MS);
    return null;
  }
}
