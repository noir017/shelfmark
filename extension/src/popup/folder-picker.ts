import { h } from '../lib/dom';
import type { Translate } from '../lib/i18n';
import { filterTargets, orderTargets, targetKey, targetLabel, type Target } from '../lib/targets';
import type { SaveTarget } from '../lib/types';

export interface PickerOptions {
  t: Translate;
  /** Offer a "server default location" entry (value null). */
  allowDefault: boolean;
  onChange(target: Target | null): void;
}

const MAX_OPTIONS = 300;

interface Option {
  key: string;
  label: string;
  target: Target | null;
}

/** Searchable folder dropdown with recently used folders on top. */
export class FolderPicker {
  readonly el: HTMLElement;
  private readonly opts: PickerOptions;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly panel: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private targets: Target[] = [];
  private recent: SaveTarget[] = [];
  private selected: Target | null = null;
  private options: Option[] = [];
  private active = 0;

  constructor(opts: PickerOptions) {
    this.opts = opts;
    const { t } = opts;
    this.label = h('span', { class: 'picker-label' });
    this.button = h(
      'button',
      { type: 'button', class: 'picker-button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', id: 'picker-button' },
      this.label,
      h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
    );
    this.search = h('input', {
      type: 'search',
      class: 'picker-search',
      placeholder: t('pickerSearch'),
      autocomplete: 'off',
      'aria-label': t('pickerSearch'),
    });
    this.list = h('ul', { class: 'picker-list', role: 'listbox', id: 'picker-list' });
    this.panel = h('div', { class: 'picker-panel', hidden: true }, this.search, this.list);
    this.el = h('div', { class: 'picker' }, this.button, this.panel);

    this.button.addEventListener('click', () => (this.panel.hidden ? this.open() : this.close()));
    this.search.addEventListener('input', () => {
      this.active = 0;
      this.renderList();
    });
    this.search.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
    document.addEventListener('mousedown', (e) => {
      if (!this.el.contains(e.target as Node)) this.close();
    });
    this.renderLabel();
  }

  setData(targets: Target[], recent: SaveTarget[]): void {
    this.targets = targets;
    this.recent = recent;
    // Re-resolve the selection so labels pick up renamed folders.
    if (this.selected) {
      const key = targetKey(this.selected);
      this.selected = targets.find((t) => targetKey(t) === key) ?? this.selected;
    }
    this.renderLabel();
    if (!this.panel.hidden) this.renderList();
  }

  get value(): Target | null {
    return this.selected;
  }

  setSelected(target: Target | null, notify = false): void {
    this.selected = target;
    this.renderLabel();
    if (notify) this.opts.onChange(target);
  }

  open(): void {
    this.panel.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this.active = 0;
    this.renderList();
    this.search.focus();
  }

  close(): void {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }

  private multiLibrary(): boolean {
    return new Set(this.targets.map((t) => t.library)).size > 1;
  }

  private labelFor(target: Target | null): string {
    return target ? targetLabel(target, this.multiLibrary()) : this.opts.t('pickerDefault');
  }

  private renderLabel(): void {
    this.label.textContent = this.labelFor(this.selected);
    this.button.title = this.label.textContent;
  }

  private buildOptions(query: string): { groups: { title: string; options: Option[] }[]; truncated: boolean } {
    const { t } = this.opts;
    const filtered = filterTargets(this.targets, query);
    const { recent, others } = orderTargets(filtered, this.recent);
    const toOption = (target: Target): Option => ({ key: targetKey(target), label: this.labelFor(target), target });
    const groups: { title: string; options: Option[] }[] = [];
    const first: Option[] = [];
    if (this.opts.allowDefault && !query.trim()) first.push({ key: '', label: t('pickerDefault'), target: null });
    if (first.length) groups.push({ title: '', options: first });
    if (recent.length) groups.push({ title: t('pickerRecent'), options: recent.map(toOption) });
    const rest = others.slice(0, MAX_OPTIONS).map(toOption);
    if (rest.length) groups.push({ title: recent.length ? t('pickerAll') : '', options: rest });
    return { groups, truncated: others.length > MAX_OPTIONS };
  }

  private renderList(): void {
    const { groups, truncated } = this.buildOptions(this.search.value);
    this.options = groups.flatMap((g) => g.options);
    if (this.active >= this.options.length) this.active = Math.max(0, this.options.length - 1);
    const selectedKey = this.selected ? targetKey(this.selected) : '';
    const items: HTMLElement[] = [];
    let index = 0;
    for (const g of groups) {
      if (g.title) items.push(h('li', { class: 'picker-group', role: 'presentation' }, g.title));
      for (const o of g.options) {
        const i = index++;
        items.push(
          h(
            'li',
            {
              role: 'option',
              class: `picker-option${i === this.active ? ' active' : ''}`,
              'aria-selected': String(o.key === selectedKey),
              dataset: { key: o.key },
              onClick: () => this.choose(o),
            },
            o.label,
          ),
        );
      }
    }
    if (!this.options.length) items.push(h('li', { class: 'picker-empty' }, this.opts.t('pickerNoMatch')));
    if (truncated) items.push(h('li', { class: 'picker-empty' }, this.opts.t('pickerTruncated')));
    this.list.replaceChildren(...items);
    this.list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  private choose(o: Option): void {
    this.setSelected(o.target, true);
    this.close();
    this.button.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.options.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + delta + this.options.length) % this.options.length;
      this.renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = this.options[this.active];
      if (o) this.choose(o);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.button.focus();
    }
  }
}
