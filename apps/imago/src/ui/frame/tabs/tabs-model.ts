import type { Stage } from '../stage/stage';

/**
 * One open tab (SPEC v3.3 tab bar): whatever fills the middle, keyed by its imago path. Its
 * title and type icon are read from the page API when it renders, never stored (DEC-C6).
 */
export type Tab = { readonly path: string };

/** The middle's object is a tab; the chat, a section index or the empty middle are not. */
export const tabFor = (stage: Stage, pathname: string): Tab | null =>
  stage.object === null ? null : { path: pathname };

/** The open tabs and which of them the viewer is in (its path), as browser tabs work. */
export type TabStrip = { readonly tabs: readonly Tab[]; readonly active: string | null };

const indexOfPath = (tabs: readonly Tab[], path: string | null): number =>
  path === null ? -1 : tabs.findIndex((entry) => entry.path === path);

/** Inserts a tab just after the active one, or after the last when none is active. */
const insertBeside = (tabs: readonly Tab[], active: string | null, tab: Tab): readonly Tab[] => {
  const at = indexOfPath(tabs, active);
  return at < 0 ? [...tabs, tab] : [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)];
};

/**
 * A navigation to a tab's object, the way browser tabs (and classic) work: it loads into the
 * active tab, replacing what that tab showed. A page that already has a tab switches to it;
 * with no active tab, or when the viewer asked for a new one, it opens beside the active tab.
 */
export const navigateTabs = (strip: TabStrip, tab: Tab, inNewTab = false): TabStrip => {
  const { tabs, active } = strip;
  if (tabs.some((entry) => entry.path === tab.path)) return active === tab.path ? strip : { tabs, active: tab.path };
  const at = indexOfPath(tabs, active);
  if (at < 0 || inNewTab) return { tabs: insertBeside(tabs, active, tab), active: tab.path };
  return { tabs: tabs.map((entry, index) => (index === at ? tab : entry)), active: tab.path };
};

/** Opens a tab without leaving the current one (⌘/Ctrl-click, middle-click); an open one stays put. */
export const openTabInBackground = (strip: TabStrip, tab: Tab): TabStrip =>
  strip.tabs.some((entry) => entry.path === tab.path) ? strip : { tabs: insertBeside(strip.tabs, strip.active, tab), active: strip.active };

/**
 * Closes a tab. Closing the active one moves to its right neighbour, else its left; closing
 * the last tab leaves nothing to show, so the middle closes (`next` null).
 */
export const closeTab = (
  tabs: readonly Tab[],
  path: string,
  activePath: string | null,
): { readonly tabs: readonly Tab[]; readonly next: string | null } => {
  const index = tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return { tabs, next: null };
  const rest = tabs.filter((_, at) => at !== index);
  if (path !== activePath) return { tabs: rest, next: null };
  const neighbour = rest[index] ?? rest[index - 1];
  return { tabs: rest, next: neighbour?.path ?? null };
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

/** Back and Forward in the tab bar: the places visited in this window, in order. */
export type History = {
  readonly back: readonly string[];
  readonly current: string;
  readonly forward: readonly string[];
};

export const visit = (history: History, path: string): History =>
  path === history.current ? history : { back: [...history.back, history.current], current: path, forward: [] };

export const goBack = (history: History): History | null => {
  const previous = history.back.at(-1);
  return previous === undefined
    ? null
    : { back: history.back.slice(0, -1), current: previous, forward: [history.current, ...history.forward] };
};

export const goForward = (history: History): History | null => {
  const [next, ...rest] = history.forward;
  return next === undefined ? null : { back: [...history.back, history.current], current: next, forward: rest };
};

/** Stored tabs, as written by the tab bar: anything that is not an imago path is dropped. */
export const parseTabs = (stored: string | null): readonly Tab[] => {
  if (stored === null) return [];
  try {
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
      const path = typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined;
      return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? [{ path }] : [];
    });
  } catch {
    return [];
  }
};

/** imago's own storage key per drive, never classic's `tabs-storage` (DEC-C6). */
export const tabsStorageKey = (driveKey: string): string => `imago:tabs:${driveKey}`;

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
