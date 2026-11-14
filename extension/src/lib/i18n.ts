import { ext } from './ext';

export type Translate = (key: string, subs?: string[]) => string;

export const t: Translate = (key, subs) => ext.i18n?.getMessage(key, subs) || key;

/** Fill `data-i18n`, `data-i18n-placeholder`, `data-i18n-title` and set <html lang>. */
export function localize(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]'))
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle!);
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.title);
  }
  const lang = ext.i18n?.getUILanguage?.();
  if (lang && root === document) document.documentElement.lang = lang;
}
