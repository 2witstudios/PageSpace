import { cn } from '../../cn';

/** The parent folder over the page title, in the phone page head. */
export const phoneCrumbClass = 'flex min-w-0 flex-1 flex-col pl-1 leading-tight';

export const phoneParentClass = 'truncate text-xs text-ink-muted';

export const phoneTitleClass = 'truncate text-base font-semibold text-ink';

/** Presence beside the count: the avatars the page already shows. */
export const phonePresenceClass = 'mr-1 flex flex-none items-center';

/** The "{n} open pages" count: a 22px outlined chip inside a 40px control. */
export const phoneCountChipClass =
  'grid h-6 min-w-6 place-items-center rounded-md border-2 border-current px-1 font-mono text-xs font-bold';

/** The page body of a phone: the toolbar scrolls sideways and its tools are at least 38px. */
export const phoneDocBodyClass = 'min-h-0 flex-1 phone-doc-body';

/** The scrim behind the open-pages sheet. */
export const phoneSheetScrimClass = 'absolute inset-0 z-popover cursor-default border-0 bg-fill p-0';

/** The open-pages bottom sheet. */
export const phoneSheetClass =
  'absolute right-0 bottom-0 left-0 z-popover rounded-t-xl bg-background px-3 pt-2 pb-6 shadow-sheet';

export const phoneSheetGripClass = 'mx-auto mb-2 block h-1 w-avatar-md rounded-sm bg-border';

export const phoneSheetHeadClass = 'flex items-center px-2 pb-2';

export const phoneSheetTitleClass = 'flex-1 text-base font-semibold';

export const phoneSheetCloseAllClass =
  'h-8 cursor-pointer rounded-lg border-0 bg-transparent px-3 text-sm text-accent-deep';

export const phoneSheetRowClass = (current: boolean): string =>
  cn(
    'flex h-phone-sheet-row items-center gap-1 rounded-xl pr-1 pl-3 text-base',
    current ? 'bg-accent-soft font-semibold text-accent-deep' : 'text-ink',
  );

export const phoneSheetLinkClass =
  'flex h-full min-w-0 flex-1 items-center gap-2 text-inherit no-underline hover:no-underline';

export const phoneSheetRowCloseClass =
  'grid size-avatar-md flex-none cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-ink-muted hover:bg-fill';

export const phoneSheetEmptyClass = 'm-2 text-sm text-ink-muted';
