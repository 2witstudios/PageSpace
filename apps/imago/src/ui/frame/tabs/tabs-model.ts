import type { Stage } from '../stage/stage';

/**
 * One open tab (SPEC v3.3 tab bar): whatever fills the middle, keyed by its imago path. Its
 * title and type icon are read from the page API when it renders, never stored (DEC-C6).
 */
export type Tab = { readonly path: string };

/** The middle's object is a tab; the chat, a section index or the empty middle are not. */
export const tabFor = (stage: Stage, pathname: string): Tab | null =>
  stage.object === null ? null : { path: pathname };

/** A new tab goes after the last one (CANON "Open tabs"); an open one stays put. */
export const openTab = (tabs: readonly Tab[], tab: Tab): readonly Tab[] =>
  tabs.some((entry) => entry.path === tab.path) ? tabs : [...tabs, tab];

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
