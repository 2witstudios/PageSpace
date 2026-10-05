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
  `flex h-full flex-none flex-col border-r border-hairline surface-glass ${widths[variant]}`;

export const listBodyClass = 'flex flex-1 flex-col gap-4 overflow-y-auto p-3';
