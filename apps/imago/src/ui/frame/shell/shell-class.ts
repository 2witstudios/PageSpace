import type { PaneLayout } from '../stage/stage';

/**
 * Each stage's widths sum to the frame (frame.css), so every pane moves
 * between stages by one width transition on the same curve.
 */
const listWidths: Readonly<Record<PaneLayout['list'], string>> = {
  closed: 'w-0',
  list: 'w-list-pane',
  tree: 'w-tree-pane',
};

export const listSlotClass = (layout: PaneLayout): string => listWidths[layout.list];

export const objectSlotClass = (layout: PaneLayout): string => {
  if (!layout.object) return 'w-0';
  return layout.list === 'tree' ? 'w-stage-object-tree' : 'w-stage-object';
};

export const chatSlotClass = (layout: PaneLayout): string => {
  if (layout.object) return 'w-chat-pane';
  return layout.list === 'list' ? 'w-stage-chat-list' : 'w-stage-chat';
};

/** The frame fills the viewport: the panes scroll, the page never does. */
export const shellClass = 'flex h-screen w-full overflow-hidden';

/**
 * One rail width for every stage (myimago ADR 0029 decision 4). Its glass
 * makes it a stacking context, so it takes its own layer above the panes:
 * otherwise the later list pane paints over its tooltips and ⋯ menu.
 */
export const railClass =
  'relative z-rail flex h-full w-rail-width flex-none flex-col items-center gap-rail-gap border-r border-hairline py-rail-y surface-glass';

/** The object and chat columns inside their panes. */
export const columnClass = 'flex h-full w-full min-w-0 flex-col';
