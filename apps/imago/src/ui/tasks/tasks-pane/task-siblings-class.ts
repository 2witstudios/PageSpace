import { cn } from '../../cn';

/* The pane a task opens beside: its list's tasks grouped by status. */

export const taskSiblingsBackClass =
  'mb-2 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm text-ink-muted no-underline transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink hover:no-underline';

export const taskSiblingsGroupClass = 'px-2 pt-3 pb-1 text-2xs font-medium uppercase text-ink-faint';

export const taskSiblingsRowClass = (current: boolean): string =>
  cn(
    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline',
    current ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink',
  );

/** The status dot: coloured by the status's group, so done, under way and not started read apart. */
export const taskSiblingsDotClass = (tone: string): string => cn('size-2 flex-none rounded-full bg-current', tone);

export const taskSiblingsTitleClass = 'min-w-0 flex-1 truncate';

export const taskSiblingsDueClass = 'flex-none text-2xs text-ink-faint';
