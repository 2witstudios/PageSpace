import { cn } from '../../cn';

/* A sidebar row (myimago tree-row-class.ts): quiet, muted ink that comes up
   to full on hover; the open list takes the soft accent tint at full ink. */
const base =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline';

/** A task list's row in the Tasks list, the open one tinted. */
export const taskListRowClass = (selected: boolean): string =>
  cn(base, selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink');

export const taskListRowTitleClass = 'min-w-0 flex-1 truncate';

export const taskListEmptyClass = 'flex-none text-2xs text-ink-faint';

export const tasksPaneMessageClass = 'px-2 text-sm text-ink-muted';
