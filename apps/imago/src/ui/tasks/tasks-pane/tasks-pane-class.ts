import { cn } from '../../cn';

/* A sidebar row (myimago tree-row-class.ts): quiet, muted ink that comes up
   to full on hover; the open row takes the soft accent tint at full ink. */
const rowBase =
  'flex w-full cursor-pointer text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline';

const rowTone = (selected: boolean): string =>
  selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink';

/** A task list's row: its title and count on one line, its bar and meta under it. */
export const taskListRowClass = (selected: boolean): string =>
  cn(rowBase, 'flex-col gap-1 rounded-lg px-2 py-2', rowTone(selected));

/** The first line of a list row: the title, then its done/total count. */
export const taskListHeadClass = 'flex min-w-0 items-center gap-2';

export const taskListRowTitleClass = 'min-w-0 flex-1 truncate';

export const taskListCountClass = 'flex-none font-mono text-2xs tabular-nums text-ink-faint';

/** A list with no tasks yet, in place of its count. */
export const taskListEmptyClass = 'flex-none text-2xs text-ink-faint';

/** The list's progress bar: the theme's native progress meter, full width. */
export const taskListBarClass = 'progress-meter w-full';

/** A list's meta line, under its bar: overdue, due soon, agents. */
export const taskListMetaClass = 'truncate text-2xs text-ink-faint';

/** A smart view's row: a colour dot, its name, and its count. */
export const taskViewClass = (selected: boolean): string =>
  cn(
    rowBase,
    'h-8 items-center gap-2 rounded-lg px-2',
    selected ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink',
  );

export const taskViewDotClass = (dotClass: string): string => cn('size-2 flex-none rounded-sm', dotClass);

/** A view's count; an overdue count that is not zero reads as a warning. */
export const taskViewCountClass = (warn: boolean): string =>
  cn('flex-none font-mono text-2xs tabular-nums', warn ? 'font-medium text-status-danger' : 'text-ink-faint');

/** A group's small caps label: Views, Task lists. */
export const tasksPaneLabelClass = 'px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-wide text-ink-faint';

export const tasksPaneMessageClass = 'px-2 text-sm text-ink-muted';

/** The pane's New list button: the primary fill the Button primitive uses. */
export const newListClass =
  'flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink transition-colors duration-120 ease-standard hover:bg-accent-strong';
