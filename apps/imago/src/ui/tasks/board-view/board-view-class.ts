import { cn } from '../../cn';
import type { StatusGroup } from '../task-model/task';

/* The Board (myimago board-view): fixed-width columns side by side, the
   row scrolling across when they outgrow the object. */
export const boardClass = 'flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-2';

/** A status's column; the one a card is dragged over is outlined in the accent. */
export const boardColumnClass = (target: boolean): string =>
  cn(
    'flex w-board-column flex-none flex-col gap-2 rounded-lg border p-2',
    target ? 'border-dashed border-accent bg-accent-soft' : 'border-transparent bg-surface-overlay',
  );

export const boardColumnHeadClass = 'flex items-center gap-2 px-1 text-xs font-semibold text-ink';

export const boardCountClass = 'font-normal text-ink-faint tabular-nums';

const dotTone: Readonly<Record<StatusGroup, string>> = {
  todo: 'bg-ink-faint',
  in_progress: 'bg-accent',
  done: 'bg-online',
};

/** The status's group, as a dot before its name. */
export const boardDotClass = (group: StatusGroup): string =>
  cn('size-live-dot flex-none rounded-round', dotTone[group]);

/** The column's count against its WIP limit; the live tone once over it. */
export const boardWipClass = (over: boolean): string =>
  cn(
    'ml-auto rounded-sm px-badge-x text-2xs font-medium tabular-nums',
    over ? 'bg-live-soft text-live' : 'bg-background text-ink-muted',
  );

export const boardCardsClass = 'flex flex-col gap-2';

/** A card, raised on its column; faded while it is the one being dragged. */
export const boardCardClass = (dragging: boolean): string =>
  cn(
    'flex flex-col gap-2 rounded-lg border border-hairline bg-background p-3 shadow-ambient',
    dragging && 'opacity-60',
  );

export const boardCardRowClass = 'flex min-w-0 items-center gap-2';

/* The handle takes the checkbox's square, as the tree's caret does. */
export const boardHandleClass =
  'inline-flex size-checkbox flex-none cursor-grab items-center justify-center rounded-sm text-ink-faint hover:text-ink';

export const boardEmptyClass = 'px-1 text-xs text-ink-faint';

/** Holds Move to… and anchors its menu. */
export const boardMoveClass = 'relative flex-none';

export const boardMoveTriggerClass =
  'rounded-md px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-overlay hover:text-ink';

/* The rail overflow's glass menu (rail-button-class.ts), opening under its trigger. */
export const boardMenuClass =
  'absolute right-0 z-popover mt-1 flex w-menu flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised';

export const boardMenuItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-ink hover:bg-surface-overlay focus-visible:bg-surface-overlay';
