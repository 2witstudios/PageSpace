import type { ListPane } from '../stage/stage';

const widths: Readonly<Record<Exclude<ListPane, 'closed'>, string>> = {
  list: 'w-list-pane',
  tree: 'w-tree-pane',
};

/**
 * The list holds its own width inside the pane, so while the pane's width
 * slides the rows are clipped rather than reflowed.
 */
export const listPaneClass = (variant: Exclude<ListPane, 'closed'>): string =>
  `flex h-full flex-none flex-col border-r border-hairline bg-background ${widths[variant]}`;

/** The pane's body scrolls under its head (SPEC v2: padding 10px 8px). */
export const listBodyClass = 'flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 py-2';
