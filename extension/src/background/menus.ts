import type { Translate } from '../lib/i18n';
import type { SaveRequest } from './save';

export const MENU_SAVE_PAGE = 'shelfmark-save-page';
export const MENU_SAVE_LINK = 'shelfmark-save-link';

const WEB = ['http://*/*', 'https://*/*'];

export interface MenuItem {
  id: string;
  title: string;
  contexts: ('page' | 'link')[];
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
}

export function menuItems(t: Translate): MenuItem[] {
  return [
    { id: MENU_SAVE_PAGE, title: t('menuSavePage'), contexts: ['page'], documentUrlPatterns: WEB },
    { id: MENU_SAVE_LINK, title: t('menuSaveLink'), contexts: ['link'], targetUrlPatterns: WEB },
  ];
}

export interface MenusApi {
  removeAll(): Promise<void> | void;
  create(props: MenuItem, callback?: () => void): unknown;
}

/** (Re)create the context menu entries; safe to call on every startup. */
export async function installMenus(menus: MenusApi, t: Translate, lastError: () => unknown = () => undefined) {
  await menus.removeAll();
  for (const item of menuItems(t)) {
    await new Promise<void>((resolve) =>
      menus.create(item, () => {
        lastError(); // read it so the browser doesn't log "unchecked runtime.lastError"
        resolve();
      }),
    );
  }
}

export interface MenuClickInfo {
  menuItemId: string | number;
  pageUrl?: string;
  linkUrl?: string;
  /** Firefox only. */
  linkText?: string;
}

export interface TabLike {
  id?: number;
  url?: string;
  title?: string;
}

/** Map a context menu click to what should be saved; null if the click isn't ours or lacks data. */
export function menuSaveRequest(info: MenuClickInfo, tab: TabLike | undefined): SaveRequest | null {
  if (tab?.id === undefined || tab.id < 0) return null;
  if (info.menuItemId === MENU_SAVE_PAGE) {
    const url = tab.url || info.pageUrl;
    return url ? { url, title: tab.title, tabId: tab.id } : null;
  }
  if (info.menuItemId === MENU_SAVE_LINK) {
    if (!info.linkUrl) return null;
    // Chrome gives no link text; the server fetches the title when it is missing.
    return { url: info.linkUrl, title: info.linkText?.trim() || undefined, tabId: tab.id };
  }
  return null;
}

export async function handleMenuClick(
  info: MenuClickInfo,
  tab: TabLike | undefined,
  save: (req: SaveRequest) => Promise<unknown>,
): Promise<boolean> {
  const req = menuSaveRequest(info, tab);
  if (!req) return false;
  await save(req);
  return true;
}
