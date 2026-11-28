import type { Columns } from '../stage/columns';
import type { ListPane } from '../stage/stage';
import { floatsOver, type ViewportTier } from '../viewport/viewport-tier';

/**
 * Each slot's width (IMC-1.6): the left pane 300 on a stage-2 index and 260 beside an object,
 * Imago 360 while docked, and whichever middle area is showing (the page, Imago on the ground
 * or the empty middle) takes the rest. A closed slot is 0 wide, so it slides rather than jumps.
 */
export const listSlotClass = (columns: Columns, list: ListPane, tier: ViewportTier = 'desktop'): string => {
  if (list === 'closed') return 'w-0';
  // Below 1024px the pane is a left sheet over the columns, not one of them.
  if (columns.paneSheet) return columns.pane ? `${sheetClass} left-0 w-pane-overlay` : 'absolute inset-y-0 left-0 w-0';
  if (!columns.pane) return 'w-0';
  // 1024 to 1279: the pane stays docked, at 236px.
  return tier === 'overlay' ? 'w-pane-overlay' : list === 'list' ? 'w-list-pane' : 'w-tree-pane';
};

/** A sheet over the columns row (the pane below 1024px, Imago below 1280px). */
const sheetClass = 'absolute inset-y-0 z-popover shadow-sheet';

export const objectSlotClass = (columns: Columns): string => (columns.page ? 'grow' : 'w-0');

/** Below 1280px Imago floats, so closed it collapses to 0 on the right edge rather than in the row. */
export const chatSlotClass = (columns: Columns, tier: ViewportTier = 'desktop'): string =>
  columns.imago === 'docked'
    ? 'w-chat-pane'
    : columns.imago === 'overlay'
      ? `${sheetClass} right-0 w-chat-overlay`
      : columns.imago === 'ground'
        ? 'grow'
        : floatsOver(tier)
          ? 'absolute inset-y-0 right-0 w-0'
          : 'w-0';

export const emptySlotClass = (columns: Columns): string => (columns.imago === 'none' ? 'grow' : 'w-0');

/** The light scrim behind a sheet; pressing it dismisses the sheet. */
export const scrimClass = 'absolute inset-0 z-rail cursor-default border-0 bg-fill p-0';

/** The frame fills the viewport on the spine's blue: the panes scroll, the page never does. */
export const shellClass = 'flex h-dvh w-full overflow-hidden bg-spine';

/**
 * The stage sheet beside the spine (SPEC v3): rounded 22px at its top-left, set 8px down, the
 * tab bar on top and the columns below.
 */
export const stageSheetClass =
  'mt-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-stage bg-background shadow-sheet';

/** The row of columns under the tab bar. */
export const columnsRowClass = 'relative flex min-h-0 flex-1';

/**
 * The spine: one 72px blue column for every stage (SPEC v3). It takes its own
 * layer above the panes, so its tooltips and menus paint over an open pane.
 */
export const railClass =
  'relative z-rail flex h-full w-rail-width flex-none flex-col items-center gap-rail-gap bg-spine py-rail-y text-spine-ink';

/** The object and chat columns inside their panes. */
export const columnClass = 'flex h-full w-full min-w-0 flex-col';
