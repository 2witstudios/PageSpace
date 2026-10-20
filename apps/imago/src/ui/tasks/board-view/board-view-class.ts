import { cn } from '../../cn';
import type { Priority, StatusGroup } from '../task-model/task';
import type { DueTone } from '../task-tree/task-tree';
import type { WipTone } from './board';

/* The Board: its lanes control over the columns. */
export const boardClass = 'flex min-h-0 flex-1 flex-col gap-3';

export const boardToolbarClass = 'flex items-center gap-2 text-xs text-ink-muted';

/* The columns (myimago board-view): fixed-width, side by side, the row
   scrolling across when they outgrow the object and settling on a
   column's edge after a swipe, so a phone shows one column at a time. */
export const boardColumnsClass = 'flex min-h-0 flex-1 snap-x snap-proximity items-start gap-3 overflow-x-auto pb-2';

/* With lanes, the column heads, then each lane's row of cells, stacked and
   scrolling across together. */
export const boardLanesClass = 'flex min-h-0 flex-1 flex-col gap-3 overflow-x-auto pb-2';

export const boardLaneRowClass = 'flex items-start gap-3';

export const boardLaneClass = 'flex flex-col gap-2';

export const boardLaneHeadClass = 'flex items-center gap-2 px-1 text-xs font-semibold text-ink-muted';

/** The drop target is outlined in the accent; at rest a column sits sunk in the object. */
const well = (target: boolean): string =>
  target ? 'border-dashed border-accent bg-accent-soft' : 'border-transparent bg-surface-sunken';

/** A status's column, or one lane's cell of it. */
export const boardColumnClass = (target: boolean): string =>
  cn('flex w-board-column flex-none snap-start flex-col gap-2 rounded-lg border p-2', well(target));

/** A column folded to a rail: its name on end, still a place to drop. */
export const boardRailClass = (target: boolean): string =>
  cn('flex w-board-rail flex-none flex-col items-center gap-2 rounded-lg border py-2', well(target));

export const boardRailButtonClass =
  'flex min-h-board-rail-label w-full cursor-pointer flex-col items-center gap-2 rounded-md py-1 text-xs font-semibold text-ink transition-colors duration-120 ease-standard hover:bg-surface-overlay';

/* The name stands centred in the rail; flex-none keeps it from shrinking to
   the rail's width before it is turned. */
export const boardRailNameClass = 'flex flex-1 items-center justify-center';

export const boardRailTextClass = 'max-w-board-rail-label flex-none rotate-90 truncate';

/** A column's head over its cards: the heading, then its own controls. */
export const boardColumnHeadClass = 'flex items-center gap-1 px-1';

/* In a lanes board the heads sit in their own row, as wide as the cells. */
export const boardHeadCellClass = 'w-board-column flex-none';

export const boardRailHeadClass = 'w-board-rail flex-none';

export const boardColumnTitleClass = 'flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-ink';

const countTones: Readonly<Record<WipTone, string>> = {
  under: 'border-hairline font-normal text-ink-muted',
  at: 'border-status-warning font-medium text-status-warning-ink',
  over: 'border-status-danger bg-live-soft font-medium text-status-danger',
};

/** The card count; a column with a limit shows it as a chip, warning at the limit and red past it. */
export const boardCountClass = (tone: WipTone | null): string =>
  tone === null
    ? 'font-normal text-ink-faint tabular-nums'
    : cn('rounded-sm border px-1 tabular-nums', countTones[tone]);

/* The head's small square controls: "+" and the column's menu. */
export const boardHeadButtonClass =
  'inline-flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink';

const dotTone: Readonly<Record<StatusGroup, string>> = {
  todo: 'bg-ink-faint',
  in_progress: 'bg-accent',
  done: 'bg-online',
};

/** The status's group, as a dot before its name. */
export const boardDotClass = (group: StatusGroup): string =>
  cn('size-live-dot flex-none rounded-round', dotTone[group]);

export const boardCardsClass = 'flex flex-col gap-2';

/**
 * A card, raised on its sunk column; a done one sits back. The one being
 * dragged leaves a dashed slot where it will land, its preview under the
 * pointer.
 */
export const boardCardClass = ({ dragging, done }: { readonly dragging: boolean; readonly done: boolean }): string =>
  cn(
    'flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-120 ease-standard',
    dragging
      ? 'border-dashed border-accent bg-accent-soft *:invisible'
      : 'border-hairline bg-surface-raised shadow-ambient hover:border-border',
    done && !dragging && 'opacity-75',
  );

/** The card under the pointer while it is dragged. */
export const boardPreviewClass =
  'flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3 shadow-2';

export const boardCardRowClass = 'flex min-w-0 items-center gap-2';

/* The handle takes the checkbox's square, as the tree's caret does. */
export const boardHandleClass =
  'inline-flex size-checkbox flex-none cursor-grab items-center justify-center rounded-sm text-ink-faint hover:text-ink';

export const boardEmptyClass = 'px-1 text-xs text-ink-faint';

/** Where a card dragged in from elsewhere will land. */
export const boardInsertClass = 'h-board-insert rounded-round bg-accent';

/** Holds a menu's trigger and anchors the menu. */
export const boardMoveClass = 'relative flex-none';

export const boardMoveTriggerClass =
  'inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink';

/* The rail overflow's glass menu (rail-button-class.ts), opening under its trigger. */
export const boardMenuClass =
  'absolute right-0 z-popover mt-1 flex w-menu flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised';

export const boardMenuItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-ink hover:bg-surface-overlay focus-visible:bg-surface-overlay';

/** Delete, and its Yes: the one write a menu cannot take back. */
export const boardMenuDangerClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-status-danger hover:bg-live-soft focus-visible:bg-live-soft';

export const boardMenuNoteClass = 'px-2 py-row-y text-xs text-ink-muted';

/* The limit field inside the column's menu. */
export const boardMenuFieldClass =
  'w-full rounded-md border border-border-strong bg-background px-2 py-row-y text-sm text-ink outline-none placeholder:text-ink-faint';

/* A card's facts under its title (myimago task-meta): flags, progress, the
   due date, then the faces at the end. */
export const boardCardMetaClass = 'flex flex-wrap items-center gap-2';

export const boardBlockedClass = 'flex-none text-2xs font-medium text-live';

/** A raised priority reads in the live red; a lowered one stays faint. */
export const boardPriorityClass = (priority: Exclude<Priority, 'medium'>): string =>
  cn('flex flex-none items-center gap-1 text-2xs', priority === 'high' ? 'text-live' : 'text-ink-faint');

const dueTones: Readonly<Record<DueTone, string>> = {
  overdue: 'font-medium text-live',
  soon: 'font-medium text-ink',
  later: 'text-ink-faint',
};

/** A due date, graded: red while overdue, full ink when soon. */
export const boardDueClass = (tone: DueTone): string => cn('flex-none text-2xs tabular-nums', dueTones[tone]);

export const boardAssigneesClass = 'ml-auto';

/** An open card's subtasks, ruled off under its facts. */
export const boardSubtasksClass = 'border-t border-hairline pt-2';
