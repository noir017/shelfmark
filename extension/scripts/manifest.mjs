// Manifest for each build target. Kept as plain JS so build scripts run on any Node >= 20.

export const TARGETS = /** @type {const} */ (['chrome', 'firefox']);

export const FIREFOX_ID = 'shelfmark@example.com';

/** Sent to the configured server: page URLs (lookup), bookmarks, omnibox queries, login. */
export const FIREFOX_DATA_COLLECTION = ['authenticationInfo', 'bookmarksInfo', 'browsingActivity', 'searchTerms'];

/**
 * @param {'chrome' | 'firefox'} target
 * @param {string} version
 */
export function buildManifest(target, version) {
  const manifest = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'shelfmark',
    description: '__MSG_extDescription__',
    version,
    default_locale: 'en',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_actionTitle__',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage', 'contextMenus', 'activeTab', 'tabs', 'alarms'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    commands: {
      'save-page': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '__MSG_commandSavePage__',
      },
    },
    omnibox: { keyword: 'sm' },
    chrome_url_overrides: { newtab: 'newtab.html' },
  };

  if (target === 'chrome') {
    return {
      ...manifest,
      minimum_chrome_version: '116',
      background: { service_worker: 'background.js' },
    };
  }
  if (target === 'firefox') {
    return {
      ...manifest,
      background: { scripts: ['background.js'] },
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ID,
          // 140 is the first version with built-in data collection consent.
          strict_min_version: '140.0',
          // Everything goes only to the user's own server, but AMO counts that as transmission too.
          data_collection_permissions: { required: FIREFOX_DATA_COLLECTION },
        },
        gecko_android: { strict_min_version: '142.0' },
      },
    };
  }
  throw new Error(`unknown target: ${target}`);
}
