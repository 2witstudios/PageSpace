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

/** A page the search answered with, as the palette lists and opens it. */
export type PaletteResult = {
  readonly id: string;
  readonly title: string;
  readonly pageType: PageTypeValue;
  /** The drive the page opens in: its own, or for a guest agent the drive it is a member of. */
  readonly driveId: string;
};

export type SearchScope = {
  readonly query: string;
  /** The drive the palette searches; null on a stage with no drive and no Home drive yet. */
  readonly driveId: string | null;
  /** "Include all workspaces": every drive the viewer can reach. */
  readonly allDrives: boolean;
};

/**
 * The search path for a query, or null when there is nothing to ask: a blank
 * query (the route would answer with recent pages, not matches), or no drive
 * to search in.
 */
export const searchPath = ({ query, driveId, allDrives }: SearchScope): string | null => {
  const q = query.trim();
  if (q === '') return null;
  if (allDrives) return `${PALETTE_SEARCH}?${new URLSearchParams({ q, types: 'page', crossDrive: 'true' })}`;
  if (driveId === null) return null;
  return `${PALETTE_SEARCH}?${new URLSearchParams({ q, types: 'page', driveId })}`;
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
 * The pages in a search answer, in the server's order. People (which have no
 * imago route), anything malformed and an error body list nothing.
 */
export const resultsFrom = (body: unknown): readonly PaletteResult[] =>
  Array.isArray(body) ? body.map(resultOf).filter((result): result is PaletteResult => result !== null) : [];
