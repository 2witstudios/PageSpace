import type { ListPane } from '../stage/stage';

/**
 * The shell Pane owns column geometry for docked lists, trees and overlay sheets.
 * Its content fills that allocation so headers, filters and rows follow a resize.
 */
export const listPaneClass = (_variant: Exclude<ListPane, 'closed'>): string =>
  'flex h-full w-full min-w-0 flex-1 flex-col border-r border-hairline bg-background phone:border-r-0';

/** The pane's body scrolls under its head (SPEC v2: padding 10px 8px). */
export const listBodyClass = 'flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 py-2';
