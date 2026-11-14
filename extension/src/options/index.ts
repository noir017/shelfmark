import { createApi, isApiError, type ApiConfig } from '../api/client';
import { cacheSettings, readSnapshot, refreshSnapshot, type Snapshot } from '../lib/data';
import { currentUaHints, deviceName } from '../lib/device';
import { byId, h, show } from '../lib/dom';
import { describeError } from '../lib/errors';
import { ext } from '../lib/ext';
import { localize, t } from '../lib/i18n';
import { normalizeServerUrl, originPattern } from '../lib/server-url';
import {
  apiConfig,
  hasAccessToken,
  isConfigured,
  loadConfig,
  saveConfig,
  type Config,
  type StorageAreaLike,
} from '../lib/storage';
import { snapshotTargets, targetKey, type Target } from '../lib/targets';

const area = ext.storage.local as unknown as StorageAreaLike;

const el = {
  server: byId<HTMLInputElement>('server-url'),
  accessBox: byId<HTMLDetailsElement>('access-box'),
  accessId: byId<HTMLInputElement>('access-id'),
  accessSecret: byId<HTMLInputElement>('access-secret'),
  modePassword: byId<HTMLButtonElement>('mode-password'),
  modeToken: byId<HTMLButtonElement>('mode-token'),
  passwordForm: byId<HTMLFormElement>('password-form'),
  tokenForm: byId<HTMLFormElement>('token-form'),
  username: byId<HTMLInputElement>('username'),
  password: byId<HTMLInputElement>('password'),
  device: byId<HTMLInputElement>('device-name'),
  token: byId<HTMLInputElement>('token'),
  conn: byId('conn-status'),
  testBtn: byId<HTMLButtonElement>('test-btn'),
  logoutBtn: byId<HTMLButtonElement>('logout-btn'),
  defaultSave: byId<HTMLSelectElement>('default-save'),
  defaultSaveMsg: byId('default-save-msg'),
  newtab: byId<HTMLInputElement>('newtab-toggle'),
  newtabMsg: byId('newtab-msg'),
  shortcut: byId('shortcut'),
};

let config: Config;
let targets: Target[] = [];

type Kind = 'info' | 'ok' | 'error';

function say(target: HTMLElement, text: string, kind: Kind = 'info'): void {
  target.dataset.kind = kind;
  target.textContent = text;
}

function accessFields(): Pick<Config, 'accessClientId' | 'accessClientSecret'> {
  return { accessClientId: el.accessId.value.trim(), accessClientSecret: el.accessSecret.value.trim() };
}

function errorText(err: unknown): string {
  return describeError(err, t, { accessTokenSet: hasAccessToken(accessFields()) });
}

function readServer(): string | null {
  try {
    const url = normalizeServerUrl(el.server.value);
    el.server.value = url;
    return url;
  } catch {
    say(el.conn, t('errServerUrl'), 'error');
    el.server.focus();
    return null;
  }
}

/**
 * Ask for access to just this server. Must be the first await in a click handler:
 * Firefox only shows the prompt while the user gesture is still active.
 */
async function requestPermission(serverUrl: string): Promise<boolean> {
  try {
    const ok = await ext.permissions.request({ origins: [originPattern(serverUrl)] });
    if (!ok) say(el.conn, t('errPermissionDenied'), 'error');
    return ok;
  } catch (err) {
    say(el.conn, t('errPermissionDenied') + ` (${String(err)})`, 'error');
    return false;
  }
}

function setMode(mode: 'password' | 'token'): void {
  show(el.passwordForm, mode === 'password');
  show(el.tokenForm, mode === 'token');
  el.modePassword.setAttribute('aria-selected', String(mode === 'password'));
  el.modeToken.setAttribute('aria-selected', String(mode === 'token'));
}

function renderAccount(): void {
  el.logoutBtn.hidden = !isConfigured(config);
  el.defaultSave.disabled = !isConfigured(config);
  if (!isConfigured(config)) say(el.conn, t('connNotLoggedIn'));
}

async function afterLogin(previous: Config): Promise<void> {
  // Revoke the token this extension created before, now that a new one replaced it.
  if (previous.tokenId !== null && previous.token && previous.token !== config.token && previous.serverUrl === config.serverUrl) {
    await createApi(apiConfig(previous)).revokeToken(previous.tokenId).catch(() => undefined);
  }
  // Moved to another server: give up access to the old one.
  if (previous.serverUrl && originPattern(previous.serverUrl) !== originPattern(config.serverUrl)) {
    await ext.permissions.remove({ origins: [originPattern(previous.serverUrl)] }).catch(() => undefined);
  }
  renderAccount();
  await checkConnection(apiConfig(config));
  await loadDefaultSave();
}

async function onPasswordLogin(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const serverUrl = readServer();
  if (!serverUrl || !(await requestPermission(serverUrl))) return;
  const username = el.username.value.trim();
  const name = el.device.value.trim() || deviceName(t('devicePrefix'), currentUaHints());
  say(el.conn, t('connWorking'));
  try {
    const api = createApi({ serverUrl, ...accessFields() });
    const tok = await api.createToken(username, el.password.value, name);
    const previous = config;
    config = await saveConfig(area, { serverUrl, token: tok.token, tokenId: tok.id, username, ...accessFields() });
    el.password.value = '';
    await afterLogin(previous);
  } catch (err) {
    say(el.conn, isApiError(err, 'unauthorized') ? t('errLoginFailed') : errorText(err), 'error');
  }
}

async function onTokenSave(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const serverUrl = readServer();
  if (!serverUrl || !(await requestPermission(serverUrl))) return;
  const token = el.token.value.trim();
  if (!token) return;
  say(el.conn, t('connWorking'));
  try {
    const me = await createApi({ serverUrl, token, ...accessFields() }).me();
    const previous = config;
    config = await saveConfig(area, { serverUrl, token, tokenId: null, username: me.user.username, ...accessFields() });
    el.token.value = '';
    el.username.value = me.user.username;
    await afterLogin(previous);
  } catch (err) {
    say(el.conn, errorText(err), 'error');
  }
}

/** Server reachable? Token valid? Writes the outcome to the status line. */
async function checkConnection(cfg: ApiConfig): Promise<boolean> {
  const api = createApi(cfg);
  try {
    const info = await api.systemInfo();
    if (!cfg.token) {
      say(el.conn, t('connServerOnly', [info.version]), 'ok');
      return true;
    }
    const me = await api.me();
    say(el.conn, t('connOk', [me.user.username, info.version]), 'ok');
    return true;
  } catch (err) {
    say(el.conn, errorText(err), 'error');
    return false;
  }
}

async function onTest(): Promise<void> {
  const serverUrl = readServer();
  if (!serverUrl || !(await requestPermission(serverUrl))) return;
  config = await saveConfig(area, accessFields());
  say(el.conn, t('connWorking'));
  const token = serverUrl === config.serverUrl ? config.token : undefined;
  await checkConnection({ serverUrl, token, ...accessFields() });
}

async function onLogout(): Promise<void> {
  if (config.tokenId !== null && config.token) {
    await createApi(apiConfig(config)).revokeToken(config.tokenId).catch(() => undefined);
  }
  config = await saveConfig(area, { token: '', tokenId: null, username: '' });
  targets = [];
  el.defaultSave.replaceChildren(h('option', { value: '' }, t('defaultSaveServer')));
  renderAccount();
}

function fillDefaultSave(snap: Snapshot): void {
  targets = snapshotTargets(snap);
  const groups = snap.libraries.map((lib) =>
    h(
      'optgroup',
      { label: lib.name },
      targets
        .filter((tg) => tg.library === lib.slug)
        .map((tg) =>
          h(
            'option',
            { value: targetKey(tg) },
            tg.path.length ? '  '.repeat(tg.path.length - 1) + tg.path[tg.path.length - 1] : `${lib.name} /`,
          ),
        ),
    ),
  );
  el.defaultSave.replaceChildren(h('option', { value: '' }, t('defaultSaveServer')), ...groups);
  const current = snap.settings?.defaultSave;
  el.defaultSave.value = current && targets.some((tg) => targetKey(tg) === targetKey(current)) ? targetKey(current) : '';
}

async function loadDefaultSave(): Promise<void> {
  if (!isConfigured(config)) return;
  const cached = await readSnapshot(area);
  if (cached) fillDefaultSave(cached);
  try {
    fillDefaultSave(await refreshSnapshot(createApi(apiConfig(config)), area));
    say(el.defaultSaveMsg, '');
  } catch (err) {
    if (!cached) say(el.defaultSaveMsg, errorText(err), 'error');
  }
}

async function onDefaultSaveChange(): Promise<void> {
  const target = targets.find((tg) => targetKey(tg) === el.defaultSave.value) ?? null;
  try {
    const settings = await createApi(apiConfig(config)).updateSettings({
      defaultSave: target ? { library: target.library, folderId: target.folderId } : null,
    });
    await cacheSettings(area, settings);
    say(el.defaultSaveMsg, t('saved'), 'ok');
  } catch (err) {
    say(el.defaultSaveMsg, errorText(err), 'error');
  }
}

async function showShortcut(): Promise<void> {
  try {
    const cmds = await ext.commands.getAll();
    const key = cmds.find((c) => c.name === 'save-page')?.shortcut;
    el.shortcut.textContent = key || t('shortcutUnset');
  } catch {
    el.shortcut.textContent = 'Alt+Shift+S';
  }
}

async function main(): Promise<void> {
  localize();
  config = await loadConfig(area);
  el.server.value = config.serverUrl;
  el.accessId.value = config.accessClientId;
  el.accessSecret.value = config.accessClientSecret;
  el.accessBox.open = hasAccessToken(config);
  el.username.value = config.username;
  el.device.value = deviceName(t('devicePrefix'), currentUaHints());
  el.newtab.checked = config.newTabBookmarks;
  setMode('password');
  renderAccount();

  el.modePassword.addEventListener('click', () => setMode('password'));
  el.modeToken.addEventListener('click', () => setMode('token'));
  el.passwordForm.addEventListener('submit', (e) => void onPasswordLogin(e));
  el.tokenForm.addEventListener('submit', (e) => void onTokenSave(e));
  el.testBtn.addEventListener('click', () => void onTest());
  el.logoutBtn.addEventListener('click', () => void onLogout());
  for (const input of [el.accessId, el.accessSecret]) {
    input.addEventListener('change', () => void saveConfig(area, accessFields()).then((c) => (config = c)));
  }
  el.defaultSave.addEventListener('change', () => void onDefaultSaveChange());
  el.newtab.addEventListener('change', async () => {
    config = await saveConfig(area, { newTabBookmarks: el.newtab.checked });
    say(el.newtabMsg, t('saved'), 'ok');
  });

  void showShortcut();
  if (isConfigured(config)) {
    void checkConnection(apiConfig(config));
    void loadDefaultSave();
  }
}

void main();
