import { cn } from '../../cn';

export const taskListViewClass = 'flex h-full min-h-0 flex-col';

/* A thin rule between the strip's groups, as the page strips draw it. */
export const taskStripDividerClass = 'mx-1 h-4 w-px flex-none bg-hairline';


/** + Task: the strip's one filled control. */
export const taskStripPrimaryClass =
  'inline-flex h-head-control flex-none cursor-pointer items-center gap-1 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-strong';

/* The search field's width in the strip; it gives way first when the strip is short, and
   clips rather than spilling over the controls after it. */
export const taskStripSearchClass = 'flex w-popover min-w-0 flex-initial overflow-hidden';

/* The strip's controls in one row that scrolls sideways when the middle is narrow (Imago
   docked beside it, or a phone), so none is ever drawn over another or cut off. */
export const taskStripRowClass = 'flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto';

/**
 * The body under the strip. The outline views read in one centred column;
 * the Board and the Roadmap take the whole width and scroll themselves.
 */
export const taskListBodyClass = (wide: boolean): string =>
  wide ? 'flex min-h-0 flex-1 flex-col px-4 py-3' : 'min-h-0 flex-1 overflow-y-auto px-6 py-5';

export const taskListColumnClass = 'mx-auto flex w-full max-w-imago-ground flex-col gap-4';

export const taskListMessageClass = 'text-sm text-ink-muted';

/* The list's description, folded to one line until opened. */
export const taskListDescriptionClass = 'flex flex-col gap-2 rounded-lg border border-hairline bg-surface px-3 py-2';

export const taskListDescriptionToggleClass = (open: boolean): string =>
  cn(
    'flex cursor-pointer items-center gap-2 text-left text-xs font-semibold text-ink-muted hover:text-ink',
    open && 'text-ink',
  );

/** What a filter that hides every task says. */
export const taskListEmptyClass = 'px-2 py-6 text-center text-sm text-ink-faint';
