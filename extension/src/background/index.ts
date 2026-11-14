import { createApi, type Api } from '../api/client';
import { refreshSnapshot } from '../lib/data';
import { refreshDiscovery } from '../lib/discovery';
import { ext, TARGET } from '../lib/ext';
import { t } from '../lib/i18n';
import type { BackgroundMessage } from '../lib/messages';
import { isSavableUrl } from '../lib/server-url';
import {
  apiConfig,
  CONFIG_KEY,
  DEFAULT_CONFIG,
  hasAccessToken,
  isConfigured,
  loadConfig,
  type Config,
  type StorageAreaLike,
} from '../lib/storage';
import { UrlCache, urlKey } from '../lib/url-cache';
import { applyBadge, errorBadge, lookupBadge, type BadgeView } from './badge';
import { handleCommand } from './commands';
import { LOOKUP_TTL_MS, LookupService, type LookupSummary } from './lookup';
import { handleMenuClick, installMenus, type MenuClickInfo, type MenusApi } from './menus';
import { OmniboxController, type Disposition } from './omnibox';
import { saveToDefault, type SaveDeps, type SaveRequest } from './save';

const local = ext.storage.local as unknown as StorageAreaLike;
const session = ext.storage.session as unknown as StorageAreaLike | undefined;
const ALARM = 'shelfmark-refresh';

async function services(): Promise<{ api: Api; config: Config } | null> {
  const config = await loadConfig(local);
  if (!isConfigured(config)) return null;
  return { config, api: createApi(apiConfig(config)) };
}

const getApi = async () => (await services())?.api ?? null;

const lookups = new LookupService(
  new UrlCache<LookupSummary>({ ttlMs: LOOKUP_TTL_MS, area: session, storageKey: 'lookupCache' }),
  getApi,
);

const badge = (tabId: number, view: BadgeView) => applyBadge(ext.action, tabId, view);

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await ext.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

async function refreshTab(tabId: number, url?: string): Promise<void> {
  url ??= await tabUrl(tabId);
  const svc = isSavableUrl(url) ? await services() : null;
  if (!svc || !url) {
    await badge(tabId, lookupBadge(null, t));
    return;
  }
  let view: BadgeView;
  try {
    view = lookupBadge(await lookups.get(url), t);
  } catch (err) {
    view = errorBadge(err, t, { accessTokenSet: hasAccessToken(svc.config) });
  }
  // The tab may have navigated while the lookup was running.
  const now = await tabUrl(tabId);
  if (now && urlKey(now) === urlKey(url)) await badge(tabId, view);
}

async function refreshActiveTabs(): Promise<void> {
  const tabs = await ext.tabs.query({ active: true });
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? undefined : refreshTab(tab.id, tab.url))));
}

async function activeTab() {
  const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

const saveDeps: SaveDeps = {
  services,
  lookups,
  badge,
  refreshTab: (tabId) => refreshTab(tabId),
  openOptions: () => ext.runtime.openOptionsPage(),
  t,
  later: (fn, ms) => void setTimeout(fn, ms),
};
const save = (req: SaveRequest) => saveToDefault(saveDeps, req);

/** Keep the offline copy used by the new tab page and popup reasonably fresh. */
async function prefetch(): Promise<void> {
  const svc = await services();
  if (!svc) return;
  try {
    const snapshot = await refreshSnapshot(svc.api, local);
    await refreshDiscovery(svc.api, local, snapshot);
  } catch {
    // offline or blocked; the pages show their own errors
  }
}

async function setup(): Promise<void> {
  await installMenus(ext.contextMenus as unknown as MenusApi, t, () => ext.runtime.lastError);
  if (!(await ext.alarms.get(ALARM))) await ext.alarms.create(ALARM, { periodInMinutes: 30, delayInMinutes: 1 });
}

// Listeners are registered synchronously at top level so events wake the worker.

ext.runtime.onInstalled.addListener(async (details) => {
  await setup();
  if (details.reason === 'install' && !isConfigured(await loadConfig(local))) await ext.runtime.openOptionsPage();
});

ext.runtime.onStartup.addListener(() => void setup());

ext.tabs.onActivated.addListener(({ tabId }) => void refreshTab(tabId));

ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') void refreshTab(tabId, tab.url);
});

ext.contextMenus.onClicked.addListener((info, tab) => void handleMenuClick(info as MenuClickInfo, tab, save));

ext.commands.onCommand.addListener((command, tab) => void handleCommand(command, tab, { activeTab, save }));

const omnibox = new OmniboxController({
  getApi,
  target: TARGET,
  t,
  setDefault: (description) => ext.omnibox.setDefaultSuggestion({ description }),
  openUrl: async (url: string, disposition: Disposition) => {
    if (disposition === 'currentTab') {
      const tab = await activeTab();
      if (tab?.id !== undefined) {
        await ext.tabs.update(tab.id, { url });
        return;
      }
    }
    await ext.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
  },
});
ext.omnibox.onInputStarted.addListener(() => omnibox.onInputStarted());
ext.omnibox.onInputChanged.addListener((text, suggest) => void omnibox.onInputChanged(text, suggest));
ext.omnibox.onInputEntered.addListener((text, disposition) => void omnibox.onInputEntered(text, disposition));

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void prefetch();
});

ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[CONFIG_KEY]) return;
  const before: Config = { ...DEFAULT_CONFIG, ...(changes[CONFIG_KEY].oldValue as Partial<Config> | undefined) };
  const after: Config = { ...DEFAULT_CONFIG, ...(changes[CONFIG_KEY].newValue as Partial<Config> | undefined) };
  const keys: (keyof Config)[] = ['serverUrl', 'token', 'username', 'accessClientId', 'accessClientSecret'];
  if (!keys.some((k) => before[k] !== after[k])) return;
  void (async () => {
    await lookups.clear();
    await refreshActiveTabs();
    if (isConfigured(after)) await prefetch();
  })();
});

ext.runtime.onMessage.addListener((raw: unknown, sender) => {
  if (sender.id !== ext.runtime.id) return false;
  const msg = raw as BackgroundMessage;
  if (msg.type === 'lookup-updated') {
    void lookups.put(msg.url, msg.summary).then(async () => {
      const tabs = await ext.tabs.query({});
      const key = urlKey(msg.url);
      await Promise.all(
        tabs
          .filter((tab) => tab.id !== undefined && tab.url && urlKey(tab.url) === key)
          .map((tab) => badge(tab.id!, lookupBadge(msg.summary, t))),
      );
    });
  } else if (msg.type === 'refresh-badges') {
    void lookups.clear().then(refreshActiveTabs);
  }
  return false;
});
