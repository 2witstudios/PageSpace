import { cn } from '../../cn';

/* A date picker inside a w-popover glass: quick picks, the month, then
   Clear and Done. Seven 1fr columns fill the popover's width. */
export const datePickerClass = 'flex flex-col gap-2 p-1';

/* One pick a row: a name and its weekday side by side never fit two abreast in the popover. */
export const quickPicksClass = 'flex flex-col';

export const quickPickClass =
  'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs whitespace-nowrap text-ink transition-colors duration-120 ease-standard hover:bg-surface-overlay disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

export const quickPickDayClass = 'text-ink-faint';

export const calendarHeadClass = 'flex items-center justify-between gap-2 pl-1';

export const calendarTitleClass = 'text-sm font-semibold text-ink';

export const calendarNavClass =
  'flex size-6 items-center justify-center rounded-md text-ink-muted transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink';

export const calendarGridClass = 'flex flex-col';

export const calendarRowClass = 'grid grid-cols-7';

export const calendarWeekdayClass = 'flex h-6 items-center justify-center text-2xs text-ink-faint';

export type CalendarDayState = {
  readonly selected: boolean;
  readonly today: boolean;
  /** From the month before or after the one shown. */
  readonly outside: boolean;
};

/** A day: filled in the accent when chosen, accent ink for today, faint outside the month. */
export const calendarDayClass = ({ selected, today, outside }: CalendarDayState): string =>
  cn(
    'flex h-8 w-full items-center justify-center rounded-md text-xs tabular-nums transition-colors duration-120 ease-standard disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent',
    selected
      ? 'bg-accent font-semibold text-accent-ink'
      : cn('hover:bg-surface-overlay', today ? 'font-semibold text-accent' : outside ? 'text-ink-faint' : 'text-ink'),
  );

export const datePickerFootClass = 'flex items-center justify-between gap-2 border-t border-hairline px-1 pt-2';

export const datePickerClearClass = 'text-xs text-ink-muted transition-colors duration-120 ease-standard hover:text-ink';

export const datePickerDoneClass =
  'ml-auto rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-ink transition-colors duration-120 ease-standard hover:bg-accent-strong';
