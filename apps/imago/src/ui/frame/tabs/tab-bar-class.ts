import { cn } from '../../cn';

/** The 40px open-pages strip across the top of the stage sheet (SPEC v3.3). */
export const tabBarClass =
  'flex h-tab-bar flex-none items-stretch border-b border-hairline bg-tab-bar px-2 pt-tab-bar-top';

/** Back, Forward and New tab: 28px ghost controls. */
export const tabControlClass =
  'flex size-head-control flex-none cursor-pointer items-center justify-center self-center rounded-md border-0 bg-transparent text-ink-muted hover:bg-fill disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent';

/** One tab: up to 180px, never under 76px; the active one takes the sheet's colour and merges down. */
export const tabClass = (selected: boolean): string =>
  cn(
    'group relative flex min-w-tab-min shrink basis-tab-max items-center gap-1 rounded-t-lg pr-1 pl-3 text-sm',
    selected ? '-mb-px bg-background font-semibold text-ink' : 'text-ink-muted hover:bg-fill',
  );

export const tabLinkClass =
  'flex h-full min-w-0 flex-1 items-center gap-2 text-inherit no-underline hover:no-underline';

export const tabTitleClass = 'min-w-0 truncate';

/** A tab's ×, shown on the active tab and on hover or focus. */
export const tabCloseClass = (selected: boolean): string =>
  cn(
    'flex size-tab-close flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-ink-muted hover:bg-fill focus-visible:opacity-100',
    selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
  );
