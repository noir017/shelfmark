import { describe, expect, it, vi } from 'vitest';
import { COMMAND_SAVE, handleCommand } from '../../src/background/commands';
import { handleMenuClick, installMenus, menuItems, menuSaveRequest, MENU_SAVE_LINK, MENU_SAVE_PAGE, type MenuItem } from '../../src/background/menus';
import { tt } from '../helpers/memory-area';

const tab = { id: 7, url: 'https://page.example.com/a', title: 'Page A' };

describe('context menus', () => {
  it('defines "save page" and "save link" for web pages only', () => {
    const items = menuItems(tt);
    expect(items.map((i) => [i.id, i.title, i.contexts])).toEqual([
      [MENU_SAVE_PAGE, 'menuSavePage', ['page']],
      [MENU_SAVE_LINK, 'menuSaveLink', ['link']],
    ]);
    expect(items[0]!.documentUrlPatterns).toEqual(['http://*/*', 'https://*/*']);
    expect(items[1]!.targetUrlPatterns).toEqual(['http://*/*', 'https://*/*']);
  });

  it('installs from scratch each time', async () => {
    const calls: string[] = [];
    const menus = {
      removeAll: async () => void calls.push('removeAll'),
      create: (p: MenuItem, cb?: () => void) => {
        calls.push(`create:${p.id}`);
        cb?.();
      },
    };
    const lastError = vi.fn();
    await installMenus(menus, tt, lastError);
    expect(calls).toEqual(['removeAll', `create:${MENU_SAVE_PAGE}`, `create:${MENU_SAVE_LINK}`]);
    expect(lastError).toHaveBeenCalledTimes(2);
  });

  it('saves the page with the tab title', () => {
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_PAGE, pageUrl: 'https://frame.example.com/' }, tab)).toEqual({
      url: tab.url,
      title: 'Page A',
      tabId: 7,
    });
    // Falls back to pageUrl when the tab URL is not exposed.
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_PAGE, pageUrl: 'https://p.example.com/' }, { id: 1 })).toEqual({
      url: 'https://p.example.com/',
      title: undefined,
      tabId: 1,
    });
  });

  it('saves the link; title from Firefox linkText, else left to the server', () => {
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_LINK, linkUrl: 'https://l.example.com/', linkText: ' Link ' }, tab)).toEqual({
      url: 'https://l.example.com/',
      title: 'Link',
      tabId: 7,
    });
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_LINK, linkUrl: 'https://l.example.com/' }, tab)?.title).toBeUndefined();
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_LINK }, tab)).toBeNull();
  });

  it('ignores foreign items and tab-less clicks', async () => {
    expect(menuSaveRequest({ menuItemId: 'other' }, tab)).toBeNull();
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_PAGE, pageUrl: 'https://x/' }, { id: -1 })).toBeNull();
    expect(menuSaveRequest({ menuItemId: MENU_SAVE_PAGE, pageUrl: 'https://x/' }, undefined)).toBeNull();
    const save = vi.fn();
    expect(await handleMenuClick({ menuItemId: 'other' }, tab, save)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(await handleMenuClick({ menuItemId: MENU_SAVE_PAGE }, tab, save)).toBe(true);
    expect(save).toHaveBeenCalledWith({ url: tab.url, title: 'Page A', tabId: 7 });
  });
});

describe('keyboard shortcut', () => {
  it('saves the tab passed with the command', async () => {
    const save = vi.fn();
    const activeTab = vi.fn();
    expect(await handleCommand(COMMAND_SAVE, tab, { save, activeTab })).toBe(true);
    expect(save).toHaveBeenCalledWith({ url: tab.url, title: 'Page A', tabId: 7 });
    expect(activeTab).not.toHaveBeenCalled();
  });

  it('falls back to the active tab', async () => {
    const save = vi.fn();
    const activeTab = vi.fn(async () => tab);
    expect(await handleCommand(COMMAND_SAVE, undefined, { save, activeTab })).toBe(true);
    expect(save).toHaveBeenCalledWith({ url: tab.url, title: 'Page A', tabId: 7 });
  });

  it('does nothing for other commands or tabs without a URL', async () => {
    const save = vi.fn();
    expect(await handleCommand('_execute_action', tab, { save, activeTab: async () => tab })).toBe(false);
    expect(await handleCommand(COMMAND_SAVE, undefined, { save, activeTab: async () => ({ id: 3 }) })).toBe(false);
    expect(await handleCommand(COMMAND_SAVE, undefined, { save, activeTab: async () => undefined })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('the manifest binds the command to Alt+Shift+S', async () => {
    const { buildManifest } = await import('../../scripts/manifest.mjs');
    for (const target of ['chrome', 'firefox'] as const) {
      const m = buildManifest(target, '1.0.0') as { commands: Record<string, { suggested_key: { default: string } }> };
      expect(m.commands[COMMAND_SAVE]!.suggested_key.default).toBe('Alt+Shift+S');
    }
  });
});
