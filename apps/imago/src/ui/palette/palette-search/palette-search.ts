// What the ⌘K palette asks apps/web, and what it keeps of the answer.
//
// The request and response are apps/web's GET /api/mentions/search
// (apps/web/src/app/api/mentions/search/route.ts), read from the handler: it
// is the search that scopes to one drive (`driveId`, after checking the
// viewer can reach it) or to every drive the viewer can reach
// (`crossDrive=true`), and it drops every page the viewer cannot view
// (getUserAccessLevel) before answering. Classic's /api/search cannot scope to
// a drive and only covers drives the viewer owns. The palette shows exactly
// the pages the server listed, in its order: nothing here adds a result, it
// only leaves out what imago cannot open.

import { PageType, type PageTypeValue } from '@pagespace/lib/client-safe';

export const PALETTE_SEARCH = '/api/mentions/search';

/** The mention types the palette lists: pages (its Pages group) and people (its Users group). */
export const PALETTE_TYPES = 'page,user';

/** A page the search answered with, as the palette lists and opens it. */
export type PaletteResult = {
  readonly id: string;
  readonly title: string;
  readonly pageType: PageTypeValue;
  /** The drive the page opens in: its own, or for a guest agent the drive it is a member of. */
  readonly driveId: string;
};

/** A person the search answered with. Only the name is kept: the route sends no email or avatar. */
export type PaletteUser = {
  readonly id: string;
  readonly name: string;
};

export type SearchScope = {
  readonly query: string;
  /** The drive the palette searches; null on a stage with no drive and no Home drive yet. */
  readonly driveId: string | null;
  /** "All workspaces": every drive the viewer can reach. */
  readonly allDrives: boolean;
};

/** With nothing typed the palette lists recent pages; people are only found by name. */
export const RECENT_TYPES = 'page';

/**
 * The search path for a query, or null when there is nowhere to search: no
 * drive and not every drive. A blank query asks for pages alone, which the
 * route answers with the scope's recently updated pages.
 */
export const searchPath = ({ query, driveId, allDrives }: SearchScope): string | null => {
  const q = query.trim();
  const ask: Record<string, string> = q === '' ? { types: RECENT_TYPES } : { q, types: PALETTE_TYPES };
  if (allDrives) return `${PALETTE_SEARCH}?${new URLSearchParams({ ...ask, crossDrive: 'true' })}`;
  if (driveId === null) return null;
  return `${PALETTE_SEARCH}?${new URLSearchParams({ ...ask, driveId })}`;
};

const pageTypes: readonly string[] = Object.values(PageType);

const isPageType = (value: unknown): value is PageTypeValue => typeof value === 'string' && pageTypes.includes(value);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

const resultOf = (entry: unknown): PaletteResult | null => {
  if (!isRecord(entry) || entry.type !== 'page' || !isRecord(entry.data)) return null;
  const { id, label } = entry;
  const { pageType, driveId } = entry.data;
  if (typeof id !== 'string' || id === '' || typeof driveId !== 'string' || driveId === '') return null;
  if (!isPageType(pageType)) return null;
  const title = typeof label === 'string' && label.trim() !== '' ? label : 'Untitled';
  return { id, title, pageType, driveId };
};

/**
 * The pages in a search answer, in the server's order. Anything malformed and
 * an error body list nothing.
 */
export const resultsFrom = (body: unknown): readonly PaletteResult[] =>
  Array.isArray(body) ? body.map(resultOf).filter((result): result is PaletteResult => result !== null) : [];

const userOf = (entry: unknown): PaletteUser | null => {
  if (!isRecord(entry) || entry.type !== 'user') return null;
  const { id, label } = entry;
  if (typeof id !== 'string' || id === '') return null;
  return { id, name: typeof label === 'string' && label.trim() !== '' ? label : 'Unnamed User' };
};

/** The people in a search answer, in the server's order; anything else lists nothing. */
export const usersFrom = (body: unknown): readonly PaletteUser[] =>
  Array.isArray(body) ? body.map(userOf).filter((user): user is PaletteUser => user !== null) : [];
