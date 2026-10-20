import { cn } from '../../cn';
import type { Priority } from '../task-model/task';
import type { DueTone } from '../task-tree/task-tree';

/* A row's outer item: the drag library moves it, and a row being dragged
   leaves a faint slot where it will land. */
export const treeRowShellClass = 'relative data-dragging:opacity-40';

/* The grip sits in the gutter left of the caret and only shows on hover or
   focus, so the outline reads as text until a row is reached for. */
export const treeGripClass =
  'inline-flex size-checkbox flex-none cursor-grab items-center justify-center rounded-sm text-ink-faint opacity-0 group-hover/row:opacity-100 hover:text-ink focus-visible:opacity-100';

/** A row's facts, pushed to its end, in the order the canvases draw them. */
export const treeMetaClass = 'ml-auto flex flex-none items-center gap-3';

/** A raised priority reads in the live red; a lowered one stays faint. */
export const treePriorityClass = (priority: Exclude<Priority, 'medium'>): string =>
  cn('flex flex-none items-center text-2xs', priority === 'high' ? 'text-live' : 'text-ink-faint');

const dueTones: Readonly<Record<DueTone, string>> = {
  overdue: 'font-semibold text-status-warning-ink',
  soon: 'font-medium text-ink',
  later: 'text-ink-faint',
};

/** A due date at the row's end: amber while late, full ink when near. */
export const treeDueClass = (tone: DueTone): string => cn('w-16 flex-none text-right text-xs tabular-nums', dueTones[tone]);

/* The ⋯ trigger: quiet until its row is hovered or it holds focus. */
export const treeMenuTriggerClass =
  'inline-flex size-head-control flex-none cursor-pointer items-center justify-center rounded-md text-ink-muted opacity-0 group-hover/row:opacity-100 hover:bg-surface-overlay hover:text-ink focus-visible:opacity-100 aria-expanded:opacity-100';

/* The rail overflow's glass menu (rail-button-class.ts). */
export const treeMenuClass =
  'z-popover flex w-menu flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised';

export const treeMenuItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-ink outline-none data-highlighted:bg-surface-overlay data-disabled:cursor-default data-disabled:text-ink-faint';

/** Delete, and its confirmation, read in the live red. */
export const treeMenuDangerClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-live outline-none data-highlighted:bg-live-soft';

export const treeMenuSeparatorClass = 'my-1 h-px bg-hairline';
