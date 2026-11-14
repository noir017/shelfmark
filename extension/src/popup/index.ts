import { createApi, type Api } from '../api/client';
import { summarize } from '../background/lookup';
import { readSnapshot, refreshSnapshot, type Snapshot } from '../lib/data';
import { byId, h, show } from '../lib/dom';
import { describeError, needsSettingsFix } from '../lib/errors';
import { ext } from '../lib/ext';
import { localize, t } from '../lib/i18n';
import type { BackgroundMessage } from '../lib/messages';
import { isSavableUrl } from '../lib/server-url';
import { apiConfig, hasAccessToken, isConfigured, loadConfig, type Config, type StorageAreaLike } from '../lib/storage';
import { addTag, formatTags, parseTags } from '../lib/tags';
import { findTarget, snapshotTargets, type Target } from '../lib/targets';
import type { AiSuggestion, ItemWithPath } from '../lib/types';
import { FolderPicker } from './folder-picker';

const area = ext.storage.local as unknown as StorageAreaLike;

type View = 'setup' | 'unsupported' | 'main';

function showView(view: View): void {
  for (const v of ['setup', 'unsupported', 'main'] as const) show(byId(`view-${v}`), v === view);
}

function openOptions(): void {
  void ext.runtime.openOptionsPage().then(() => window.close());
}

/** The tab to act on: `?tab=<id>` (detached popup, tests) or the active tab. */
async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const param = new URLSearchParams(location.search).get('tab');
  if (param) {
    try {
      return await ext.tabs.get(Number(param));
    } catch {
      return undefined;
    }
  }
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

class Popup {
  private readonly api: Api;
  private readonly config: Config;
  private readonly url: string;
  private readonly pageTitle: string;
  private snapshot: Snapshot | null = null;
  private targets: Target[] = [];
  private matches: ItemWithPath[] = [];
  private current: ItemWithPath | null = null;
  private userPicked = false;
  private busy = false;
  private deleteArmed = false;
  private lookupOk = false;

  private readonly status = byId('status');
  private readonly locations = byId<HTMLUListElement>('locations');
  private readonly form = byId<HTMLFormElement>('form');
  private readonly titleInput = byId<HTMLInputElement>('f-title');
  private readonly tagsInput = byId<HTMLInputElement>('f-tags');
  private readonly notesInput = byId<HTMLTextAreaElement>('f-notes');
  private readonly saveBtn = byId<HTMLButtonElement>('save-btn');
  private readonly deleteBtn = byId<HTMLButtonElement>('delete-btn');
  private readonly aiBox = byId('ai');
  private readonly aiBtn = byId<HTMLButtonElement>('ai-btn');
  private readonly aiResult = byId('ai-result');
  private readonly message = byId('message');
  private readonly picker: FolderPicker;

  constructor(api: Api, config: Config, tab: chrome.tabs.Tab & { url: string }) {
    this.api = api;
    this.config = config;
    this.url = tab.url;
    this.pageTitle = tab.title ?? '';
    this.picker = new FolderPicker({ t, allowDefault: true, onChange: () => (this.userPicked = true) });
    byId('picker').replaceChildren(this.picker.el);
    byId('page-url').textContent = this.url;
    this.titleInput.value = this.pageTitle;
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.deleteBtn.addEventListener('click', () => void this.remove());
    this.aiBtn.addEventListener('click', () => void this.suggest());
  }

  async start(): Promise<void> {
    showView('main');
    this.setStatus('checking');
    this.renderButtons();
    const cached = await readSnapshot(area);
    if (cached) this.applySnapshot(cached);
    const lookup = this.api.lookup(this.url);
    const refresh = refreshSnapshot(this.api, area);
    const ai = this.api.aiStatus().catch(() => null);
    try {
      this.lookupOk = true;
      this.setMatches((await lookup).matches);
      this.notifyBackground();
    } catch (err) {
      this.lookupOk = false;
      this.showError(err);
      this.setStatus('error');
    }
    this.renderButtons();
    try {
      this.applySnapshot(await refresh);
    } catch {
      // keep cached folders; lookup error (if any) is already shown
    }
    show(this.aiBox, Boolean((await ai)?.enabled) && this.lookupOk);
  }

  private libraryName(slug: string): string {
    return this.snapshot?.libraries.find((l) => l.slug === slug)?.name ?? slug;
  }

  private matchLabel(m: ItemWithPath): string {
    return [this.libraryName(m.library), ...m.path].join(' / ');
  }

  private applySnapshot(s: Snapshot): void {
    this.snapshot = s;
    this.targets = snapshotTargets(s);
    this.picker.setData(this.targets, s.settings?.recentSaveTargets ?? []);
    if (!this.userPicked) this.picker.setSelected(this.defaultTarget());
    if (this.current) this.renderLocations();
  }

  /** Where the form points when nothing was picked: the item's folder, else the configured default. */
  private defaultTarget(): Target | null {
    if (this.current) return this.targetOf(this.current);
    return findTarget(this.targets, this.snapshot?.settings?.defaultSave ?? null);
  }

  private targetOf(m: ItemWithPath): Target {
    const found = findTarget(this.targets, { library: m.library, folderId: m.item.parentId });
    return found ?? { library: m.library, libraryName: this.libraryName(m.library), folderId: m.item.parentId, path: m.path };
  }

  private setMatches(matches: ItemWithPath[], select?: ItemWithPath): void {
    this.matches = matches;
    this.current = select ?? matches[0] ?? null;
    this.deleteArmed = false;
    if (this.current) {
      const it = this.current.item;
      this.titleInput.value = it.title;
      this.tagsInput.value = formatTags(it.tags);
      this.notesInput.value = it.notes ?? '';
      this.userPicked = false;
      this.picker.setSelected(this.targetOf(this.current));
      this.setStatus('saved');
    } else {
      this.picker.setSelected(this.userPicked ? this.picker.value : this.defaultTarget());
      this.setStatus('unsaved');
    }
    this.renderLocations();
    this.renderButtons();
  }

  private renderLocations(): void {
    const items = this.matches.map((m) =>
      h(
        'li',
        null,
        this.matches.length > 1
          ? h(
              'button',
              {
                type: 'button',
                class: `link${m === this.current ? ' current' : ''}`,
                onClick: () => this.setMatches(this.matches, m),
              },
              this.matchLabel(m),
            )
          : this.matchLabel(m),
      ),
    );
    this.locations.replaceChildren(...items);
    show(this.locations, items.length > 0);
  }

  private setStatus(state: 'checking' | 'saved' | 'unsaved' | 'error'): void {
    this.status.dataset.state = state;
    const text = { checking: 'popupChecking', saved: 'popupSaved', unsaved: 'popupNotSaved', error: 'popupError' }[state];
    this.status.textContent = t(text);
  }

  private renderButtons(): void {
    this.saveBtn.textContent = t(this.current ? 'popupUpdate' : 'popupSave');
    this.saveBtn.disabled = this.busy || !this.lookupOk;
    show(this.deleteBtn, Boolean(this.current));
    this.deleteBtn.disabled = this.busy;
    this.deleteBtn.textContent = t(this.deleteArmed ? 'popupDeleteConfirm' : 'popupDelete');
  }

  private say(text: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
    this.message.dataset.kind = kind;
    this.message.replaceChildren(
      text,
      ...(action ? [' ', h('button', { type: 'button', class: 'link', onClick: action.run }, action.label)] : []),
    );
  }

  private showError(err: unknown): void {
    const text = describeError(err, t, { accessTokenSet: hasAccessToken(this.config) });
    this.say(text, 'error', needsSettingsFix(err) ? { label: t('openSettings'), run: openOptions } : undefined);
  }

  private async withBusy(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.renderButtons();
    try {
      await fn();
    } catch (err) {
      this.showError(err);
    } finally {
      this.busy = false;
      this.renderButtons();
    }
  }

  private formValues() {
    return {
      title: this.titleInput.value.trim(),
      tags: parseTags(this.tagsInput.value),
      notes: this.notesInput.value.trim(),
    };
  }

  private notifyBackground(): void {
    const msg: BackgroundMessage = { type: 'lookup-updated', url: this.url, summary: summarize({ matches: this.matches }) };
    void ext.runtime.sendMessage(msg).catch(() => undefined);
  }

  private submit(): Promise<void> {
    return this.withBusy(async () => {
      this.say(t('popupWorking'));
      const v = this.formValues();
      const target = this.picker.value;
      if (!this.current) {
        const { result, created } = await this.api.quickSave({
          url: this.url,
          ...(v.title ? { title: v.title } : {}),
          ...(v.notes ? { notes: v.notes } : {}),
          ...(v.tags.length ? { tags: v.tags } : {}),
          ...(target ? { library: target.library, parentId: target.folderId } : {}),
        });
        const saved: ItemWithPath = { library: result.library, item: result.item, path: result.path };
        this.setMatches([saved, ...this.matches], saved);
        this.say(created ? t('popupSavedTo', [this.matchLabel(saved)]) : t('popupExisted', [this.matchLabel(saved)]));
      } else {
        const cur = this.current;
        const dest = target ?? this.targetOf(cur);
        const moving = dest.library !== cur.library || dest.folderId !== cur.item.parentId;
        const r = await this.api.updateItem(cur.library, cur.item.id, {
          title: v.title,
          notes: v.notes || null,
          tags: v.tags,
          ...(dest.library === cur.library && moving ? { parentId: dest.folderId } : {}),
        });
        let updated: ItemWithPath = { library: cur.library, item: r.item, path: moving ? dest.path : cur.path };
        if (dest.library !== cur.library) {
          const moved = await this.api.transferItem(cur.library, cur.item.id, { library: dest.library, parentId: dest.folderId });
          updated = { library: dest.library, item: moved.item, path: dest.path };
        }
        this.setMatches(
          this.matches.map((m) => (m === cur ? updated : m)),
          updated,
        );
        this.say(t('popupUpdated'));
      }
      this.notifyBackground();
    });
  }

  private remove(): Promise<void> {
    if (!this.current) return Promise.resolve();
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      this.renderButtons();
      setTimeout(() => {
        this.deleteArmed = false;
        this.renderButtons();
      }, 4000);
      return Promise.resolve();
    }
    return this.withBusy(async () => {
      const cur = this.current!;
      await this.api.deleteItem(cur.library, cur.item.id);
      this.setMatches(this.matches.filter((m) => m !== cur));
      this.say(t('popupDeleted'));
      this.notifyBackground();
    });
  }

  private suggest(): Promise<void> {
    return this.withBusy(async () => {
      const library =
        this.picker.value?.library ?? this.current?.library ?? this.snapshot?.settings?.defaultSave?.library ?? this.snapshot?.libraries[0]?.slug;
      if (!library) return;
      this.aiResult.replaceChildren(h('span', { class: 'muted' }, t('popupAiWorking')));
      const s = await this.api.aiSuggest({ library, url: this.url, title: this.titleInput.value.trim() || this.pageTitle });
      this.renderSuggestion(library, s);
    });
  }

  private renderSuggestion(library: string, s: AiSuggestion): void {
    const chips: HTMLElement[] = [];
    if (s.title) {
      const title = s.title;
      chips.push(
        h('button', { type: 'button', class: 'chip chip-title', title: t('popupAiUseTitle'), onClick: () => (this.titleInput.value = title) }, title),
      );
    }
    for (const f of s.folders) {
      const target =
        findTarget(this.targets, { library, folderId: f.folderId }) ??
        ({ library, libraryName: this.libraryName(library), folderId: f.folderId, path: f.path } satisfies Target);
      chips.push(
        h(
          'button',
          {
            type: 'button',
            class: 'chip chip-folder',
            title: `${Math.round(f.score * 100)}%`,
            onClick: () => {
              this.userPicked = true;
              this.picker.setSelected(target);
            },
          },
          f.path.join(' / ') || this.libraryName(library),
        ),
      );
    }
    for (const tag of s.tags) {
      chips.push(
        h('button', { type: 'button', class: 'chip', onClick: () => (this.tagsInput.value = addTag(this.tagsInput.value, tag)) }, `#${tag}`),
      );
    }
    this.aiResult.replaceChildren(...(chips.length ? chips : [h('span', { class: 'muted' }, t('popupAiEmpty'))]));
  }
}

async function main(): Promise<void> {
  localize();
  byId('open-options').addEventListener('click', openOptions);
  byId('setup-btn').addEventListener('click', openOptions);
  const config = await loadConfig(area);
  if (!isConfigured(config)) return showView('setup');
  const tab = await targetTab();
  if (!tab || !isSavableUrl(tab.url)) return showView('unsupported');
  const popup = new Popup(createApi(apiConfig(config)), config, tab as chrome.tabs.Tab & { url: string });
  await popup.start();
}

void main();
