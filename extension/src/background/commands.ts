import type { TabLike } from './menus';
import type { SaveRequest } from './save';

/** Command name in manifest.json; bound to Alt+Shift+S by default. */
export const COMMAND_SAVE = 'save-page';

export interface CommandDeps {
  activeTab(): Promise<TabLike | undefined>;
  save(req: SaveRequest): Promise<unknown>;
}

/** Alt+Shift+S: save the active tab to the default location. */
export async function handleCommand(command: string, tab: TabLike | undefined, deps: CommandDeps): Promise<boolean> {
  if (command !== COMMAND_SAVE) return false;
  const target = tab?.id !== undefined && tab.url ? tab : await deps.activeTab();
  if (!target || target.id === undefined || !target.url) return false;
  await deps.save({ url: target.url, title: target.title, tabId: target.id });
  return true;
}
