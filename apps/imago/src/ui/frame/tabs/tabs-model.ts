import type { Stage } from '../stage/stage';

/**
 * One open tab (SPEC v3.3 tab bar), browser-style as in classic: whatever fills the middle,
 * at its imago path, with its own Back and Forward. Its title and type icon are read from
 * the page API when it renders, never stored (DEC-C6).
 */
export type Tab = {
  readonly id: string;
  readonly path: string;
  /** The places this tab showed before `path`, oldest first. */
  readonly back: readonly string[];
  /** The places Back left behind, nearest first. */
  readonly forward: readonly string[];
};

/** How many places a tab remembers each way. */
export const TAB_HISTORY_LIMIT = 50;

export const newTab = (id: string, path: string): Tab => ({ id, path, back: [], forward: [] });

/** The middle's object is a tab; the chat, a section index or the empty middle are not. */
export const tabPathFor = (stage: Stage, pathname: string): string | null => (stage.object === null ? null : pathname);

/** The open tabs and the one the viewer is in (its id). */
export type TabStrip = { readonly tabs: readonly Tab[]; readonly active: string | null };

export const activeTabOf = (strip: TabStrip): Tab | null => strip.tabs.find((tab) => tab.id === strip.active) ?? null;

/** Inserts a tab just after the active one, or after the last when none is active. */
const insertBeside = (strip: TabStrip, tab: Tab): readonly Tab[] => {
  const at = strip.tabs.findIndex((entry) => entry.id === strip.active);
  return at < 0 ? [...strip.tabs, tab] : [...strip.tabs.slice(0, at + 1), tab, ...strip.tabs.slice(at + 1)];
};

const replaceTab = (tabs: readonly Tab[], tab: Tab): readonly Tab[] => tabs.map((entry) => (entry.id === tab.id ? tab : entry));

/** A new step in a tab: the current place goes on its Back list and Forward is dropped. */
export const visitInTab = (tab: Tab, path: string): Tab =>
  path === tab.path ? tab : { ...tab, path, back: [...tab.back, tab.path].slice(-TAB_HISTORY_LIMIT), forward: [] };

/**
 * A navigation to a tab's object, as browser tabs (and classic) work: it loads into the active
 * tab as a new step in that tab's history. With no active tab (first load, or after it closed)
 * the viewer's tab for that page is picked up again, else one opens; New tab always opens one,
 * beside the active tab. `id` names the tab if one opens.
 */
export const navigateTabs = (strip: TabStrip, path: string, id: string, inNewTab = false): TabStrip => {
  const active = activeTabOf(strip);
  if (active !== null && !inNewTab) {
    const next = visitInTab(active, path);
    return next === active ? strip : { tabs: replaceTab(strip.tabs, next), active: active.id };
  }
  if (active === null && !inNewTab) {
    const open = strip.tabs.find((tab) => tab.path === path);
    if (open !== undefined) return { tabs: strip.tabs, active: open.id };
  }
  return { tabs: insertBeside(strip, newTab(id, path)), active: id };
};

/** Opens a tab without leaving the current one (⌘/Ctrl-click, middle-click), beside the active tab. */
export const openTabInBackground = (strip: TabStrip, path: string, id: string): TabStrip => ({
  tabs: insertBeside(strip, newTab(id, path)),
  active: strip.active,
});

/** Back or Forward one step in a tab; null when there is nowhere to go. */
export const stepTab = (tab: Tab, direction: 'back' | 'forward'): Tab | null => {
  if (direction === 'back') {
    const previous = tab.back.at(-1);
    return previous === undefined
      ? null
      : { ...tab, path: previous, back: tab.back.slice(0, -1), forward: [tab.path, ...tab.forward].slice(0, TAB_HISTORY_LIMIT) };
  }
  const [next, ...rest] = tab.forward;
  return next === undefined ? null : { ...tab, path: next, back: [...tab.back, tab.path].slice(-TAB_HISTORY_LIMIT), forward: rest };
};

/** Which way the browser's own Back or Forward went; null when the browser cannot say. */
export type PopDirection = 'back' | 'forward' | null;

/** The direction between two history positions (the Navigation API's entry index), if known. */
export const popDirection = (from: number | null, to: number | null): PopDirection =>
  from === null || to === null || from === to ? null : to < from ? 'back' : 'forward';

/**
 * The browser's own Back or Forward (popstate) landed on `path`: move the tab to that place in
 * its history rather than adding a step. The direction picks the side to look in, so a page
 * visited twice resolves to the right visit; without one, the nearer match wins (Back on a tie).
 * Null when the place is not in the tab's history that way.
 */
export const rewindTab = (tab: Tab, path: string, direction: PopDirection = null): Tab | null => {
  if (path === tab.path) return tab;
  const back = direction === 'forward' ? -1 : tab.back.lastIndexOf(path);
  const forward = direction === 'back' ? -1 : tab.forward.indexOf(path);
  const backSteps = back < 0 ? Infinity : tab.back.length - back;
  const forwardSteps = forward < 0 ? Infinity : forward + 1;
  if (backSteps === Infinity && forwardSteps === Infinity) return null;
  if (backSteps <= forwardSteps) {
    return {
      ...tab,
      path,
      back: tab.back.slice(0, back),
      forward: [...tab.back.slice(back + 1), tab.path, ...tab.forward].slice(0, TAB_HISTORY_LIMIT),
    };
  }
  return {
    ...tab,
    path,
    back: [...tab.back, tab.path, ...tab.forward.slice(0, forward)].slice(-TAB_HISTORY_LIMIT),
    forward: tab.forward.slice(forward + 1),
  };
};

/**
 * Which tab is active when a drive's tabs are loaded: the stored active tab if it shows this
 * page, else a tab that does, else the stored active tab (the page then loads into it).
 */
export const restoreActive = (strip: TabStrip, path: string | null): TabStrip => {
  const stored = activeTabOf(strip);
  if (path === null || stored?.path === path) return strip;
  const showing = strip.tabs.find((tab) => tab.path === path);
  return { tabs: strip.tabs, active: showing?.id ?? stored?.id ?? null };
};

/**
 * Closes a tab. Closing the active one moves to its right neighbour, else its left; closing
 * the last tab leaves nothing to show (`next` null).
 */
export const closeTab = (strip: TabStrip, id: string): { readonly tabs: readonly Tab[]; readonly next: Tab | null } => {
  const index = strip.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs: strip.tabs, next: null };
  const rest = strip.tabs.filter((_, at) => at !== index);
  if (id !== strip.active) return { tabs: rest, next: null };
  return { tabs: rest, next: rest[index] ?? rest[index - 1] ?? null };
};

/**
 * Where Close page goes: the section the page belongs to, so the tabs stay and Imago becomes
 * the ground (SPEC v3.3). Drive tools and settings go to the drive's chat, the account and
 * DMs to their own roots.
 */
export const sectionPath = (stage: Stage): string => {
  if (stage.driveId === null) return stage.section === 'messages' ? '/dm' : '/';
  const drive = `/${encodeURIComponent(stage.driveId)}`;
  return stage.section === 'files' || stage.section === 'messages' || stage.section === 'tasks'
    ? `${drive}/${stage.section}`
    : drive;
};

const isImagoPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');

const pathsOf = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter(isImagoPath) : []);

const parseTabList = (value: unknown): readonly Tab[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown, index): Tab[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, path, back, forward } = entry as { id?: unknown; path?: unknown; back?: unknown; forward?: unknown };
    if (!isImagoPath(path)) return [];
    const tabId = typeof id === 'string' && id !== '' && !seen.has(id) ? id : `stored-${index}`;
    seen.add(tabId);
    return [{ id: tabId, path, back: pathsOf(back).slice(-TAB_HISTORY_LIMIT), forward: pathsOf(forward).slice(0, TAB_HISTORY_LIMIT) }];
  });
};

/**
 * Stored tabs, as written by the tab bar ({ tabs, active }): anything that is not an imago path
 * is dropped. Tabs stored before they had ids, history or a saved active tab (a bare list) get
 * them here.
 */
export const parseTabs = (stored: string | null): TabStrip => {
  if (stored === null) return { tabs: [], active: null };
  try {
    const value: unknown = JSON.parse(stored);
    if (Array.isArray(value)) return { tabs: parseTabList(value), active: null };
    if (typeof value !== 'object' || value === null) return { tabs: [], active: null };
    const { tabs, active } = value as { tabs?: unknown; active?: unknown };
    const list = parseTabList(tabs);
    return { tabs: list, active: typeof active === 'string' && list.some((tab) => tab.id === active) ? active : null };
  } catch {
    return { tabs: [], active: null };
  }
};

/** What the tab bar stores per drive. */
export const serializeTabs = (strip: TabStrip): string => JSON.stringify({ tabs: strip.tabs, active: strip.active });

/** imago's own storage key per drive, never classic's `tabs-storage` (DEC-C6). */
export const tabsStorageKey = (driveKey: string): string => `imago:tabs:${driveKey}`;

/** A fresh tab id (no crypto.randomUUID: it needs a secure context, which on-prem may not have). */
export const createTabId = (): string => `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** The modifier clicks that open a link in a new tab in a browser: ⌘/Ctrl-click and middle-click. */
export const isNewTabClick = (event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean =>
  !event.shiftKey && !event.altKey && (event.button === 1 || (event.button === 0 && (event.metaKey || event.ctrlKey)));

/**
 * The basePath-relative path a link points to inside imago, or null for anything else (another
 * origin, classic, a download).
 */
export const imagoPathOf = (href: string, origin: string, basePath: string): string | null => {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname === basePath) return '/';
  return url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : null;
};
